/**
 * lint-guard-core — PI-agnostic lint logic
 *
 * No SDK imports. Pure functions for file type detection,
 * command building, config walking, and result formatting.
 */

import { existsSync } from "node:fs";
import { join, isAbsolute, resolve as pathResolve, dirname, parse } from "node:path";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────

export type FileType =
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "java"
	| "ruby";

export interface LintTool {
	tool: string;
	args: string[];
	cwd?: string;
	name: string;
}

export interface LintResult {
	success: boolean;
	errors: string;
	tool: string;
	file: string;
}

// ── Path helpers ──────────────────────────────────────────────────────

export function expandTilde(p: string): string {
	if (p.startsWith("~")) return join(homedir(), p.slice(1));
	return p;
}

export function resolveFile(p: string): string {
	return isAbsolute(expandTilde(p)) ? expandTilde(p) : p;
}

// ── Bash write detection ──────────────────────────────────────────────

/** In-place flag belonging to sed/awk: `-i`, `-i.bak`, `-ni`, `--in-place[=SUFFIX]`. */
const IN_PLACE_FLAG = /(?:^|\s)(?:-[A-Za-z]*i\S*|--in-place\S*)(?=\s|$)/;

/** Command separators, so a flag from another pipeline command (e.g. `grep -i`) never counts. */
const COMMAND_SEPARATOR = /\|\||&&|[|;&\n]/;

/**
 * True when a bash command performs an actual file write that should go
 * through the edit/write tools instead:
 *   - `sed`/`awk` invoked in place (`-i` / `-i.bak` / `--in-place`)
 *   - trailing shell redirection to an extension-bearing file (`... > out.txt`)
 *
 * Read-only forms stay allowed: `sed -n '1,5p' file.txt`,
 * `sed 's/x/y/' file.txt`, `sed -n '1p' file.txt | grep -i foo`.
 */
export function isFileWriteCommand(command: string): boolean {
	if (typeof command !== "string" || command.length === 0) return false;
	if (/>\s*\S+\.\w+\s*$/.test(command)) return true;
	for (const segment of command.split(COMMAND_SEPARATOR)) {
		if (!/\b(?:sed|awk)\b/.test(segment)) continue;
		if (IN_PLACE_FLAG.test(segment)) return true;
	}
	return false;
}

// ── Command availability ──────────────────────────────────────────────

export function commandExists(cmd: string): boolean {
	const isWin = platform() === "win32";
	const result = isWin
		? spawnSync("where", [cmd], { stdio: "ignore" })
		: spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
	return result.status === 0;
}

// ── Config roster ─────────────────────────────────────────────────────

