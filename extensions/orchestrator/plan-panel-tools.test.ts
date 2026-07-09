import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	setupPlanPanel,
	completePlanStep,
	clearPlanPanel,
	hasActivePlan,
	inspectPlanState,
	getPlanState,
	modifyStep,
	removeStep,
	startDelegationStep,
} from "./plan-panel.ts";

interface PlanState {
	goal: string;
	steps: Array<{
		index: number;
		label: string;
		state: string;
		substepCount: number;
		detail: string | null;
		startTime: number | null;
	}>;
	completedCount: number;
	totalCount: number;
	activeDelegations: number;
	elapsedMs: number;
}

function mockCtx() {
	const setWidget = vi.fn();
	return {
		sessionManager: { sessionId: "plan-panel-tools-test" },
		ui: { setWidget },
	};
}

function getState(ctx: ReturnType<typeof mockCtx>): PlanState {
	return inspectPlanState(ctx) as unknown as PlanState;
}

/** Replicates insert_step tool logic — splices steps after matching label. */
function insertStepTool(labels: string[], afterLabel: string, ctx: ReturnType<typeof mockCtx>) {
	const state = getPlanState(ctx);
	if (!state) return "No active plan";
	const afterIdx = state.steps.findIndex(s => s.label === afterLabel);
	if (afterIdx < 0) return `Step '${afterLabel}' not found`;
	let inserted = 0;
	for (const label of labels) {
		if (state.steps.some(s => s.label === label)) continue;
		state.steps.splice(afterIdx + 1 + inserted, 0, {
			label, completed: false, errored: false, active: false, startTime: Date.now(),
		});
		inserted++;
	}
	return `Inserted ${inserted}`;
}

// ─── insert_step ────────────────────────────────────────────────

describe("insert_step", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		ctx = mockCtx();
		if (hasActivePlan(ctx)) clearPlanPanel(ctx);
	});

	it("inserts before active step — active step index shifts", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");

		insertStepTool(["X"], "A", ctx);
		const state = getState(ctx);
		expect(state.totalCount).toBe(4);
		expect(state.steps[0].label).toBe("A");
		expect(state.steps[1].label).toBe("X");
		expect(state.steps[2].label).toBe("B");
		expect(state.steps[3].label).toBe("C");
		expect(state.steps[0].state).toBe("active");
	});

	it("inserts after active step — no shift for active", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		insertStepTool(["Y"], "B", ctx);
		const state = getState(ctx);
		expect(state.totalCount).toBe(4);
		expect(state.steps[0].label).toBe("A");
		expect(state.steps[1].label).toBe("B");
		expect(state.steps[2].label).toBe("Y");
		expect(state.steps[3].label).toBe("C");
		expect(state.steps[0].state).toBe("active");
	});

	it("skips duplicate labels", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		insertStepTool(["B"], "A", ctx);
		expect(getState(ctx).totalCount).toBe(2);
	});

	it("returns error when 'after' label not found", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		const result = insertStepTool(["X"], "Z", ctx);
		expect(result).toContain("not found");
	});

	it("returns error when no active plan", () => {
		const result = insertStepTool(["X"], "A", ctx);
		expect(result).toContain("No active plan");
	});
});

// ─── remove_step ────────────────────────────────────────────────

describe("remove_step", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		ctx = mockCtx();
		if (hasActivePlan(ctx)) clearPlanPanel(ctx);
	});

	it("removes pending step — indices shift", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		const result = removeStep(2, ctx);
		expect(result).toEqual({ success: true });
		const state = getState(ctx);
		expect(state.totalCount).toBe(2);
		expect(state.steps[0].label).toBe("A");
		expect(state.steps[1].label).toBe("C");
		expect(state.steps[0].state).toBe("active");
	});

	it("refuses to remove active step", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		const result = removeStep(1, ctx);
		expect(result).toEqual({ success: false, error: "Cannot remove active step" });
		expect(getState(ctx).totalCount).toBe(2);
	});

	it("removes completed step", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		completePlanStep(ctx); // complete A (step 0)
		const stateBefore = getState(ctx);
		expect(stateBefore.steps[0].state).toBe("completed");
		expect(stateBefore.steps[1].state).toBe("active");

		const result = removeStep(1, ctx);
		expect(result).toEqual({ success: true });
		const stateAfter = getState(ctx);
		expect(stateAfter.totalCount).toBe(2);
		expect(stateAfter.steps[0].label).toBe("B");
		expect(stateAfter.steps[0].state).toBe("active");
		expect(stateAfter.steps[1].label).toBe("C");
	});

	it("returns error for out-of-range index", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		const result = removeStep(5, ctx);
		expect(result.success).toBe(false);
		expect(result.error).toContain("out of range");
	});

	it("returns error for index 0", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		const result = removeStep(0, ctx);
		expect(result.success).toBe(false);
		expect(result.error).toContain("out of range");
	});

	it("returns error when no active plan", () => {
		const result = removeStep(1, ctx);
		expect(result).toEqual({ success: false, error: "No active plan" });
	});
});

// ─── modify_step ────────────────────────────────────────────────

describe("modify_step", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		ctx = mockCtx();
		if (hasActivePlan(ctx)) clearPlanPanel(ctx);
	});

	it("modifies label", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		const result = modifyStep(1, "A Revised", undefined, ctx);
		expect(result).toEqual({ success: true });
		const state = getState(ctx);
		expect(state.steps[0].label).toBe("A Revised");
		expect(state.steps[1].label).toBe("B");
	});

	it("modifies kind", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		const result = modifyStep(1, "A", "delegation", ctx);
		expect(result).toEqual({ success: true });
	});

	it("returns error for out-of-range index", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		const result = modifyStep(5, "X", undefined, ctx);
		expect(result.success).toBe(false);
		expect(result.error).toContain("out of range");
	});

	it("returns error when no active plan", () => {
		const result = modifyStep(1, "X", undefined, ctx);
		expect(result).toEqual({ success: false, error: "No active plan" });
	});
});

// ─── widget refresh ─────────────────────────────────────────────

describe("widget refresh after mutation", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		ctx = mockCtx();
		if (hasActivePlan(ctx)) clearPlanPanel(ctx);
	});

	it("setWidget called after modifyStep", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		ctx.ui.setWidget.mockClear();
		modifyStep(1, "A Revised", undefined, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalled();
	});

	it("setWidget called after removeStep", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		ctx.ui.setWidget.mockClear();
		removeStep(2, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalled();
	});
});

// ─── startDelegationStep label preservation ──────────────────

describe("startDelegationStep label preservation", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		ctx = mockCtx();
		if (hasActivePlan(ctx)) clearPlanPanel(ctx);
	});

	it("does NOT overwrite the original step label", () => {
		setupPlanPanel("Goal", ["My Step"], ctx);
		startDelegationStep("Delegation Label", ctx);
		const state = getState(ctx);
		expect(state.steps[0].label).toBe("My Step");
		expect(state.steps[0].state).toBe("active");
	});
});
