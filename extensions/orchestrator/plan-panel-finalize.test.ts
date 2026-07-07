import { describe, it, expect, beforeEach } from "vitest";
import {
	setupPlanPanel,
	completePlanStep,
	finalizePlanStep,
	clearPlanIfComplete,
	clearPlanPanel,
	hasActivePlan,
	inspectPlanState,
	addSteps,
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
	const setWidget = (_key: string, _content: string[] | undefined) => {};
	return {
		sessionManager: { sessionId: "plan-panel-finalize-test" },
		ui: { setWidget },
	};
}

describe("finalizePlanStep matches completePlanStep", () => {
	beforeEach(() => {
		if (hasActivePlan(mockCtx())) {
			completePlanStep(mockCtx());
		}
	});

	it("both functions exist and are callable", () => {
		expect(completePlanStep).toBeDefined();
		expect(finalizePlanStep).toBeDefined();
		expect(typeof completePlanStep).toBe("function");
		expect(typeof finalizePlanStep).toBe("function");
	});

	it("both guard against no active plan (no throw)", () => {
		expect(() => completePlanStep(mockCtx())).not.toThrow();
		expect(() => finalizePlanStep(mockCtx())).not.toThrow();
	});

	it("both produce identical step state after completing a step", () => {
		setupPlanPanel("Test goal", ["Step A", "Step B"], mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(true);

		finalizePlanStep(mockCtx());

		const stateAfterFinalize = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(stateAfterFinalize).not.toBeNull();
		expect(stateAfterFinalize.steps[0].state).toBe("completed");
		expect(stateAfterFinalize.steps[1].state).toBe("pending");

		if (hasActivePlan(mockCtx())) setupPlanPanel("Test goal", ["Step A", "Step B"], mockCtx());

		completePlanStep(mockCtx());

		const stateAfterComplete = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(stateAfterComplete).not.toBeNull();
		expect(stateAfterComplete.steps[0].state).toBe("completed");
		expect(stateAfterComplete.steps[1].state).toBe("pending");

		expect(stateAfterFinalize.completedCount).toBe(stateAfterComplete.completedCount);
		expect(stateAfterFinalize.totalCount).toBe(stateAfterComplete.totalCount);
	});

	it("both mark active step as completed and deactivate it", () => {
		setupPlanPanel("Goal", ["Step A", "Step B"], mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(true);

		completePlanStep(mockCtx());
		const state1 = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(state1.steps[0].state).toBe("completed");
		expect(state1.steps[0].detail).toBeNull();

		setupPlanPanel("Goal", ["Step A", "Step B"], mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(true);
		finalizePlanStep(mockCtx());
		const state2 = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(state2.steps[0].state).toBe("completed");
		expect(state2.steps[0].detail).toBeNull();
	});

	it("both skip when called without side effects on non-active plan (no throw)", () => {
		// Even with singleton state, both should not throw
		expect(() => completePlanStep(mockCtx())).not.toThrow();
		expect(() => finalizePlanStep(mockCtx())).not.toThrow();
	});
});

describe("clearPlanIfComplete", () => {
	beforeEach(() => {
		// Ensure clean state
		if (hasActivePlan(mockCtx())) {
			clearPlanPanel(mockCtx());
		}
	});

	it("keeps planState alive after all steps completed", () => {
		setupPlanPanel("Goal", ["Step A"], mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(true);

		// Complete the only step
		finalizePlanStep(mockCtx());

		// Now all steps are completed
		clearPlanIfComplete(mockCtx());

		// Plan should still be active (not cleared)
		expect(hasActivePlan(mockCtx())).toBe(true);

		const state = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(state).not.toBeNull();
		expect(state.completedCount).toBe(state.totalCount);
		expect(state.steps[0].state).toBe("completed");
	});

	it("does nothing when not all steps completed", () => {
		setupPlanPanel("Goal", ["Step A", "Step B"], mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(true);

		// Complete only first step
		finalizePlanStep(mockCtx());

		// Not all done — clearPlanIfComplete should no-op
		clearPlanIfComplete(mockCtx());

		expect(hasActivePlan(mockCtx())).toBe(true);
		const state = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(state.completedCount).toBe(1);
		expect(state.totalCount).toBe(2);
	});

	it("does nothing when no active plan", () => {
		// No plan active
		if (hasActivePlan(mockCtx())) clearPlanPanel(mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(false);
		expect(() => clearPlanIfComplete(mockCtx())).not.toThrow();
	});
});

describe("addSteps", () => {
	beforeEach(() => {
		if (hasActivePlan(mockCtx())) {
			clearPlanPanel(mockCtx());
		}
	});

	it("adds new steps to an existing plan", () => {
		setupPlanPanel("Goal", ["Step A", "Step B"], mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(true);

		addSteps(["Step C", "Step D"], mockCtx());

		const state = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(state.totalCount).toBe(4);
		expect(state.steps[2].label).toBe("Step C");
		expect(state.steps[3].label).toBe("Step D");
		expect(state.steps[2].state).toBe("pending");
		expect(state.steps[3].state).toBe("pending");
		expect(state.steps[2].startTime).toBeDefined();
		expect(state.steps[3].startTime).toBeDefined();
		expect(typeof state.steps[2].startTime).toBe("number");
		expect(typeof state.steps[3].startTime).toBe("number");
	});

	it("does not duplicate existing steps", () => {
		setupPlanPanel("Goal", ["Step A"], mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(true);

		addSteps(["Step A", "Step B"], mockCtx());

		const state = inspectPlanState(mockCtx()) as unknown as PlanState;
		expect(state.totalCount).toBe(2);
		expect(state.steps[0].label).toBe("Step A");
		expect(state.steps[1].label).toBe("Step B");
		expect(state.steps[1].startTime).toBeDefined();
		expect(typeof state.steps[1].startTime).toBe("number");
	});

	it("does nothing when no active plan", () => {
		if (hasActivePlan(mockCtx())) clearPlanPanel(mockCtx());
		expect(hasActivePlan(mockCtx())).toBe(false);
		expect(() => addSteps(["Step X"])).not.toThrow();
		expect(hasActivePlan(mockCtx())).toBe(false);
	});
});
