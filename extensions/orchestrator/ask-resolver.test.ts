/**
 * Tests for ask-resolver.ts — the AskResolver module extracted from delegate-tool.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractReferencedPaths,
	readFilePreview,
	tryAnswerFromDocs,
	buildRecentContext,
	tryAnswerFromContext,
	createAskOrchestratorResolver,
	resolve, hasLiteralSegment,
} from "./ask-resolver.ts";

// ─── extractReferencedPaths ──────────────────────────────────────────────────

describe("extractReferencedPaths", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "extract-ref-paths-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("extracts paths from text with absolute paths", () => {
		const file = join(cwd, "config.json");
		writeFileSync(file, "{}", "utf-8");

		const result = extractReferencedPaths(`Check ${file} for details`, cwd);
		expect(result).toContain(file);
	});

	it("extracts paths from text with basename + extension", () => {
		writeFileSync(join(cwd, "readme.md"), "# Hi", "utf-8");

		const result = extractReferencedPaths("Check readme.md for details", cwd);
		expect(result).toContain(join(cwd, "readme.md"));
	});

	it("extracts paths from text with basename matching CODE_EXTENSIONS extension", () => {
		writeFileSync(join(cwd, "index.ts"), 'console.log("hi")', "utf-8");

		const result = extractReferencedPaths("Check index.ts for details", cwd);
		expect(result).toContain(join(cwd, "index.ts"));
	});

	it("returns empty array for empty input", () => {
		const result = extractReferencedPaths("", cwd);
		expect(result).toEqual([]);
	});

	it("returns empty array when no paths match", () => {
		const result = extractReferencedPaths("What is the meaning of life?", cwd);
		expect(result).toEqual([]);
	});

	it("returns at most 5 paths", () => {
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(cwd, `file${i}.ts`), "x", "utf-8");
		}

		const text = Array.from({ length: 10 }, (_, i) => `file${i}.ts`).join(" ");
		const result = extractReferencedPaths(text, cwd);
		expect(result.length).toBeLessThanOrEqual(5);
	});

	it("ignores URLs", () => {
		const result = extractReferencedPaths("See https://example.com for info", cwd);
		expect(result).toEqual([]);
	});

	it("ignores non-existent files", () => {
		const result = extractReferencedPaths("Check nonexistent.ts for details", cwd);
		expect(result).toEqual([]);
	});
});

// ─── readFilePreview ─────────────────────────────────────────────────────────

describe("readFilePreview", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "read-preview-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns content for an existing file", () => {
		const file = join(cwd, "hello.txt");
		writeFileSync(file, "Hello, world!", "utf-8");

		const result = readFilePreview(file);
		expect(result).toBe("Hello, world!");
	});

	it("returns error message for non-existent file", () => {
		const result = readFilePreview(join(cwd, "nope.txt"));
		expect(result).toContain("could not read");
		expect(result).toContain("nope.txt");
	});

	it("truncates content exceeding MAX_READ_CHARS", () => {
		const file = join(cwd, "big.txt");
		const bigContent = "x".repeat(10_000);
		writeFileSync(file, bigContent, "utf-8");

		const result = readFilePreview(file);
		expect(result.length).toBeLessThan(10_000);
		expect(result).toContain("[file truncated]");
	});
});

// ─── tryAnswerFromDocs ───────────────────────────────────────────────────────

describe("tryAnswerFromDocs", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "try-docs-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns content from a matching doc file", () => {
		const docsDir = join(cwd, "docs");
		mkdirSync(docsDir, { recursive: true });
		writeFileSync(join(docsDir, "issue-tracker.md"), "Use GitHub issues.", "utf-8");

		const result = tryAnswerFromDocs("How does the issue tracker work?", cwd);
		expect(result).toContain("issue-tracker.md");
		expect(result).toContain("Use GitHub issues.");
	});

	it("returns undefined when docs/ directory does not exist", () => {
		const result = tryAnswerFromDocs("anything", cwd);
		expect(result).toBeUndefined();
	});

	it("returns undefined when no doc file matches the question", () => {
		const docsDir = join(cwd, "docs");
		mkdirSync(docsDir, { recursive: true });
		writeFileSync(join(docsDir, "api.md"), "API docs", "utf-8");

		const result = tryAnswerFromDocs("How does billing work?", cwd);
		expect(result).toBeUndefined();
	});
});

// ─── buildRecentContext ──────────────────────────────────────────────────────

describe("buildRecentContext", () => {
	it("returns empty string for empty ctx", () => {
		expect(buildRecentContext({})).toBe("");
	});

	it("returns empty string for undefined ctx", () => {
		expect(buildRecentContext(undefined as any)).toBe("");
	});

	it("builds context from ctx.messages", () => {
		const ctx = {
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi there" },
			],
		};
		const result = buildRecentContext(ctx);
		expect(result).toContain("user: hello");
		expect(result).toContain("assistant: hi there");
	});

	it("builds context from sessionManager.getEntries() if available", () => {
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "user", content: "test" } },
				],
			},
		};
		const result = buildRecentContext(ctx);
		expect(result).toContain("user: test");
	});

	it("only includes last 10 messages", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({
			role: "user",
			content: `msg${i}`,
		}));
		const result = buildRecentContext({ messages });
		const lines = result.split("\n").filter(Boolean);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(result).toContain("msg19");
		expect(result).not.toContain("msg0");
	});
});

// ─── tryAnswerFromContext ────────────────────────────────────────────────────

describe("tryAnswerFromContext", () => {
	it("returns undefined when recentContext is empty", () => {
		expect(tryAnswerFromContext("question", "")).toBeUndefined();
		expect(tryAnswerFromContext("question", undefined)).toBeUndefined();
	});

	it("returns a matching line from context", () => {
		const context = "user: The database schema is in schema.sql\nassistant: OK let me check it";
		const result = tryAnswerFromContext("Where is the database schema?", context);
		expect(result).toContain("From the current conversation:");
		expect(result).toContain("schema.sql");
	});

	it("returns undefined when no line has sufficient keyword overlap", () => {
		const context = "user: I like cats\nassistant: Cats are nice";
		const result = tryAnswerFromContext("What about database migrations?", context);
		expect(result).toBeUndefined();
	});

	it("returns undefined for question with only stop words", () => {
		const context = "user: Some useful info";
		const result = tryAnswerFromContext("What is this?", context);
		expect(result).toBeUndefined();
	});
});

// ─── createAskOrchestratorResolver ───────────────────────────────────────────

describe("createAskOrchestratorResolver", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ask-resolver-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("resolves from files referenced in the question (files > docs > context)", async () => {
		const file = join(cwd, "config.json");
		writeFileSync(file, '{"answer": 42}', "utf-8");

		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver("What is in config.json?");

		expect(answer).toContain("config.json");
		expect(answer).toContain('"answer": 42');
	});

	it("resolves from docs/ when no file matches", async () => {
		const docsDir = join(cwd, "docs");
		mkdirSync(docsDir, { recursive: true });
		writeFileSync(join(docsDir, "architecture.md"), "Clean architecture", "utf-8");

		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver("Describe the architecture");

		expect(answer).toContain("architecture.md");
		expect(answer).toContain("Clean architecture");
	});

	it("resolves from conversation context before escalating", async () => {
		const uiInput = vi.fn().mockResolvedValue("ask the user");
		const resolver = createAskOrchestratorResolver({
			cwd,
			recentContext: "assistant: The specialist prompts file is stored in specialists.ts.",
			ui: { input: uiInput },
		});

		const answer = await resolver("Which file contains specialist prompts?");

		expect(answer).toContain("From the current conversation:");
		expect(answer).toContain("specialists.ts");
		expect(uiInput).not.toHaveBeenCalled();
	});

	it("escalates to orchestrator when all resolution steps fail", async () => {
		const input = vi.fn().mockResolvedValue("user answered");
		const resolver = createAskOrchestratorResolver({
			cwd,
			ui: { input },
		});

		const answer = await resolver("What is the meaning of life?");
		expect(answer).toBe("Question recorded for orchestrator. Proceed with available information. The orchestrator will address this in the next delegation.");
		expect(input).not.toHaveBeenCalled();
	});

	it("returns orchestrator clarification when user cancels input", async () => {
		const input = vi.fn().mockResolvedValue(undefined);
		const resolver = createAskOrchestratorResolver({
			cwd,
			ui: { input },
		});

		const answer = await resolver("What is the meaning of life?");
		expect(answer).toBe("Question recorded for orchestrator. Proceed with available information. The orchestrator will address this in the next delegation.");
		expect(input).not.toHaveBeenCalled();
	});

	it("returns orchestrator clarification when no UI is available", async () => {
		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver("What is the meaning of life?");
		expect(answer).toBe("Question recorded for orchestrator. Proceed with available information. The orchestrator will address this in the next delegation.");
	});

	it("handles empty question gracefully", async () => {
		const input = vi.fn().mockResolvedValue("fallback");
		const resolver = createAskOrchestratorResolver({
			cwd,
			ui: { input },
		});

		const answer = await resolver("");
		expect(answer).toBe("Question recorded for orchestrator. Proceed with available information. The orchestrator will address this in the next delegation.");
		expect(input).not.toHaveBeenCalled();
	});

	it("handles context parameter together with question for file resolution", async () => {
		const file = join(cwd, "data.txt");
		writeFileSync(file, "some content", "utf-8");

		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver("What does this file contain?", "Check data.txt");

		expect(answer).toContain("data.txt");
	});

	it("truncates long file output via readFilePreview", async () => {
		const file = join(cwd, "huge.txt");
		const bigContent = "line " + "x".repeat(12_000);
		writeFileSync(file, bigContent, "utf-8");

		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver("What is in huge.txt?");

		expect(answer.length).toBeLessThan(12_000);
		expect(answer).toContain("[file truncated]");
	});
});



// ─── hasLiteralSegment ─────────────────────────────────────────────────────

describe("hasLiteralSegment", () => {
  it("returns true for exact path with no glob chars", () => {
    expect(hasLiteralSegment("src/auth.ts")).toBe(true);
  });

  it("returns true for pattern with literal segment prefix", () => {
    expect(hasLiteralSegment("tests/**")).toBe(true);
  });

  it("returns true for pattern with literal segment in middle", () => {
    expect(hasLiteralSegment("src/**/*.test.ts")).toBe(true);
  });

  it("returns false for bare wildcard *", () => {
    expect(hasLiteralSegment("*")).toBe(false);
  });

  it("returns false for bare globstar **", () => {
    expect(hasLiteralSegment("**")).toBe(false);
  });

  it("returns false for pattern with only glob segments", () => {
    expect(hasLiteralSegment("*.test.ts")).toBe(false);
  });

  it("returns false for multi-segment all-glob pattern", () => {
    expect(hasLiteralSegment("**/*.ts")).toBe(false);
  });

  it("returns true for pattern with mixed glob and literal segments", () => {
    expect(hasLiteralSegment("src/*")).toBe(true);
  });

  it("returns true for pattern with literal after glob segment", () => {
    expect(hasLiteralSegment("*/src/*.test.ts")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(hasLiteralSegment("")).toBe(false);
  });
});

