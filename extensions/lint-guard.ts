/**
 * Lint Guard — Deterministic lint checking for every file change
 *
 * Two modes:
 *   1. Auto-lint: hooks into tool_result after edit/write, emits visible tool call messages
 *   2. Manual lint: registers a `lint` tool the agent can call explicitly
 *
 * Cache-safe: does NOT modify tool_result content. Lint results are sent
 * via pi.sendMessage() as visible tool calls so the original tool output stays intact.
 *
 * Project-agnostic: walks up directory tree to find config, falls back to standalone
 * checks for each language (tsc --strict, node --check, ruff, ruby -c, javac -Xlint).
 *
 * Languages: TS, JS, Python, Go, Rust, Java, Ruby
 * Tools: tsc, eslint, node, ruff, go vet, cargo, mvn, gradle, javac, rubocop, ruby
 *
 * Install:
 *   ln -s "$(pwd)/lint-guard.ts" ~/.pi/agent/extensions/lint-guard.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve, dirname, parse } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Path helpers ──────────────────────────────────────────────────────

function expandTilde(p: string): string {
	if (p.startsWith("~")) return join(homedir(), p.slice(1));
	return p;
}

function resolveFile(p: string): string {
	return isAbsolute(expandTilde(p)) ? expandTilde(p) : p;
}

// ── walkUpForConfig ───────────────────────────────────────────────────
// Walk up directory tree from filePath looking for config files.
// Returns the first matching config name and its directory, or null.

function walkUpForConfig(
	filePath: string,
	configNames: string[],
): { name: string; dir: string } | null {
	let dir = dirname(resolve(filePath));
	const root = parse(dir).root;
	while (true) {
		for (const name of configNames) {
			if (existsSync(join(dir, name))) {
				return { name, dir };
			}
		}
		if (dir === root) break;
		dir = dirname(dir);
	}
	return null;
}

// ── LintTool / LintResult types ───────────────────────────────────────

interface LintTool {
	tool: string; // executable name (npx, ruff, go, cargo, etc.)
	args: string[]; // arguments including file path if applicable
	cwd?: string; // working directory (project root if config found)
	name: string; // display name (tsc, ruff, go vet, etc.)
}

interface LintResult {
	success: boolean;
	errors: string;
	tool: string;
	file: string;
}

// ── detectTool ────────────────────────────────────────────────────────
// Language-based tool selection. Walks up for project config first,
// falls back to standalone checks for each language.

function detectTool(filePath: string, cwd: string): LintTool | null {
	const ext = filePath.split(".").pop()?.toLowerCase();

	// Walk up from the file's directory to find project config
	const config = walkUpForConfig(filePath, [
		"tsconfig.json",
		"biome.json",
		"biome.jsonc",
		"eslint.config.js",
		"eslint.config.mjs",
		"pyproject.toml",
		"ruff.toml",
		"go.mod",
		"Cargo.toml",
		"pom.xml",
		"build.gradle",
		"build.gradle.kts",
		".rubocop.yml",
	]);

	switch (ext) {
		// ── TypeScript ──
		case "ts":
		case "tsx":
			if (
				config?.name === "tsconfig.json" ||
				config?.name === "biome.json" ||
				config?.name === "biome.jsonc"
			) {
				return {
					tool: "npx",
					args: ["tsc", "--noEmit", "--incremental"],
					cwd: config.dir,
					name: "tsc",
				};
			}
			if (config?.name?.startsWith("eslint")) {
				return {
					tool: "npx",
					args: ["eslint", filePath, "--no-error-on-unmatched-pattern"],
					name: "eslint",
				};
			}
			// Standalone: no config needed
			return {
				tool: "npx",
				args: ["tsc", "--noEmit", "--strict", filePath],
				name: "tsc",
			};

		// ── JavaScript ──
		case "js":
		case "jsx":
		case "mjs":
			if (config?.name === "tsconfig.json") {
				return {
					tool: "npx",
					args: ["tsc", "--allowJs", "--checkJs", "--noEmit"],
					cwd: config.dir,
					name: "tsc",
				};
			}
			if (config?.name?.startsWith("eslint")) {
				return {
					tool: "npx",
					args: ["eslint", filePath, "--no-error-on-unmatched-pattern"],
					name: "eslint",
				};
			}
			// Standalone: node --check
			return { tool: "node", args: ["--check", filePath], name: "node" };

		// ── Python ──
		case "py":
			if (config?.name === "ruff.toml" || config?.name === "pyproject.toml") {
				return { tool: "ruff", args: ["check", filePath], name: "ruff" };
			}
			// ruff works zero-config
			return { tool: "ruff", args: ["check", filePath], name: "ruff" };

		// ── Go ──
		case "go":
			if (config?.name === "go.mod") {
				return {
					tool: "go",
					args: ["vet", "./..."],
					cwd: config.dir,
					name: "go vet",
				};
			}
			return null; // No standalone Go check

		// ── Rust ──
		case "rs":
			if (config?.name === "Cargo.toml") {
				return {
					tool: "cargo",
					args: ["check"],
					cwd: config.dir,
					name: "cargo",
				};
			}
			return null;

		// ── Java ──
		case "java":
			if (config?.name === "pom.xml") {
				return {
					tool: "mvn",
					args: ["compile", "-q"],
					cwd: config.dir,
					name: "mvn",
				};
			}
			if (
				config?.name === "build.gradle" ||
				config?.name === "build.gradle.kts"
			) {
				return {
					tool: "./gradlew",
					args: ["compileJava", "--quiet"],
					cwd: config.dir,
					name: "gradle",
				};
			}
			// Standalone: javac single file
			return { tool: "javac", args: ["-Xlint:all", filePath], name: "javac" };

		// ── Ruby ──
		case "rb":
			if (config?.name === ".rubocop.yml") {
				return { tool: "rubocop", args: [filePath], name: "rubocop" };
			}
			// Standalone: ruby -c
			return { tool: "ruby", args: ["-c", filePath], name: "ruby" };

		default:
			return null;
	}
}

// ── runTool ───────────────────────────────────────────────────────────
// Spawns the detected tool and returns a LintResult.
// Timeouts after 10s, caps error output at 2000 chars.

function runTool(tool: LintTool, filePath: string): Promise<LintResult> {
	return new Promise((resolve) => {
		const child = spawn(tool.tool, tool.args, {
			cwd: tool.cwd || process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000, // 10s timeout
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			const output = (stdout + stderr).trim();
			const success = code === 0;

			resolve({
				success,
				errors: success ? "" : output.slice(0, 2000), // cap at 2k chars
				tool: tool.name,
				file: filePath,
			});
		});

		child.on("error", (err) => {
			resolve({
				success: false,
				errors: `Tool not available: ${err.message}`,
				tool: tool.name,
				file: filePath,
			});
		});
	});
}

// ── emitLintResult ────────────────────────────────────────────────────
// Sends lint result as a visible tool call message so the user sees it
// inline in the conversation. Does NOT modify the original tool result.

function emitLintResult(pi: ExtensionAPI, result: LintResult) {
	const icon = result.success
		? "\u2713"
		: result.errors.includes("not available")
			? "\u26A0"
			: "\u2717";
	const fileName = result.file.split("/").pop() || result.file;
	const content = result.success
		? `${icon} [${result.tool}] ${fileName}: OK`
		: `${icon} [${result.tool}] ${fileName}:\n  ${result.errors}`;

	pi.sendMessage({
		role: "tool",
		toolCallId: `lint-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		toolName: "lint",
		content,
		details: {
			tool: result.tool,
			success: result.success,
			filesChecked: [result.file],
			autoLint: true,
		},
	});
}

// ── State ─────────────────────────────────────────────────────────────

let autoLint = true;
let lastEditedFiles: string[] = [];

// ── The Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Auto-lint after edit/write — CACHE SAFE ─────────────────────────
	// Does NOT modify tool_result content. Sends lint results as visible
	// tool call messages so the original tool output stays intact.

	pi.on("tool_result", async (event, ctx) => {
		if (!autoLint) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const rawPath =
			(event.input as Record<string, unknown>)?.path ||
			(event.input as Record<string, unknown>)?.file_path;
		if (!rawPath || typeof rawPath !== "string") return;

		// Track for manual lint command
		lastEditedFiles.push(rawPath);

		const tool = detectTool(rawPath, ctx.cwd);
		if (!tool) return;

		const result = await runTool(tool, rawPath);
		emitLintResult(pi, result);
	});

	// ── Block bash+sed/awk — enforce edit/write for file modifications ─

	const SED_PATTERN =
		/(\bsed\b.*-i\b)|(\bawk\b.*-i\b)|(>\s*\S+\.\w+\s*$)|(\bsed\b.*'[^']*'\s+\S+\.)/;

	pi.on("tool_call", async (event, ctx) => {
		if (
			event.toolName === "bash" &&
			event.input.command &&
			SED_PATTERN.test(event.input.command)
		) {
			return {
				block: true,
				reason:
					"Use `edit` or `write` tool to modify files, not `bash` with `sed`/`awk`. This triggers automatic lint checks.",
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
				const tool = detectTool(file, ctx.cwd);
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
			onUpdate?.({
				content: [{ type: "text", text: "Running tsc --noEmit..." }],
				details: { status: "running" },
			});

			return new Promise((resolve) => {
				const proc = spawn(
					"npx",
					["tsc", "--noEmit", "--pretty", "false"],
					{
						cwd: ctx.cwd,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					},
				);

				let stdout = "";
				let stderr = "";

				proc.stdout.on("data", (data: Buffer) => {
					stdout += data.toString();
				});
				proc.stderr.on("data", (data: Buffer) => {
					stderr += data.toString();
				});

				proc.on("close", (code: number | null) => {
					const output = (stdout + stderr).trim();
					const capped =
						output.length > 5000
							? output.slice(0, 5000) +
								"\n\n[output truncated]"
							: output;
					const success = code === 0;
					resolve({
						content: [
							{
								type: "text",
								text: `${success ? "\u2713 Types clean" : "\u2717 Type errors"}\n\n${capped || "(no output)"}`,
							},
						],
						details: { success, errors: capped },
						isError: !success,
					});
				});

				proc.on("error", (err: Error) => {
					resolve({
						content: [
							{
								type: "text",
								text: `Failed to run tsc: ${err.message}`,
							},
						],
						details: { success: false },
						isError: true,
					});
				});

				if (signal) {
					const kill = () => {
						proc.kill("SIGTERM");
						setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, 3000);
					};
					if (signal.aborted) kill();
					signal.addEventListener("abort", kill, { once: true });
				}
			});
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
				const tool = detectTool(file, ctx.cwd);
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
