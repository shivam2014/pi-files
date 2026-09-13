/**
 * Semantic label compression — replaces character truncation for auto-created
 * plan labels with a meaningful first-clause summary.
 *
 * Covers:
 *  - compressTaskToLabel: natural-boundary extraction (em-dash / colon / newline /
 *    sentence end), word-boundary last resort, capitalization, filler stripping
 *  - buildAutoPlanLabels: semantic fallback + explicit `label` override
 *  - buildBatchStepLabel: batch entries get the same semantic labels
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./orchestrator-theme.ts", () => ({
	getTheme: vi.fn(() => ({
		fg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
		bg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
	})),
	statusIcon: vi.fn((_status: string) => "*"),
	styledSymbol: vi.fn((_key: string) => "*"),
	formatDuration: vi.fn((ms: number) => `${ms}ms`),
	formatTokens: vi.fn((count: number) => `${count}`),
	partialStrikethrough: vi.fn((text: string) => text),
	initTheme: vi.fn(),
	SYMBOLS: {
		"token.input": "↑",
		"token.output": "↓",
		"token.cacheRead": "⇄",
	},
}));

import {
	buildAutoPlanLabels,
	buildBatchStepLabel,
	compressTaskToLabel,
	capAtWordBoundary,
	AUTO_PLAN_LABEL_MAX,
} from "./delegate-pipeline.ts";

describe("compressTaskToLabel — semantic first-clause extraction", () => {
	it("(a) splits at an em-dash boundary and returns the first clause (not a cut-off)", () => {
		const task =
			"Health-check the pi-files orchestrator — verify it actually WORKS end-to-end before we package it. Do NOT modify source files.";
		expect(compressTaskToLabel(task)).toBe("Health-check the pi-files orchestrator");
	});

	it("(a) buildAutoPlanLabels summarizes the same em-dash task, no 60-char cut", () => {
		const task =
			"Health-check the pi-files orchestrator — verify it actually WORKS end-to-end before we package it. Do NOT modify source files.";
		const { stepLabel, autoGoal } = buildAutoPlanLabels("reviewer", "Reviewer", task);
		expect(stepLabel).toBe("Reviewer: Health-check the pi-files orchestrator");
		expect(autoGoal).toBe("delegate to reviewer: Health-check the pi-files orchestrator");
		expect(stepLabel.length).toBeLessThanOrEqual(AUTO_PLAN_LABEL_MAX);
		expect(stepLabel).not.toContain("verify it actually WORKS");
	});

	it("(c) splits at a colon boundary", () => {
		const task = "Sync files to repo: copy, stage, commit, then push to origin";
		expect(compressTaskToLabel(task)).toBe("Sync files to repo");
	});

	it("splits at a newline boundary", () => {
		const task = "Diagnose the failing test\nThen report the root cause in detail";
		expect(compressTaskToLabel(task)).toBe("Diagnose the failing test");
	});

	it("splits at a sentence-end boundary (`. `)", () => {
		const task = "Fix the auth bug. Also add a regression test for it.";
		expect(compressTaskToLabel(task)).toBe("Fix the auth bug");
	});

	it("strips a lone terminal period from a single-sentence task", () => {
		expect(compressTaskToLabel("Fix the auth bug.")).toBe("Fix the auth bug");
	});

	it("collapses whitespace/newlines and capitalizes sensibly", () => {
		expect(compressTaskToLabel("   fix   the    auth bug   ")).toBe("Fix the auth bug");
		expect(compressTaskToLabel("   fix   the\n\n auth bug   ")).toBe("Fix the");
	});

	it("returns a stable placeholder for empty input", () => {
		expect(compressTaskToLabel("   \n  ")).toBe("task");
	});
});

describe("compressTaskToLabel — word-boundary last resort", () => {
	it("(b) cuts a long single-clause task at a WORD boundary with an ellipsis, never mid-word", () => {
		const task =
			"Implement a comprehensive and thoroughly documented authentication refactor across the entire codebase without any breaks";
		const out = compressTaskToLabel(task);

		expect(out.length).toBeLessThanOrEqual(AUTO_PLAN_LABEL_MAX);
		expect(out.endsWith("…")).toBe(true);

		const body = out.slice(0, -1); // strip ellipsis
		expect(body.endsWith(" ")).toBe(false);
		// The final token must be a complete word that exists in the source task.
		const lastWord = body.slice(body.lastIndexOf(" ") + 1);
		expect(task.split(/\s+/)).toContain(lastWord);
	});

	it("never emits a partial word even for a very long first word", () => {
		// A single token longer than the cap has no word boundary; it is the only
		// case where a hard cut is unavoidable, and it must still be capped.
		const out = capAtWordBoundary("x".repeat(200), AUTO_PLAN_LABEL_MAX);
		expect(out.length).toBeLessThanOrEqual(AUTO_PLAN_LABEL_MAX);
	});
});

describe("buildAutoPlanLabels — explicit label override", () => {
	it("(d) uses an explicit label verbatim (ignoring the raw task)", () => {
		const { stepLabel, autoGoal } = buildAutoPlanLabels(
			"coder",
			"Coder",
			"some very long raw task that would compress semantically weirdly and at length",
			"Health-check orchestrator",
		);
		expect(stepLabel).toBe("Coder: Health-check orchestrator");
		expect(autoGoal).toBe("delegate to coder: Health-check orchestrator");
		expect(stepLabel).not.toContain("some very long raw task");
	});

	it("(d) caps an over-long explicit label at a word boundary", () => {
		const longLabel = "word ".repeat(30).trim(); // 149 chars
		const { stepLabel } = buildAutoPlanLabels("coder", "Coder", "irrelevant task", longLabel);
		expect(stepLabel.length).toBeLessThanOrEqual(AUTO_PLAN_LABEL_MAX);
		expect(stepLabel.endsWith("…")).toBe(true);
		expect(stepLabel.startsWith("Coder: word")).toBe(true);
	});

	it("falls back to the semantic summary when the label is blank", () => {
		const { stepLabel } = buildAutoPlanLabels("scout", "Scout", "find auth bug — then report", "   ");
		expect(stepLabel).toBe("Scout: Find auth bug");
	});
});

describe("buildBatchStepLabel — batch entries get semantic labels", () => {
	it("(e) derives a semantic label for a batch entry", () => {
		expect(
			buildBatchStepLabel("scout", "Investigate the auth middleware thoroughly — report all issues"),
		).toBe("Scout: Investigate the auth middleware thoroughly");
	});

	it("(e) honors an explicit batch-entry label and caps at the max", () => {
		expect(buildBatchStepLabel("coder", "Fix the login bug", "Fix login")).toBe("Coder: Fix login");

		const longTask = "Audit every module ".repeat(10).trim();
		const out = buildBatchStepLabel("reviewer", longTask);
		expect(out.length).toBeLessThanOrEqual(AUTO_PLAN_LABEL_MAX);
		expect(out.startsWith("Reviewer: ")).toBe(true);
	});
});
