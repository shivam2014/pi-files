/**
 * Tests for BashInterceptor — pure bash command interception functions.
 */
import { describe, it, expect } from "vitest";
import {
	firstCommandName,
	hasFileWriteIndicator,
	isMutatingEditor,
	getBashToolReplacement,
} from "./bash-interceptor";

// ── firstCommandName ──

describe("firstCommandName", () => {
	it("returns null for empty string", () => {
		expect(firstCommandName("")).toBeNull();
	});

	it("returns null for whitespace-only", () => {
		expect(firstCommandName("   ")).toBeNull();
	});

	it("extracts simple command", () => {
		expect(firstCommandName("ls -la")).toEqual({ name: "ls", rest: "-la" });
	});

	it("strips path prefix", () => {
		expect(firstCommandName("/usr/bin/cat foo.txt")).toEqual({
			name: "cat",
			rest: "foo.txt",
		});
	});

	it("lowercases name", () => {
		expect(firstCommandName("Grep -r foo")).toEqual({ name: "grep", rest: "-r foo" });
	});

	it("skips env variable assignments", () => {
		expect(firstCommandName("FOO=bar ls -la")).toEqual({ name: "ls", rest: "-la" });
	});

	it("skips export prefix with inline assignment", () => {
		expect(firstCommandName("export FOO=bar cat")).toEqual({
			name: "cat",
			rest: "",
		});
	});

	it("returns null when export+assignment consumes all tokens in first segment", () => {
		expect(firstCommandName("export FOO=bar && cat file")).toBeNull();
	});

	it("handles pipe separator", () => {
		expect(firstCommandName("cat file | grep foo")).toEqual({
			name: "cat",
			rest: "file",
		});
	});

	it("handles && separator", () => {
		expect(firstCommandName("mkdir -p dir && touch file")).toEqual({
			name: "mkdir",
			rest: "-p dir",
		});
	});

	it("handles ; separator", () => {
		expect(firstCommandName("echo hello; ls -la")).toEqual({
			name: "echo",
			rest: "hello",
		});
	});

	it("returns null for env-only commands", () => {
		expect(firstCommandName("FOO=bar")).toBeNull();
		expect(firstCommandName("export FOO=bar")).toBeNull();
	});
});

// ── hasFileWriteIndicator ──

describe("hasFileWriteIndicator", () => {
	it("detects >> redirect", () => {
		expect(hasFileWriteIndicator("echo hello >> file.txt")).toBe(true);
	});

	it("detects > redirect", () => {
		expect(hasFileWriteIndicator("echo hello > file.txt")).toBe(true);
	});

	it("detects open with 'w'", () => {
		expect(hasFileWriteIndicator("open('file.txt', 'w')")).toBe(true);
	});

	it("detects open with 'a'", () => {
		expect(hasFileWriteIndicator("open('file.txt', 'a')")).toBe(true);
	});

	it("detects open with 'x'", () => {
		expect(hasFileWriteIndicator("open('file.txt', 'x')")).toBe(true);
	});

	it("detects fs.writeFile", () => {
		expect(hasFileWriteIndicator("fs.writeFile(path, data)")).toBe(true);
	});

	it("detects fs.writeFileSync", () => {
		expect(hasFileWriteIndicator("fs.writeFileSync(path, data)")).toBe(true);
	});

	it("detects fs.appendFile", () => {
		expect(hasFileWriteIndicator("fs.appendFile(path, data)")).toBe(true);
	});

	it("detects writeFile standalone", () => {
		expect(hasFileWriteIndicator("writeFile(path, data)")).toBe(true);
	});

	it("detects appendFileSync standalone", () => {
		expect(hasFileWriteIndicator("appendFileSync(path, data)")).toBe(true);
	});

	it("returns false for read-only commands", () => {
		expect(hasFileWriteIndicator("cat file.txt")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasFileWriteIndicator("")).toBe(false);
	});
});

// ── isMutatingEditor ──

describe("isMutatingEditor", () => {
	it("returns true for sed -i", () => {
		expect(isMutatingEditor("sed", "sed -i 's/foo/bar/' file.txt")).toBe(true);
	});

	it("returns true for perl -i", () => {
		expect(isMutatingEditor("perl", "perl -i -pe 's/foo/bar/' file.txt")).toBe(true);
	});

	it("returns false for sed without -i", () => {
		expect(isMutatingEditor("sed", "sed 's/foo/bar/' file.txt")).toBe(false);
	});

	it("returns false for perl without -i", () => {
		expect(isMutatingEditor("perl", "perl -pe 's/foo/bar/' file.txt")).toBe(false);
	});

	it("delegates to hasFileWriteIndicator for non-editor commands", () => {
		expect(isMutatingEditor("awk", "awk '{print $1}' file.txt")).toBe(false);
		expect(isMutatingEditor("python", "open('f.txt', 'w')")).toBe(true);
	});
});

// ── getBashToolReplacement ──

describe("getBashToolReplacement", () => {
	it("returns null when override is true", () => {
		expect(getBashToolReplacement("cat file", true)).toBeNull();
	});

	it("returns null when command is undefined", () => {
		expect(getBashToolReplacement(undefined)).toBeNull();
	});

	it("redirects cat to read", () => {
		expect(getBashToolReplacement("cat file.txt")).toBe("read");
	});

	it("redirects grep to grep", () => {
		expect(getBashToolReplacement("grep -r foo .")).toBe("grep");
	});

	it("redirects rg to grep", () => {
		expect(getBashToolReplacement("rg -r foo .")).toBe("grep");
	});

	it("redirects find to find", () => {
		expect(getBashToolReplacement("find . -name '*.ts'")).toBe("find");
	});

	it("redirects ls to ls", () => {
		expect(getBashToolReplacement("ls -la")).toBe("ls");
	});

	it("redirects mkdir to write", () => {
		expect(getBashToolReplacement("mkdir -p dir")).toBe("write");
	});

	it("redirects touch to write", () => {
		expect(getBashToolReplacement("touch file.txt")).toBe("write");
	});

	it("redirects sed -i to edit", () => {
		expect(getBashToolReplacement("sed -i 's/foo/bar/' file")).toBe("edit");
	});

	it("allows sed without -i", () => {
		expect(getBashToolReplacement("sed 's/foo/bar/' file")).toBeNull();
	});

	it("redirects python with write indicator to edit", () => {
		expect(getBashToolReplacement("python -c \"open('f.txt','w')\"")).toBe("edit");
	});

	it("allows python without write indicator", () => {
		expect(getBashToolReplacement("python script.py")).toBeNull();
	});

	it("allows node without write indicator", () => {
		expect(getBashToolReplacement("node script.js")).toBeNull();
	});

	it("redirects node with write indicator to edit", () => {
		expect(getBashToolReplacement("node -e \"fs.writeFile('x',data)\"")).toBe("edit");
	});

	it("returns null for unknown commands", () => {
		expect(getBashToolReplacement("docker build .")).toBeNull();
	});
});
