/**
 * Lint Guard — PI Extension Adapter
 *
 * Thin adapter wiring core lint logic into PI's extension system.
 * All lint logic in lint-guard-core.ts (no SDK imports).
 *
 * Two modes:
 *   1. Auto-lint: hooks into tool_result after edit/write
 *   2. Manual lint: registers `lint` tool for explicit calls
 */

import { existsSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { getAgentDir, createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildLintTool,
	formatResult,
	type LintTool,
	type LintResult,
} from "./lint-guard-core";

const local = createLocalBashOperations();

/** Build shell environment with SDK bin dir prepended to PATH */
function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = join(getAgentDir(), "bin");
	const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);
	return { ...process.env, [pathKey]: updatedPath };
}

// ── runTool ───────────────────────────────────────────────────────────
// Runs the detected tool via local.exec() and returns a LintResult.
// Timeouts after 10s, caps error output at 2000 chars.

async function runTool(tool: LintTool, filePath: string): Promise<LintResult> {
	try {
		let output = '';
		const { exitCode } = await local.exec(
			`${tool.tool} ${tool.args.join(' ')}`,
			tool.cwd || process.cwd(),
			{
				onData: (data: string | Buffer) => { output += data.toString(); },
				timeout: 10,
				env: getShellEnv(),
			}
		);
		output = output.trim();
		let success = exitCode === 0;

		if (tool.name === "gofmt") {
			success = exitCode === 0 && output.length === 0;
			if (!success && output.length === 0) {
				output = "gofmt would reformat this file";
			}
		}

		return {
			success,
			errors: success ? "" : output.slice(0, 2000),
			tool: tool.name,
			file: filePath,
		};
	} catch (err: any) {
		return {
			success: false,
			errors: `Tool not available: ${err.message}`,
			tool: tool.name,
			file: filePath,
		};
	}
}

// ── emitLintResult ────────────────────────────────────────────────────

function emitLintResult(pi: ExtensionAPI, result: LintResult) {
	const icon = result.success
		? "✓"
		: result.errors.includes("not available")
			? "⚠"
			: "✗";
	const fileName = result.file.split("/").pop() || result.file;
	const content = result.success
		? `${icon} [${result.tool}] ${fileName}: OK`
		: `${icon} [${result.tool}] ${fileName}:\n  ${result.errors}`;
	const success = result.success;
	const tool = result.tool;

	pi.sendMessage({
		customType: "lint",
		content: [{
			type: "text",
			text: `🛠 Auto-lint (${tool}): ${success ? "✓ passed" : "✗ failed"}${!success ? "\n\nFix the reported issues before proceeding." : ""}\n\n${content}`,
		}],
		display: true,
		details: { tool, success, filesChecked: [result.file], autoLint: true },
	}, { triggerTurn: !success });
}

// ── State ─────────────────────────────────────────────────────────────

let autoLint = true;
let lastEditedFiles: string[] = [];