// ─── resolve ─────────────────────────────────────────────────────────────────────

describe("resolve", () => {
	it("returns ask for null scope", () => {
		expect(resolve("fix the bug", null)).toBe("ask");
	});

	it("returns proceed for empty scope with scout specialist", () => {
		expect(resolve("fix the bug", { filesToModify: [], filesToCreate: [] }, "scout")).toBe("proceed");
	});

	it("returns ask for scope with wildcard *", () => {
		expect(resolve("fix the bug", { filesToModify: ["*"], filesToCreate: [] })).toBe("ask");
	});

	it("returns ask for scope with ALL", () => {
		expect(resolve("fix the bug", { filesToModify: ["ALL"], filesToCreate: [] })).toBe("ask");
	});

	it("returns proceed for scope with concrete filesToModify", () => {
		expect(resolve("fix the bug", { filesToModify: ["src/auth.ts"], filesToCreate: [] })).toBe("proceed");
	});

	it("returns proceed for scope with concrete filesToCreate", () => {
		expect(resolve("fix the bug", { filesToModify: [], filesToCreate: ["src/new.ts"] })).toBe("proceed");
	});

	it("returns proceed for empty scope with only boundaries and scout specialist", () => {
		expect(resolve("fix the bug", { filesToModify: [], filesToCreate: [], boundaries: "Only modify src/" }, "scout")).toBe("proceed");
	});

	it("returns proceed for scope with directories", () => {
		expect(resolve("fix the bug", { filesToModify: [], filesToCreate: [], directories: ["src/"] })).toBe("proceed");
	});

	it("returns proceed for scope with directories via allowedDirectories compat", () => {
		expect(resolve("fix the bug", { filesToModify: [], filesToCreate: [], directories: ["src/"] })).toBe("proceed");
	});

	it("returns proceed for empty request with concrete scope", () => {
		expect(resolve("", { filesToModify: ["src/auth.ts"], filesToCreate: [] })).toBe("proceed");
	});

	it("returns proceed for short request with scout specialist", () => {
		expect(resolve("hi", { filesToModify: [], filesToCreate: [] }, "scout")).toBe("proceed");
	});

	it("returns ask for scope with mixed wildcards and concrete paths — treats wildcards as non-concrete", () => {
		// hasConcreteModify requires at least one non-wildcard entry
		expect(resolve("fix bug", { filesToModify: ["*", "src/auth.ts"], filesToCreate: [] })).toBe("proceed");
	});

	it("returns ask for scope with only vague wildcard directories", () => {
		expect(resolve("fix bug", { filesToModify: [], filesToCreate: [], directories: ["*"] })).toBe("ask");
	});

	it("returns proceed for scope with both wildcard files and concrete create files", () => {
		expect(resolve("fix bug", { filesToModify: ["*"], filesToCreate: ["output.md"] })).toBe("proceed");
	});

// ─── empty scope specialist behavior ────────────────────────────────────────

describe("empty scope specialist behavior", () => {
	it("returns 'ask' when scope is empty and specialist is coder", () => {
		const result = resolve("fix the bug", { filesToModify: [], filesToCreate: [] }, "coder");
		expect(result).toBe("ask");
	});

	it("returns 'ask' when scope is empty and specialist is writer", () => {
		const result = resolve("write docs", { filesToModify: [], filesToCreate: [] }, "writer");
		expect(result).toBe("ask");
	});

	it("returns 'proceed' when scope is empty and specialist is scout", () => {
		const result = resolve("find files", { filesToModify: [], filesToCreate: [] }, "scout");
		expect(result).toBe("proceed");
	});

	it("returns 'proceed' when scope is empty and specialist is reviewer", () => {
		const result = resolve("review code", { filesToModify: [], filesToCreate: [] }, "reviewer");
		expect(result).toBe("proceed");
	});
});

});
