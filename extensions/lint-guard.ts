/**
 * Lint Guard — Deterministic lint checking for every file change
 *
 * Two modes:
 *   1. Auto-lint: hooks into tool_result after edit/write, sends lint results as separate message
 *   2. Manual lint: registers a `lint` tool the agent can call explicitly
 *
 * Cache-safe: does NOT modify tool_result content. Lint results are sent
 * via pi.sendMessage() so the original tool output stays intact for prefix caching.
 *
 * Auto-detects linter from project config (14 linters, 7 languages):
 *   TS/JS: biome, eslint, tsc
 *   Python: ruff, mypy, flake8, pylint
 *   Go: golangci-lint, go vet
 *   Rust: clippy
 *   Java: maven, gradle
 *   Ruby: rubocop
 *   Any: npm check/lint scripts
 *
 * Install:
 *   ln -s "$(pwd)/lint-guard.ts" ~/.pi/agent/extensions/lint-guard.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
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

// ============================================================================
// Linter detection
// ============================================================================

interface LinterConfig {
	name: string;
	command: string;
	args: string[];
	patterns: string[];
}

function detectLinter(cwd: string, filePaths?: string[]): LinterConfig | null {
	// ── TypeScript / JavaScript ──

	if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
		return { name: "biome", command: "npx", args: ["biome", "check", "--no-errors-on-unmatched"], patterns: ["**/*.{ts,tsx,js,jsx,json}"] };
	}

	const eslintConfigs = ["eslint.config.js", "eslint.config.mjs", "eslint.config.ts", ".eslintrc.js", ".eslintrc.mjs", ".eslintrc.json", ".eslintrc.yml"];
	if (eslintConfigs.some((c) => existsSync(join(cwd, c)))) {
		return { name: "eslint", command: "npx", args: ["eslint", "--no-error-on-unmatched-pattern"], patterns: ["**/*.{ts,tsx,js,jsx}"] };
	}

	if (existsSync(join(cwd, "tsconfig.json"))) {
		return { name: "tsc", command: "npx", args: ["tsc", "--noEmit", "--pretty", "false"], patterns: ["**/*.ts"] };
	}

	// ── Python ──

	if (existsSync(join(cwd, "ruff.toml"))) {
		return { name: "ruff", command: "ruff", args: ["check"], patterns: ["**/*.py"] };
	}
	if (existsSync(join(cwd, "pyproject.toml"))) {
		try {
			const content = readFileSync(join(cwd, "pyproject.toml"), "utf-8");
			if (content.includes("[tool.ruff]")) return { name: "ruff", command: "ruff", args: ["check"], patterns: ["**/*.py"] };
			if (content.includes("[tool.mypy]")) return { name: "mypy", command: "mypy", args: ["."], patterns: ["**/*.py"] };
		} catch {}
	}
	if (existsSync(join(cwd, "mypy.ini")) || existsSync(join(cwd, ".mypy.ini"))) {
		return { name: "mypy", command: "mypy", args: ["."], patterns: ["**/*.py"] };
	}
	if (existsSync(join(cwd, ".flake8")) || existsSync(join(cwd, "setup.cfg"))) {
		return { name: "flake8", command: "flake8", args: ["."], patterns: ["**/*.py"] };
	}
	if (existsSync(join(cwd, ".pylintrc")) || existsSync(join(cwd, "pylintrc"))) {
		return { name: "pylint", command: "pylint", args: ["."], patterns: ["**/*.py"] };
	}

	// ── Go ──

	if (existsSync(join(cwd, ".golangci.yml")) || existsSync(join(cwd, ".golangci.yaml"))) {
		return { name: "golangci-lint", command: "golangci-lint", args: ["run"], patterns: ["**/*.go"] };
	}
	if (existsSync(join(cwd, "go.mod"))) {
		return { name: "go-vet", command: "go", args: ["vet", "./..."], patterns: ["**/*.go"] };
	}

	// ── Rust ──

	if (existsSync(join(cwd, "Cargo.toml"))) {
		return { name: "clippy", command: "cargo", args: ["clippy", "--", "-D", "warnings"], patterns: ["**/*.rs"] };
	}

	// ── Java ──

	if (existsSync(join(cwd, "pom.xml"))) {
		return { name: "mvn", command: "mvn", args: ["compile", "-q"], patterns: ["**/*.java"] };
	}
	if (existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) {
		return { name: "gradle", command: "./gradlew", args: ["compileJava", "--quiet"], patterns: ["**/*.java"] };
	}

	// ── Ruby ──

	if (existsSync(join(cwd, ".rubocop.yml"))) {
		return { name: "rubocop", command: "rubocop", args: [], patterns: ["**/*.rb"] };
	}

	// ── Fallback: esbuild syntax check for TS/JS files (no config needed) ──
	if (filePaths && filePaths.length > 0 && filePaths.some((f) => /\.(ts|tsx|js|jsx|mjs)$/i.test(f))) {
		return { name: "esbuild-syntax", command: "npx", args: ["esbuild", "--format=esm"], patterns: ["**/*.{ts,tsx,js,jsx,mjs}"] };
	}

	// ── Package.json scripts (fallback) ──
	// Skip npm script fallback — too brittle, fails when linter not installed

	return null;
}

