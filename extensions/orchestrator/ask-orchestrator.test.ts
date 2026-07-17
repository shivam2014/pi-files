/**
 * Tests for ask_orchestrator resolver and custom tool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAskOrchestratorResolver } from "./delegate-tool.ts";
import { createAskOrchestratorTool } from "./subagent-runner.ts";
import { ActivityFeed } from "./activity-feed.ts";

describe("createAskOrchestratorResolver", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ask-orchestrator-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("answers from a file referenced in the question", async () => {
		const file = join(cwd, "config.json");
		writeFileSync(file, '{"answer": 42}', "utf-8");

		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver(`What is in config.json?`);

		expect(answer).toContain("config.json");
		expect(answer).toContain('"answer": 42');
	});

	it("answers from a file referenced only by basename", async () => {
		const file = join(cwd, "readme.md");
		writeFileSync(file, "# Hello", "utf-8");

		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver("What does readme.md say?");

		expect(answer).toContain("# Hello");
	});

	it("answers from docs/ when the question matches a doc filename", async () => {
		const docsDir = join(cwd, "docs");
		mkdirSync(docsDir, { recursive: true });
		writeFileSync(join(docsDir, "issue-tracker.md"), "Use GitHub issues.", "utf-8");

		const resolver = createAskOrchestratorResolver({ cwd });
		const answer = await resolver("How does the issue tracker work?");

		expect(answer).toContain("issue-tracker.md");
		expect(answer).toContain("Use GitHub issues.");
	});

	it("answers from recent conversation context before escalating", async () => {
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

	it("escalates to the orchestrator when no file or doc matches", async () => {
		const input = vi.fn().mockResolvedValue("ask the user");
		const resolver = createAskOrchestratorResolver({
			cwd,
			ui: { input },
		});

		const answer = await resolver("What is the meaning of life?");

		expect(answer).toBe("Question recorded for orchestrator. Proceed with available information. The orchestrator will address this in the next delegation.");
		expect(input).not.toHaveBeenCalled();
	});

	it("returns orchestrator clarification when the user cancels input", async () => {
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
});

describe("createAskOrchestratorTool", () => {
	it("resolves the question, renames pending Clarify substep to Clarified, and emits updates", async () => {
		const feed = new ActivityFeed();
		feed.addStep("Step 1").addSubstep("Clarify: what color?");

		const updates: any[] = [];
		const tool = createAskOrchestratorTool(
			async () => "blue",
			(u) => updates.push(u),
			"coder",
			feed,
		);

		const result = await (tool.execute as any)("call-1", { question: "what color?", context: "" }, undefined, () => {}, {});

		expect((result.content[0] as any).text).toBe("blue");
		expect(updates.some((u) => u.details?.status === "clarifying")).toBe(true);
		expect(updates.some((u) => u.details?.status === "clarified" && u.details?.answer === "blue")).toBe(true);

		const substep = feed.steps[0].substeps[0];
		expect(substep.completed).toBe(true);
		expect(substep.label).toBe("Clarified: blue");
		expect(substep.outputPreview).toBe("blue");
		expect(substep.isReport).toBe(true);
	});

	it("returns an error when no resolver is wired", async () => {
		const tool = createAskOrchestratorTool(undefined, undefined, "coder", new ActivityFeed());

		const result = await (tool.execute as any)("call-1", { question: "hello?" }, undefined, () => {}, {});

		expect((result.content[0] as any).text).toContain("not wired");
	});
});
