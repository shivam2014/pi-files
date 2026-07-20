import { describe, it, expect } from "vitest";
import { parseGitArgs } from "./scout-tools.ts";

describe("parseGitArgs", () => {
	it("splits simple args on whitespace", () => {
		expect(parseGitArgs("log --oneline -5")).toEqual(["log", "--oneline", "-5"]);
	});

	it("handles double-quoted strings", () => {
		expect(parseGitArgs('log --format="%s %an"')).toEqual(["log", "--format=%s %an"]);
	});

	it("handles single-quoted strings", () => {
		expect(parseGitArgs("log --format='%s %an'")).toEqual(["log", "--format=%s %an"]);
	});

	it("strips stderr redirects", () => {
		expect(parseGitArgs("log --oneline 2>/dev/null")).toEqual(["log", "--oneline"]);
	});

	it("strips pipe and everything after", () => {
		expect(parseGitArgs("log --oneline | head -5")).toEqual(["log", "--oneline"]);
	});

	it("handles mixed shell constructs", () => {
		expect(parseGitArgs("diff --name-only HEAD~1 2>/dev/null | sort")).toEqual(["diff", "--name-only", "HEAD~1"]);
	});
});
