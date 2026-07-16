import { describe, it, expect } from "vitest";
import { detectFileType, buildLintCommand, formatResult } from "../lib/lint-guard-core";
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
		it("builds tsc command for TypeScript", () => {
			const cmd = buildLintCommand("typescript", "/path/to/file.ts");
			expect(cmd).toContain("tsc");
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
