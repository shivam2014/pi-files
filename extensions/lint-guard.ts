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
 * checks for each language.
 *
 * Languages: TS, JS, Python, Go, Rust, Java, Ruby
 * Tools: tsc, eslint, node, ruff, go vet, cargo, mvn, gradle, javac, rubocop, ruby
 *
 * Install:
 *   ln -s "$(pwd)/lint-guard.ts" ~/.pi/agent/extensions/lint-guard.ts
 */

import { existsSync } from "node:fs";
import { join, isAbsolute, resolve, dirname, parse, delimiter } from "node:path";
import { homedir, platform } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Build shell environment with SDK bin dir prepended to PATH (mirrors SDK's internal getShellEnv) */
function getShellEnv(): NodeJS.ProcessEnv {
    const binDir = join(getAgentDir(), "bin");
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === "path") ?? "PATH";
    const currentPath = process.env[pathKey] ?? "";
    const pathEntries = currentPath.split(delimiter).filter(Boolean);
    const hasBinDir = pathEntries.includes(binDir);
    const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);
    return { ...process.env, [pathKey]: updatedPath };
}

// ── Path helpers ──────────────────────────────────────────────────────

function expandTilde(p: string): string {
	if (p.startsWith("~")) return join(homedir(), p.slice(1));
	return p;
}

function resolveFile(p: string): string {
	return isAbsolute(expandTilde(p)) ? expandTilde(p) : p;
}

// ── Command availability ──────────────────────────────────────────────

function commandExists(cmd: string): boolean {
	const isWin = platform() === "win32";
	const result = isWin
		? spawnSync("where", [cmd], { stdio: "ignore" })
		: spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
	return result.status === 0;
}

// ── Config roster ─────────────────────────────────────────────────────

const CONFIG_ROSTER = [
	"tsconfig.json",
	"biome.json",
	"biome.jsonc",
	".eslintrc",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.yaml",
	".eslintrc.json",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	"deno.json",
	"deno.jsonc",
	"pyproject.toml",
	"ruff.toml",
	"pyrightconfig.json",
	"setup.cfg",
	".flake8",
	"go.mod",
	"Cargo.toml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	".rubocop.yml",
	".rubocop.yaml",
];

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
	tool: string; // executable name
	args: string[]; // arguments including file path if applicable
	cwd?: string; // working directory
	name: string; // display name
}

interface LintResult {
	success: boolean;
	errors: string;
	tool: string;
	file: string;
}

// ── Gradle executable selection ───────────────────────────────────────

function gradleTool(configDir: string): string {
	const isWin = platform() === "win32";
	const wrapperName = isWin ? "gradlew.bat" : "gradlew";
	const wrapperExec = isWin ? "gradlew.bat" : "./gradlew";
	if (existsSync(join(configDir, wrapperName))) return wrapperExec;
	if (commandExists("gradle")) return "gradle";
	return wrapperExec;
}

// ── detectTool ────────────────────────────────────────────────────────
// Language-based tool selection. Walks up from the resolved file to find
// project config, falls back to standalone checks for each language.

