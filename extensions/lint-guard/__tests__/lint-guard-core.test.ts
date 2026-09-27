import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLintCommand,
	buildLintTool,
	bundledTscMissingError,
	bundledTscPath,
	describeToolError,
	detectFileType,
	formatResult,
} from "../lib/lint-guard-core";
import type { LintResult } from "../lib/lint-guard-core";

describe("lint-guard-core", () => {
	describe("detectFileType", () => {
		it("detects TypeScript files", () => {
			expect(detectFileType("test.ts")).toBe("typescript");
			expect(detectFileType("test.tsx")).toBe("typescript");
		});

		it("detects JavaScript files", () => {
			expect(detectFileType("test.js")).toBe("javascript");
			expect(detectFileType("test.jsx")).toBe("javascript");
			expect(detectFileType("test.mjs")).toBe("javascript");
		});

		it("detects Python files", () => {
			expect(detectFileType("test.py")).toBe("python");
		});

		it("detects Go files", () => {
			expect(detectFileType("main.go")).toBe("go");
		});

		it("detects Rust files", () => {
			expect(detectFileType("main.rs")).toBe("rust");
		});

		it("detects Java files", () => {
			expect(detectFileType("Main.java")).toBe("java");
		});

		it("detects Ruby files", () => {
			expect(detectFileType("app.rb")).toBe("ruby");
		});

		it("returns null for unknown extensions", () => {
			expect(detectFileType("readme.md")).toBeNull();
			expect(detectFileType("style.css")).toBeNull();
		});
	});

	describe("buildLintCommand", () => {
		it("builds bundled tsc command for TypeScript (no npx)", () => {
			const cmd = buildLintCommand("typescript", "/path/to/file.ts");
			expect(cmd).toContain("tsc");
			expect(cmd).toContain(bundledTscPath());
			expect(cmd).toContain(process.execPath);
			expect(cmd).toContain("--noEmit");
			expect(cmd).not.toContain("npx");
		});

		it("builds eslint command for JavaScript", () => {
			const cmd = buildLintCommand("javascript", "/path/to/file.js");
			expect(cmd).toContain("eslint");
		});

		it("builds ruff/python command for Python", () => {
			const cmd = buildLintCommand("python", "/path/to/file.py");
			expect(cmd).toMatch(/ruff|py_compile/);
		});

		it("builds go vet command for Go", () => {
			const cmd = buildLintCommand("go", "/path/to/file.go");
			expect(cmd).toContain("go vet");
		});

		it("builds cargo command for Rust", () => {
			const cmd = buildLintCommand("rust", "/path/to/file.rs");
			expect(cmd).toContain("cargo");
		});

		it("builds javac command for Java", () => {
			const cmd = buildLintCommand("java", "/path/to/file.java");
			expect(cmd).toContain("javac");
		});

		it("builds rubocop/ruby command for Ruby", () => {
			const cmd = buildLintCommand("ruby", "/path/to/file.rb");
			expect(cmd).toMatch(/rubocop|ruby/);
		});
	});

	describe("bundled TypeScript toolchain", () => {
		it("points at the extensions node_modules tsc entry", () => {
			expect(bundledTscPath()).toMatch(/node_modules\/typescript\/bin\/tsc$/);
			expect(bundledTscPath().endsWith("extensions/node_modules/typescript/bin/tsc")).toBe(true);
		});

		it("missing-toolchain error names the install step", () => {
			const msg = bundledTscMissingError();
			expect(msg).toContain("not available");
			expect(msg).toContain("npm install");
		});
	});

	describe("buildLintTool tsc construction", () => {
		it("runs the bundled tsc via process.execPath, never npx", () => {
			const probe = join(tmpdir(), "pi-lint-probe", "file.ts");
			const tool = buildLintTool(probe, process.cwd());
			expect(tool).not.toBeNull();
			expect(tool!.name).toBe("tsc");
			expect(tool!.tool).toBe(process.execPath);
			expect(tool!.tool).not.toBe("npx");
			expect(tool!.args[0]).toBe(bundledTscPath());
			expect(tool!.args).toContain("--noEmit");
			expect(tool!.error).toBeUndefined();
		});
	});

	describe("describeToolError", () => {
		it("relabels runner timeouts honestly", () => {
			expect(describeToolError("timeout:10")).toBe("Timed out after 10s");
			expect(describeToolError("timeout:120")).toBe("Timed out after 120s");
		});

		it("handles fractional and malformed timeout payloads", () => {
			expect(describeToolError("timeout:0.5")).toBe("Timed out after 0.5s");
			expect(describeToolError("timeout:abc")).toBe("Timed out");
		});

		it("keeps Tool not available for genuinely missing tools", () => {
			expect(describeToolError("spawn ruff ENOENT")).toBe("Tool not available: spawn ruff ENOENT");
			expect(describeToolError("aborted")).toBe("Tool not available: aborted");
		});
	});

	describe("formatResult", () => {
		it("formats success result", () => {
			const result: LintResult = {
				success: true,
				errors: "",
				tool: "tsc",
				file: "/path/to/file.ts",
			};
			const output = formatResult(result);
			expect(output).toContain("OK");
			expect(output).toContain("tsc");
			expect(output).toContain("file.ts");
		});

		it("formats failure result", () => {
			const result: LintResult = {
				success: false,
				errors: "TS2322: Type 'string' is not assignable to type 'number'",
				tool: "tsc",
				file: "/path/to/file.ts",
			};
			const output = formatResult(result);
			expect(output).toContain("TS2322");
			expect(output).toContain("tsc");
		});

		it("formats unavailable tool result", () => {
			const result: LintResult = {
				success: false,
				errors: "Tool not available: spawn ruff ENOENT",
				tool: "ruff",
				file: "/path/to/file.py",
			};
			const output = formatResult(result);
			expect(output).toContain("⚠");
		});
	});
});
