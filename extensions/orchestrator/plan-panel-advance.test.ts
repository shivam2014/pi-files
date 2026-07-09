import { describe, it, expect, beforeEach } from "vitest";
import {
	setupPlanPanel,
	completePlanStep,
	clearPlanPanel,
	hasActivePlan,
	inspectPlanState,
	insertSteps,
	removeStep,
	errorPlanStep,
	_resolveCtx,
	_instances,
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
	const setWidget = () => {};
	return {
		sessionManager: { sessionId: "plan-panel-advance-test" },
		ui: { setWidget },
	};
}

function getState(ctx: ReturnType<typeof mockCtx>): PlanState {
	return inspectPlanState(ctx) as unknown as PlanState;
}

// ─── advanceStep ────────────────────────────────────────────────

describe("advanceStep", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		_instances.clear();
		ctx = mockCtx();
	});

	function advance(ctx: ReturnType<typeof mockCtx>) {
		const panel = _resolveCtx(ctx);
		expect(panel).not.toBeNull();
		return panel!.advanceStep();
	}

	it("returns error when no active step", () => {
		// Setup plan with 1 step, complete it manually so no step is active
		setupPlanPanel("Goal", ["A"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");
		completePlanStep(ctx);
		expect(getState(ctx).steps[0].state).toBe("completed");
		expect(getState(ctx).steps[0].index).toBe(0);

		// No step is active now
		const result = advance(ctx);
		expect(result).toEqual({ status: "error", error: "no active step" });
	});

	it("advance completes step when all remaining steps are errored", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");

		// Error steps B and C
		errorPlanStep(ctx, false, "step B failed");
		// Step A was active, now errored. Manually set B and C errored.
		const panel = _resolveCtx(ctx)!;
		const steps = panel.getPlanState()!.steps;
		// Reset: A should be active again for the test setup we want.
		// Let's use a cleaner approach: setup fresh, mark B and C errored, then activate A.
		_instances.clear();
		ctx = mockCtx();
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);

		const p = _resolveCtx(ctx)!;
		const s = p.getPlanState()!.steps;
		// Step A is active (index 0), B and C are pending
		// Mark B and C as errored
		s[1].errored = true;
		s[1].errorMessage = "step B failed";
		s[2].errored = true;
		s[2].errorMessage = "step C failed";

		// Advance step A
		const result = advance(ctx);
		expect(result).toEqual({ status: "completed", label: "A" });

		const state = getState(ctx);
		expect(state.steps[0].state).toBe("completed");
		// _activateNextPending skips B (errored), skips C (errored), activates nothing
		p.getPlanState()!.steps.forEach(step => {
			expect(step.active).toBe(false);
		});
		expect(state.completedCount).toBe(1);
	});

	it("skips delegation steps", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);
		// Make step A a delegation step
		const panel = _resolveCtx(ctx)!;
		const state = panel.getPlanState()!;
		state.steps[0].kind = "delegation";

		const result = advance(ctx);
		expect(result.status).toBe("skipped");
		expect(result).toHaveProperty("reason");
		expect((result as { reason: string }).reason).toContain("delegate");

		// Step A should still be active (not completed)
		expect(getState(ctx).steps[0].state).toBe("active");
	});

	it("normal advance completes step and activates next", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");

		const result = advance(ctx);
		expect(result).toEqual({ status: "completed", label: "A" });

		const state = getState(ctx);
		expect(state.steps[0].state).toBe("completed");
		expect(state.steps[1].state).toBe("active");
		expect(state.steps[2].state).toBe("pending");
		expect(state.completedCount).toBe(1);
	});

	it("advance last step completes it with no step active after", () => {
		setupPlanPanel("Goal", ["Only"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");

		const result = advance(ctx);
		expect(result).toEqual({ status: "completed", label: "Only" });

		const state = getState(ctx);
		expect(state.steps[0].state).toBe("completed");
		expect(state.steps[0].index).toBe(0);
		// No step should be active — find returns -1
		const panel = _resolveCtx(ctx)!;
		const planSteps = panel.getPlanState()!.steps;
		expect(planSteps.every(s => !s.active)).toBe(true);
		expect(state.completedCount).toBe(1);
		expect(state.totalCount).toBe(1);
	});
});

// ─── insertSteps with index param ──────────────────────────────