function detectTool(filePath: string, cwd: string): LintTool | null {
	const resolvedFile = resolve(cwd, filePath);
	const standaloneCwd = dirname(resolvedFile);
	const ext = resolvedFile.split(".").pop()?.toLowerCase();

	const config = walkUpForConfig(resolvedFile, CONFIG_ROSTER);
	const isEslintConfig =
		config &&
		(config.name.startsWith("eslint") || config.name.startsWith(".eslintrc"));

	switch (ext) {
		// ── TypeScript ──
		case "ts":
		case "tsx":
			if (
				config?.name === "tsconfig.json" ||
				config?.name === "biome.json" ||
				config?.name === "biome.jsonc"
			) {
				const useNpx = commandExists("npx");
				return {
					tool: useNpx ? "npx" : "tsc",
					args: useNpx ? ["tsc", "--noEmit", "--incremental"] : ["--noEmit", "--incremental"],
					cwd: config.dir,
					name: "tsc",
				};
			}
			if (isEslintConfig) {
				return {
					tool: "npx",
					args: ["eslint", resolvedFile, "--no-error-on-unmatched-pattern"],
					cwd: config.dir,
					name: "eslint",
				};
			}
			// Standalone
			{
				const useNpx = commandExists("npx");
				return {
					tool: useNpx ? "npx" : "tsc",
					args: useNpx
						? ["tsc", "--noEmit", "--strict", resolvedFile]
						: ["--noEmit", "--strict", resolvedFile],
					cwd: standaloneCwd,
					name: "tsc",
				};
			}

		// ── JavaScript ──
		case "js":
		case "jsx":
		case "mjs":
			if (config?.name === "tsconfig.json") {
				const useNpx = commandExists("npx");
				return {
					tool: useNpx ? "npx" : "tsc",
					args: useNpx
						? ["tsc", "--allowJs", "--checkJs", "--noEmit"]
						: ["--allowJs", "--checkJs", "--noEmit"],
					cwd: config.dir,
					name: "tsc",
				};
			}
			if (isEslintConfig) {
				return {
					tool: "npx",
					args: ["eslint", resolvedFile, "--no-error-on-unmatched-pattern"],
					cwd: config.dir,
					name: "eslint",
				};
			}
			// Standalone: node --check
			return { tool: "node", args: ["--check", resolvedFile], cwd: standaloneCwd, name: "node" };

		// ── Python ──
		case "py": {
			const useRuff = commandExists("ruff");
			if (useRuff) {
				return { tool: "ruff", args: ["check", resolvedFile], cwd: standaloneCwd, name: "ruff" };
			}
			return {
				tool: "python",
				args: ["-m", "py_compile", resolvedFile],
				cwd: standaloneCwd,
				name: "py_compile",
			};
		}

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
			return {
				tool: "gofmt",
				args: ["-l", resolvedFile],
				cwd: standaloneCwd,
				name: "gofmt",
			};

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
			return {
				tool: "rustc",
				args: ["--emit=metadata", resolvedFile],
				cwd: standaloneCwd,
				name: "rustc",
			};

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
					tool: gradleTool(config.dir),
					args: ["compileJava", "--quiet"],
					cwd: config.dir,
					name: "gradle",
				};
			}
			// Standalone: javac single file
			return {
				tool: "javac",
				args: ["-Xlint:all", resolvedFile],
				cwd: standaloneCwd,
				name: "javac",
			};

		// ── Ruby ──
		case "rb":
			if (config?.name === ".rubocop.yml" || config?.name === ".rubocop.yaml") {
				return { tool: "rubocop", args: [resolvedFile], cwd: standaloneCwd, name: "rubocop" };
			}
			// Standalone: ruby -c
			return { tool: "ruby", args: ["-c", resolvedFile], cwd: standaloneCwd, name: "ruby" };

		default:
			return null;
	}
}

// ── runTool ───────────────────────────────────────────────────────────
// Spawns the detected tool and returns a LintResult.
// Timeouts after 10s, caps error output at 2000 chars.

function runTool(tool: LintTool, filePath: string): Promise<LintResult> {
	return new Promise((resolve) => {
		const child = spawn("/bin/bash", ["-c", 'exec "$@"', "bash", tool.tool, ...tool.args], {
			cwd: tool.cwd || process.cwd(),
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
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
			let output = (stdout + stderr).trim();
			let success = code === 0;

			if (tool.name === "gofmt") {
				success = code === 0 && output.length === 0;
				if (!success && output.length === 0) {
					output = "gofmt would reformat this file";
				}
			}

			resolve({
				success,
				errors: success ? "" : output.slice(0, 2000),
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
	// Does NOT modify tool_result content. Sends lint results as visible
	// tool call messages so the original tool output stays intact.

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

			const tool = detectTool(resolvedPath, ctx.cwd);
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

			return new Promise((resolve) => {
				const proc = spawn(
					"/bin/bash",
					["-c", 'exec "$@"', "bash", "npx", "tsc", "--noEmit", "--pretty", "false"],
					{
						cwd: ctx.cwd,
						env: getShellEnv(),
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