// ============================================================================
// Linter runner
// ============================================================================

interface LintResult {
	linter: string;
	success: boolean;
	errors: string;
	filesChecked: string[];
}

function runLinter(cwd: string, filePaths?: string[], signal?: AbortSignal): Promise<LintResult> {
	const config = detectLinter(cwd, filePaths);

	if (!config) {
		return Promise.resolve({
			linter: "none",
			success: true,
			errors: "No linter found (checked: biome, eslint, tsc, ruff, mypy, flake8, pylint, golangci, go vet, clippy, maven, gradle, rubocop, npm scripts)",
			filesChecked: [],
		});
	}

	const args = [...config.args];
	if (filePaths && filePaths.length > 0 && config.patterns.length > 0) {
		args.push(...filePaths.map(resolveFile));
	}

	return new Promise((resolve) => {
		const proc = spawn(config.command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
		proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

		proc.on("close", (code: number | null) => {
			const output = (stdout + stderr).trim();
			const capped = output.length > 5000 ? output.slice(0, 5000) + "\n\n[output truncated]" : output;
			resolve({
				linter: config.name,
				success: code === 0,
				errors: capped || (code === 0 ? "No issues found" : "Unknown error"),
				filesChecked: filePaths || [],
			});
		});

		proc.on("error", () => {
			resolve({ linter: config.name, success: false, errors: `Failed to run ${config.command}`, filesChecked: [] });
		});

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 3000);
			};
			if (signal.aborted) kill();
			signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ============================================================================
// State
// ============================================================================

let autoLint = true;
let lastEditedFiles: string[] = [];

// ============================================================================
// The Extension
// ============================================================================

export default function (pi: ExtensionAPI) {

	// ── Auto-lint after edit/write — CACHE SAFE ───────────────────────────
	// Does NOT modify tool_result content. Sends lint results as a separate
	// message so the original tool output stays intact for prefix caching.

	pi.on("tool_result", async (event, ctx) => {
		if (!autoLint) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		// Track edited file path
		const rawPath = (event.input as Record<string, unknown>)?.path
			|| (event.input as Record<string, unknown>)?.file_path;
		if (rawPath && typeof rawPath === "string") {
			lastEditedFiles.push(rawPath);
		}

		if (lastEditedFiles.length === 0) return;

		const files = [...lastEditedFiles];
		lastEditedFiles = [];

		const result = await runLinter(ctx.cwd, files);

		if (!result.success) {
			// Send lint errors as a SEPARATE message — not modifying the tool result
			pi.sendMessage({
				customType: "lint-guard",
				content: `⚠ Lint failed [${result.linter}]:\n${result.errors}`,
				display: true,
				details: { linter: result.linter, files: result.filesChecked },
			}, { deliverAs: "steer" });
		}
	});

	// ── Block bash+sed/awk — enforce edit/write for file modifications ─────

	const SED_PATTERN = /(\bsed\b.*-i\b)|(\bawk\b.*-i\b)|(>\s*\S+\.\w+\s*$)|(\bsed\b.*'[^']*'\s+\S+\.)/;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && event.input.command && SED_PATTERN.test(event.input.command)) {
			return {
				block: true,
				reason: "Use `edit` or `write` tool to modify files, not `bash` with `sed`/`awk`. This triggers syntax checks.",
			};
		}
	});

	// ── Tool: lint — Manual lint check ────────────────────────────────────

	pi.registerTool({
		name: "lint",
		label: "Lint Check",
		description: `Run linter on files. Auto-detects biome/eslint/tsc/ruff/mypy/flake8/pylint/golangci/clippy/maven/gradle/rubocop. Use after making changes.`,
		parameters: Type.Object({
			files: Type.Optional(Type.Array(
				Type.String({ description: "File paths to lint" }),
				{ description: "Specific files. Empty = whole project." },
			)),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Running linter..." }], details: { status: "running" } });

			const result = await runLinter(ctx.cwd, params.files, signal);

			const icon = result.success ? "✓" : "✗";
			const header = `[${result.linter}] ${icon} ${result.success ? "passed" : "failed"}`;
			const files = result.filesChecked.length > 0 ? `\nFiles: ${result.filesChecked.join(", ")}` : "";

			return {
				content: [{ type: "text", text: `${header}${files}\n\n${result.errors}` }],
				details: { linter: result.linter, success: result.success, filesChecked: result.filesChecked },
				isError: !result.success,
			};
		},
	});

	// ── Tool: typecheck — TypeScript only ─────────────────────────────────

	pi.registerTool({
		name: "typecheck",
		label: "Type Check",
		description: `Run tsc --noEmit. Use after code changes to verify types.`,
		parameters: Type.Object({}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Running tsc --noEmit..." }], details: { status: "running" } });

			return new Promise((resolve) => {
				const proc = spawn("npx", ["tsc", "--noEmit", "--pretty", "false"], { cwd: ctx.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

				let stdout = "";
				let stderr = "";

				proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
				proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

				proc.on("close", (code: number | null) => {
					const output = (stdout + stderr).trim();
					const capped = output.length > 5000 ? output.slice(0, 5000) + "\n\n[output truncated]" : output;
					const success = code === 0;
					resolve({
						content: [{ type: "text", text: `${success ? "✓ Types clean" : "✗ Type errors"}\n\n${capped || "(no output)"}` }],
						details: { success, errors: capped },
						isError: !success,
					});
				});

				proc.on("error", (err: Error) => {
					resolve({ content: [{ type: "text", text: `Failed to run tsc: ${err.message}` }], details: { success: false }, isError: true });
				});

				if (signal) {
					const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 3000); };
					if (signal.aborted) kill();
					signal.addEventListener("abort", kill, { once: true });
				}
			});
		},
	});

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("lint", {
		description: "Run linter on the project",
		handler: async (args, ctx) => {
			const files = args.trim() ? args.trim().split(/\s+/) : undefined;
			const result = await runLinter(ctx.cwd, files);
			const icon = result.success ? "✓" : "✗";
			ctx.ui.notify(`[${result.linter}] ${icon} ${result.success ? "passed" : "failed"}\n${result.errors.slice(0, 500)}`, result.success ? "info" : "error");
		},
	});

	pi.registerCommand("lintguard", {
		description: "Toggle auto-lint on/off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") autoLint = true;
			else if (arg === "off") autoLint = false;
			else autoLint = !autoLint;

			ctx.ui.notify(`Auto-lint: ${autoLint ? "ON" : "OFF"}\nLinter: ${detectLinter(ctx.cwd)?.name || "none detected"}`, "info");
		},
	});
}