// ── The Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Auto-lint after edit/write — CACHE SAFE ─────────────────────────

	pi.on("tool_result", async (event, ctx) => {
		if (!autoLint) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const input = event.input as Record<string, unknown>;
		const rawPaths: string[] = [];
		for (const key of ["path", "file_path", "paths", "files"]) {
			const val = input[key];
			if (typeof val === "string") {
				rawPaths.push(val);
			} else if (Array.isArray(val)) {
				for (const v of val) {
					if (typeof v === "string") rawPaths.push(v);
				}
			}
		}
		if (rawPaths.length === 0) return;

		for (const rawPath of rawPaths) {
			const resolvedPath = resolve(ctx.cwd, rawPath);

			// Track for manual lint command, capped at last 50
			lastEditedFiles.push(resolvedPath);
			if (lastEditedFiles.length > 50) {
				lastEditedFiles = lastEditedFiles.slice(-50);
			}

			const tool = buildLintTool(resolvedPath, ctx.cwd);
			if (!tool) continue;

			const result = await runTool(tool, resolvedPath);
			emitLintResult(pi, result);
		}
	});

	// ── Block bash+sed/awk — enforce edit/write for file modifications ─

	const SED_PATTERN =
		/(\bsed\b.*-i\b)|(\bawk\b.*-i\b)|(>\s*\S+\.\w+\s*$)|(\bsed\b.*'[^']*'\s+\S+\.)/;

	pi.on("tool_call", async (event, ctx) => {
		if (
			event.toolName === "bash" &&
			typeof event.input.command === "string" &&
			SED_PATTERN.test(event.input.command)
		) {
			return {
				block: true,
				reason:
					"Use `edit` or `write` tool to modify files, not `bash` with `sed`/awk`. This triggers automatic lint checks.",
			};
		}
	});

	// ── Tool: lint — Manual lint check ─────────────────────────────────

	pi.registerTool({
		name: "lint",
		label: "Lint Check",
		description:
			"Run linter on files. Auto-detects tsc/eslint/node/ruff/go/cargo/mvn/gradle/javac/rubocop/ruby. Use after making changes.",
		parameters: Type.Object({
			files: Type.Optional(
				Type.Array(
					Type.String({ description: "File paths to lint" }),
					{
						description:
							"Specific files. Uses last edited files if empty.",
					},
				),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: "Running linter..." }],
				details: { status: "running" },
			});

			const files =
				params.files && params.files.length > 0
					? params.files
					: lastEditedFiles;
			if (files.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No files to lint. Edit a file first or specify files explicitly.",
						},
					],
					details: { success: true },
					isError: false,
				};
			}

			let allSuccess = true;
			const details: string[] = [];
			for (const file of files) {
				const tool = buildLintTool(file, ctx.cwd);
				if (!tool) {
					details.push(`[${file}] No linter found`);
					continue;
				}
				const result = await runTool(tool, file);
				emitLintResult(pi, result);
				if (!result.success) allSuccess = false;
				details.push(
					`[${result.tool}] ${file}: ${result.success ? "OK" : "FAIL"}`,
				);
			}

			return {
				content: [{ type: "text", text: details.join("\n") }],
				details: { success: allSuccess },
				isError: !allSuccess,
			};
		},
	});

	// ── Tool: typecheck — TypeScript only ──────────────────────────────

	pi.registerTool({
		name: "typecheck",
		label: "Type Check",
		description:
			"Run tsc --noEmit. Use after code changes to verify types.",
		parameters: Type.Object({}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tsconfigPath = join(ctx.cwd, "tsconfig.json");
			if (!existsSync(tsconfigPath)) {
				return {
					content: [{
						type: "text",
						text: "No tsconfig.json in workspace; skipping typecheck.",
					}],
					details: { success: true },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "Running tsc --noEmit..." }],
				details: { status: "running" },
			});

			try {
				let output = '';
				const { exitCode } = await local.exec(
					'npx tsc --noEmit --pretty false',
					ctx.cwd,
					{
						onData: (data: string | Buffer) => { output += data.toString(); },
						timeout: 120,
						env: getShellEnv(),
					}
				);
				const trimmed = output.trim();
				const capped =
					trimmed.length > 5000
						? trimmed.slice(0, 5000) +
							"\n\n[output truncated]"
						: trimmed;
				const success = exitCode === 0;
				return {
					content: [
						{
							type: "text",
							text: `${success ? "✓ Types clean" : "✗ Type errors"}\n\n${capped || "(no output)"}`,
						},
					],
					details: { success, errors: capped },
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to run tsc: ${err.message}`,
						},
					],
					details: { success: false },
				};
			}
		},
	});

	// ── Commands ────────────────────────────────────────────────────────

	pi.registerCommand("lint", {
		description:
			"Run linter on files. Usage: /lint <file1> <file2> ...",
		handler: async (args, ctx) => {
			const files = args.trim()
				? args.trim().split(/\s+/)
				: lastEditedFiles;
			if (files.length === 0) {
				ctx.ui.notify(
					"No files to lint. Edit a file first or pass file paths.",
					"info",
				);
				return;
			}
			let allOk = true;
			for (const file of files) {
				const tool = buildLintTool(file, ctx.cwd);
				if (!tool) {
					ctx.ui.notify(`No linter for ${file}`, "warning");
					continue;
				}
				const result = await runTool(tool, file);
				emitLintResult(pi, result);
				if (!result.success) allOk = false;
			}
			ctx.ui.notify(
				`Lint ${allOk ? "passed" : "failed"}`,
				allOk ? "info" : "error",
			);
		},
	});

	pi.registerCommand("lintguard", {
		description:
			"Toggle auto-lint on/off. Usage: /lintguard [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") autoLint = true;
			else if (arg === "off") autoLint = false;
			else autoLint = !autoLint;

			ctx.ui.notify(
				`Auto-lint: ${autoLint ? "ON" : "OFF"}`,
				"info",
			);
		},
	});
}
