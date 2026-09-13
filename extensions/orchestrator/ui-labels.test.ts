/**
 * FIX 1–5 regression tests — UI/label bugs found in a read-only audit.
 *
 * Covers:
 *  - FIX 1: delegate-pipeline auto-plan goal/step label is shortened
 *  - FIX 2: activity-feed truncates an over-long goal before rendering
 *  - FIX 3: plan-panel rendered output obeys the line budget
 *  - FIX 5: activity-feed omits fake placeholders when a tool arg is missing
 *
 * (FIX 4 — lint-substep gating — lives in subagent-runner.test.ts, which owns
 * the SubagentRunner controllable harness.)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

import { buildAutoPlanLabels, AUTO_PLAN_LABEL_MAX } from "./delegate-pipeline.ts";
import { renderActivityFeed, toolCallToSubstep } from "./activity-feed.ts";
import {
	setupPlanPanel,
	getPlanState,
	updatePlanStepDetail,
	snapshotPlanRender,
	_instances,
} from "./plan-panel.ts";

describe("FIX 1 — delegate-pipeline auto-plan labels are shortened", () => {
	it("caps step label and goal for a very long task (no raw task leaked)", () => {
		const longTask =
			"Investigate the authentication middleware thoroughly and report every single problem you can find in exhaustive detail ".repeat(4);
		const { stepLabel, autoGoal } = buildAutoPlanLabels("coder", "Coder", longTask);

		expect(stepLabel.length).toBeLessThanOrEqual(AUTO_PLAN_LABEL_MAX);
		expect(autoGoal.length).toBeLessThanOrEqual(AUTO_PLAN_LABEL_MAX);
		// The raw unbounded task must never appear verbatim in either label/goal.
		expect(autoGoal.includes(longTask)).toBe(false);
		expect(stepLabel.includes(longTask)).toBe(false);
		expect(autoGoal.startsWith("delegate to coder:")).toBe(true);
		expect(stepLabel.startsWith("Coder:")).toBe(true);
	});

	it("keeps short tasks intact", () => {
		const { stepLabel, autoGoal } = buildAutoPlanLabels("scout", "Scout", "find auth bug");
		expect(stepLabel).toContain("Scout:");
		expect(autoGoal).toContain("delegate to scout:");
	});
});

describe("FIX 2 — activity-feed truncates an over-long goal", () => {
	it("truncates the goal on the normal render path", () => {
		const longGoal = "Z".repeat(200);
		const state = { goal: longGoal, steps: [], currentStep: -1, errored: false } as any;
		const firstLine = renderActivityFeed("t", state).split("\n")[0];

		expect(firstLine.includes(longGoal)).toBe(false);
		expect(firstLine.endsWith("…")).toBe(true);
		// rendered as: <symbol(1)> + space + capAtWordBoundary(..., MAX_GOAL_LABEL=60)
		expect(firstLine.length).toBeLessThanOrEqual(2 + 60);
	});

	it("truncates the goal on the errored render path", () => {
		const longGoal = "Z".repeat(200);
		const state = {
			goal: longGoal,
			steps: [],
			currentStep: -1,
			errored: true,
			errorMessage: "boom",
		} as any;
		const firstLine = renderActivityFeed("t", state).split("\n")[0];

		expect(firstLine.includes(longGoal)).toBe(false);
		expect(firstLine.endsWith("…")).toBe(true);
	});

	it("renders an exactly-60-char auto-goal whole (no mid-word ellipsis)", () => {
		const goal = "delegate to reviewer: Health-check the pi-files orchestrator";
		expect(goal.length).toBe(60);
		const state = { goal, steps: [], currentStep: -1, errored: false } as any;
		const firstLine = renderActivityFeed("t", state).split("\n")[0];
		// The semantically-compressed 60-char auto-goal must pass through whole.
		expect(firstLine.includes(goal)).toBe(true);
		expect(firstLine.endsWith("…")).toBe(false);
	});

	it("cuts a longer goal between words (no mid-word clip)", () => {
		const goal = "delegate to reviewer: Health-check the pi-files orchestrator thoroughly";
		const state = { goal, steps: [], currentStep: -1, errored: false } as any;
		const firstLine = renderActivityFeed("t", state).split("\n")[0];
		const label = firstLine.slice(2); // strip "<symbol> "
		expect(label.endsWith("…")).toBe(true);
		// Cut lands on a word boundary: the retained prefix is a real prefix of
		// the goal and the very next char in the goal is the space we cut at.
		const kept = label.slice(0, -1);
		expect(goal.startsWith(kept)).toBe(true);
		expect(goal.charAt(kept.length)).toBe(" ");
		// No mid-word clip such as the old "orchest…".
		expect(label.includes("orchest…")).toBe(false);
	});
});

describe("FIX 3 — plan-panel rendered line budget", () => {
	const mockCtx = () => ({
		sessionManager: { sessionId: "ui-labels-budget" },
		ui: { setWidget: vi.fn() },
	});

	beforeEach(() => {
		_instances.clear();
	});

	it("caps total rendered lines even when one step has many substeps", () => {
		const ctx = mockCtx();
		setupPlanPanel("Goal line", ["Step A"], ctx);

		const state = getPlanState(ctx)!;
		state.steps[0].active = true;
		state.steps[0].completed = false;

		const manySubsteps = Array.from({ length: 25 }, (_, i) => `    ○ substep ${i}`);
		updatePlanStepDetail(manySubsteps, ctx);

		const rendered = (snapshotPlanRender(ctx) ?? "").split("\n");

		// BUDGET is 9 — output must never exceed it.
		expect(rendered.length).toBeLessThanOrEqual(9);
		// Goal line (index 0) is always kept.
		expect(rendered[0]).toContain("Goal line");
	});
});

describe("FIX 5 — activity-feed omits fake placeholders", () => {
	it("omits placeholder text when the arg is missing", () => {
		expect(toolCallToSubstep("grep", {})).toBe("Searching");
		expect(toolCallToSubstep("find", {})).toBe("Finding");
		expect(toolCallToSubstep("lint", {})).toBe("Linting");
	});

	it("still prints the real arg when present", () => {
		expect(toolCallToSubstep("grep", { pattern: "foo" })).toBe("Searching: foo");
		expect(toolCallToSubstep("find", { pattern: "bar" })).toBe("Finding: bar");
		expect(toolCallToSubstep("lint", { path: "a.ts" })).toBe("Linting a.ts");
	});
});