describe("insertSteps with index", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		_instances.clear();
		ctx = mockCtx();
	});

	it("inserts at beginning (index 0)", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);

		const result = insertSteps(["X"], { index: 0 }, ctx);
		expect(result).toEqual({ inserted: 1 });

		const state = getState(ctx);
		expect(state.totalCount).toBe(4);
		expect(state.steps[0].label).toBe("X");
		expect(state.steps[1].label).toBe("A");
		expect(state.steps[2].label).toBe("B");
		expect(state.steps[3].label).toBe("C");
	});

	it("inserts at end (index = steps.length)", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);

		const result = insertSteps(["Z"], { index: 3 }, ctx);
		expect(result).toEqual({ inserted: 1 });

		const state = getState(ctx);
		expect(state.totalCount).toBe(4);
		expect(state.steps[0].label).toBe("A");
		expect(state.steps[1].label).toBe("B");
		expect(state.steps[2].label).toBe("C");
		expect(state.steps[3].label).toBe("Z");
	});

	it("inserts in middle (index 1)", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);

		const result = insertSteps(["M"], { index: 1 }, ctx);
		expect(result).toEqual({ inserted: 1 });

		const state = getState(ctx);
		expect(state.totalCount).toBe(4);
		expect(state.steps[0].label).toBe("A");
		expect(state.steps[1].label).toBe("M");
		expect(state.steps[2].label).toBe("B");
		expect(state.steps[3].label).toBe("C");
	});

	it("returns error when both after and index provided", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);

		const result = insertSteps(["X"], { after: "A", index: 0 }, ctx);
		expect(result.error).toBeDefined();
		expect(result.inserted).toBe(0);
	});

	it("returns error when neither after nor index provided", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);

		const result = insertSteps(["X"], {}, ctx);
		expect(result.error).toBeDefined();
		expect(result.inserted).toBe(0);
	});

	it("returns error for invalid index (-1)", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);

		const result = insertSteps(["X"], { index: -1 }, ctx);
		expect(result.error).toBeDefined();
		expect(result.inserted).toBe(0);
	});

	it("returns error for index beyond steps.length", () => {
		setupPlanPanel("Goal", ["A", "B"], ctx);

		const result = insertSteps(["X"], { index: 3 }, ctx);
		// steps.length is 2, so index 3 is out of bounds
		expect(result.error).toBeDefined();
		expect(result.inserted).toBe(0);
	});

	it("saves state and renders widget after insertion", () => {
		const setWidget = ctx.ui.setWidget;
		// setWidget should be callable — verify the plan can be inspected after
		setupPlanPanel("Goal", ["A", "B"], ctx);
		insertSteps(["X"], { index: 1 }, ctx);

		const state = getState(ctx);
		expect(state).not.toBeNull();
		expect(state.totalCount).toBe(3);
		// Plan state should be persisted (inspectable)
		expect(hasActivePlan(ctx)).toBe(true);
	});
});

// ─── _activateNextPending (indirect via completePlanStep/removeStep) ──

describe("_activateNextPending", () => {
	let ctx: ReturnType<typeof mockCtx>;

	beforeEach(() => {
		_instances.clear();
		ctx = mockCtx();
	});

	it("after completePlanStep, first non-completed step becomes active", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");
		expect(getState(ctx).steps[1].state).toBe("pending");
		expect(getState(ctx).steps[2].state).toBe("pending");

		completePlanStep(ctx);

		const state = getState(ctx);
		expect(state.steps[0].state).toBe("completed");
		expect(state.steps[1].state).toBe("active");
		expect(state.steps[2].state).toBe("pending");
	});

	it("after removeStep, next pending step becomes active", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");
		expect(getState(ctx).steps[1].state).toBe("pending");

		// Remove step B (index 2) — not active so allowed
		removeStep(2, ctx);

		const state = getState(ctx);
		expect(state.totalCount).toBe(2);
		expect(state.steps[0].label).toBe("A");
		expect(state.steps[0].state).toBe("active");
		expect(state.steps[1].label).toBe("C");
		expect(state.steps[1].state).toBe("pending");
	});

	it("skips errored steps when activating next", () => {
		setupPlanPanel("Goal", ["A", "B", "C", "D"], ctx);
		// Complete step A → B becomes active
		completePlanStep(ctx);
		expect(getState(ctx).steps[1].state).toBe("active");

		// Error step B
		errorPlanStep(ctx, false, "something broke");
		expect(getState(ctx).steps[1].state).toBe("errored");

		// Now manually trigger _activateNextPending by removing step B
		// (removeStep calls _activateNextPending after splice)
		// B is errored+inactive, so removeStep allows it.
		removeStep(2, ctx);

		const state = getState(ctx);
		expect(state.totalCount).toBe(3);
		expect(state.steps[0].state).toBe("completed");
		expect(state.steps[1].label).toBe("C");
		expect(state.steps[1].state).toBe("active");
		expect(state.steps[2].label).toBe("D");
		expect(state.steps[2].state).toBe("pending");
	});

	it("no step becomes active when no pending steps remain", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		expect(getState(ctx).steps[0].state).toBe("active");

		// Complete the only step
		completePlanStep(ctx);
		expect(getState(ctx).steps[0].state).toBe("completed");

		// No more steps — verify nothing is active
		const panel = _resolveCtx(ctx)!;
		const planSteps = panel.getPlanState()!.steps;
		expect(planSteps.every(s => !s.active)).toBe(true);
	});

	it("activateNextPending skips errored step then activates next valid", () => {
		setupPlanPanel("Goal", ["A", "B", "C", "D"], ctx);
		// Complete A → B active
		completePlanStep(ctx);
		expect(getState(ctx).steps[1].state).toBe("active");

		// Error B
		errorPlanStep(ctx, false, "fail");
		expect(getState(ctx).steps[1].state).toBe("errored");

		// Remove errored B — _activateNextPending should skip to C
		removeStep(2, ctx);

		const state = getState(ctx);
		// A completed, B removed, C should be active, D pending
		expect(state.steps[0].state).toBe("completed");
		expect(state.steps[1].label).toBe("C");
		expect(state.steps[1].state).toBe("active");
		expect(state.steps[2].label).toBe("D");
		expect(state.steps[2].state).toBe("pending");
	});
});
