import { describe, it, expect } from "vitest";
import { parseGitArgs, validateGhApiReadonly } from "./scout-tools.ts";

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

describe("validateGhApiReadonly (gh api is GET-only)", () => {
	it("allows a plain GET endpoint", () => {
		expect(validateGhApiReadonly(["search/issues?q=x"])).toBeNull();
	});

	it("allows an explicit GET method", () => {
		expect(validateGhApiReadonly(["-X", "GET", "search/issues?q=x"])).toBeNull();
		expect(validateGhApiReadonly(["--method=GET", "repos/foo/bar"])).toBeNull();
	});

	it("rejects non-GET methods", () => {
		expect(validateGhApiReadonly(["-X", "POST", "repos/foo/bar/issues"])).toContain("read-only");
		expect(validateGhApiReadonly(["--method=PATCH", "repos/foo/bar"])).toContain("read-only");
		expect(validateGhApiReadonly(["-XDELETE", "repos/foo/bar"])).toContain("read-only");
	});

	it("rejects write fields", () => {
		expect(validateGhApiReadonly(["-f", "title=x", "repos/foo/bar/issues"])).toContain("read-only");
		expect(validateGhApiReadonly(["-F", "body=@file"])).toContain("read-only");
		expect(validateGhApiReadonly(["--input", "payload.json"])).toContain("read-only");
		expect(validateGhApiReadonly(["--field=state=closed"])).toContain("read-only");
	});

	it("rejects graphql", () => {
		expect(validateGhApiReadonly(["graphql"])).toContain("read-only");
		expect(validateGhApiReadonly(["graphql", "-f", "query=x"])).toContain("read-only");
	});
});
