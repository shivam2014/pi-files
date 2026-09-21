/**
 * lint-guard-sed.test.ts
 *
 * Regression tests for the sed/awk bash guard (handoff §4.1):
 * read-only sed must pass; only real write signals (in-place flags,
 * trailing shell redirection to an extension-bearing file) are blocked.
 */

import { describe, expect, it } from "vitest";
import { isFileWriteCommand } from "../lib/lint-guard-core";

describe("isFileWriteCommand — read-only commands pass", () => {
	it("allows `sed -n '1,5p' file.txt` (handoff §4.1 false positive)", () => {
		expect(isFileWriteCommand("sed -n '1,5p' file.txt")).toBe(false);
	});

	it("allows read-only sed substitution without -i", () => {
		expect(isFileWriteCommand("sed 's/x/y/' file.txt")).toBe(false);
		expect(isFileWriteCommand("sed -n 's/x/y/p' file.txt")).toBe(false);
	});

	it("allows read-only sed piped into grep -i", () => {
		expect(isFileWriteCommand("sed -n '1p' file.txt | grep -i foo")).toBe(
			false,
		);
	});

	it("allows read-only awk", () => {
		expect(isFileWriteCommand("awk '{print $1}' file.txt")).toBe(false);
		expect(isFileWriteCommand("awk -F, '{print $1}' data.csv")).toBe(false);
	});

	it("allows empty / non-string input", () => {
		expect(isFileWriteCommand("")).toBe(false);
	});
});

describe("isFileWriteCommand — real writes are blocked", () => {
	it("blocks `sed -i` (GNU and macOS forms)", () => {
		expect(isFileWriteCommand("sed -i 's/x/y/' file.txt")).toBe(true);
		expect(isFileWriteCommand("sed -i '' 's/x/y/' file.txt")).toBe(true);
		expect(isFileWriteCommand("sed -i.bak 's/x/y/' file.txt")).toBe(true);
		expect(isFileWriteCommand("sed --in-place 's/x/y/' file.txt")).toBe(true);
		expect(isFileWriteCommand("sed --in-place=.bak 's/x/y/' file.txt")).toBe(
			true,
		);
	});

	it("blocks bundled sed short flags containing -i", () => {
		expect(isFileWriteCommand("sed -ni '1,5p' file.txt")).toBe(true);
		expect(isFileWriteCommand("sed -Ei 's/x/y/' file.txt")).toBe(true);
	});

	it("blocks awk in-place form", () => {
		expect(isFileWriteCommand("awk -i inplace '{print}' file.txt")).toBe(true);
	});

	it("blocks shell redirection to an extension-bearing file", () => {
		expect(isFileWriteCommand("echo hi > out.txt")).toBe(true);
		expect(isFileWriteCommand("printf x > /tmp/a.ts")).toBe(true);
	});
});

describe("isFileWriteCommand — regression guard", () => {
	it("does not count flags of other pipeline commands as in-place sed", () => {
		expect(isFileWriteCommand("sed -n '1p' file.txt | grep -i foo")).toBe(
			false,
		);
		expect(isFileWriteCommand("grep -i foo file.txt")).toBe(false);
	});

	it("still blocks a real in-place edit inside a pipeline segment", () => {
		expect(isFileWriteCommand("cat file.txt && sed -i 's/x/y/' file.txt")).toBe(
			true,
		);
	});
});