export const CONFIG_ROSTER = [
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

export function walkUpForConfig(
	filePath: string,
	configNames: string[],
): { name: string; dir: string } | null {
	let dir = dirname(pathResolve(filePath));
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

// ── Gradle executable selection ───────────────────────────────────────

export function gradleTool(configDir: string): string {
	const isWin = platform() === "win32";
	const wrapperName = isWin ? "gradlew.bat" : "gradlew";
	const wrapperExec = isWin ? "gradlew.bat" : "./gradlew";
	if (existsSync(join(configDir, wrapperName))) return wrapperExec;
	if (commandExists("gradle")) return "gradle";
	return wrapperExec;
}

// ── detectFileType ────────────────────────────────────────────────────

/**
 * Single source of truth: extension → FileType mapping.
 * The lintable-extension set and detectFileType() both derive from this, so a
 * new supported language only has to be declared once.
 */
export const FILE_TYPE_BY_EXTENSION: Record<string, FileType> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	py: "python",
	go: "go",
	rs: "rust",
	java: "java",
	rb: "ruby",
};

/**
 * Extensions lint-guard can lint. Derived from FILE_TYPE_BY_EXTENSION — import
 * this (or isLintableExtension) instead of duplicating the list anywhere.
 */
export const LINTABLE_EXTENSIONS: string[] = Object.keys(FILE_TYPE_BY_EXTENSION);

/** True when the file's extension is one lint-guard supports. */
export function isLintableExtension(filePath: string | null | undefined): boolean {
	if (!filePath) return false;
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return Object.prototype.hasOwnProperty.call(FILE_TYPE_BY_EXTENSION, ext);
}

export function detectFileType(filePath: string): FileType | null {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return FILE_TYPE_BY_EXTENSION[ext] ?? null;
}

// ── buildLintCommand ──────────────────────────────────────────────────

export function buildLintCommand(
	fileType: FileType,
	filePath: string,
): string {
	switch (fileType) {
		case "typescript":
			return commandExists("npx")
				? `npx tsc --noEmit ${filePath}`
				: `tsc --noEmit ${filePath}`;
		case "javascript":
			return `npx eslint ${filePath}`;
		case "python":
			return commandExists("ruff")
				? `ruff check ${filePath}`
				: `python -m py_compile ${filePath}`;
		case "go":
			return "go vet ./...";
		case "rust":
			return "cargo check";
		case "java":
			return `javac -Xlint:all ${filePath}`;
		case "ruby":
			return commandExists("rubocop")
				? `rubocop ${filePath}`
				: `ruby -c ${filePath}`;
	}
}

// ── buildLintTool ─────────────────────────────────────────────────────

export function buildLintTool(filePath: string, cwd: string): LintTool | null {
	const resolvedFile = pathResolve(cwd, filePath);
	const standaloneCwd = dirname(resolvedFile);
	const fileType = detectFileType(resolvedFile);
	if (!fileType) return null;

	const config = walkUpForConfig(resolvedFile, CONFIG_ROSTER);
	const isEslintConfig =
		config &&
		(config.name.startsWith("eslint") || config.name.startsWith(".eslintrc"));

	switch (fileType) {
		case "typescript":
			if (
				config?.name === "tsconfig.json" ||
				config?.name === "biome.json" ||
				config?.name === "biome.jsonc"
			) {
				const useNpx = commandExists("npx");
				return {
					tool: useNpx ? "npx" : "tsc",
					args: useNpx
						? ["tsc", "--noEmit", "--incremental"]
						: ["--noEmit", "--incremental"],
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

		case "javascript":
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
			return {
				tool: "node",
				args: ["--check", resolvedFile],
				cwd: standaloneCwd,
				name: "node",
			};

		case "python": {
			const useRuff = commandExists("ruff");
			if (useRuff) {
				return {
					tool: "ruff",
					args: ["check", resolvedFile],
					cwd: standaloneCwd,
					name: "ruff",
				};
			}
			return {
				tool: "python",
				args: ["-m", "py_compile", resolvedFile],
				cwd: standaloneCwd,
				name: "py_compile",
			};
		}

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

		case "rust":
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
			return {
				tool: "javac",
				args: ["-Xlint:all", resolvedFile],
				cwd: standaloneCwd,
				name: "javac",
			};

		case "ruby":
			if (
				config?.name === ".rubocop.yml" ||
				config?.name === ".rubocop.yaml"
			) {
				return {
					tool: "rubocop",
					args: [resolvedFile],
					cwd: standaloneCwd,
					name: "rubocop",
				};
			}
			return {
				tool: "ruby",
				args: ["-c", resolvedFile],
				cwd: standaloneCwd,
				name: "ruby",
			};
	}
}

// ── formatResult ──────────────────────────────────────────────────────

export function formatResult(result: LintResult): string {
	const icon = result.success
		? "✓"
		: result.errors.includes("not available")
			? "⚠"
			: "✗";
	const fileName = result.file.split("/").pop() || result.file;
	if (result.success) {
		return `${icon} [${result.tool}] ${fileName}: OK`;
	}
	return `${icon} [${result.tool}] ${fileName}:\n  ${result.errors}`;
}
