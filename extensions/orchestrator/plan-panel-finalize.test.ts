import { describe, it, expect, beforeEach } from "vitest";
import {
	setupPlanPanel,
	completePlanStep,
	finalizePlanStep,
	hasActivePlan,
	inspectPlanState,
} from "./plan-panel.ts";

interface PlanState {
	goal: string;
	steps: Array<{
		index: number;
		label: string;
		state: string;
		substepCount: number;
		detail: string | null;
	}>;
	completedCount: number;
	totalCount: number;
	activeDelegations: number;
	elapsedMs: number;
}

function mockCtx() {
	const setWidget = (_key: string, _content: string[] | undefined) => {};
	return { ui: { setWidget } };
}

describe("finalizePlanStep matches completePlanStep", () => {
	beforeEach(() => {
		if (hasActivePlan()) {
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
		expect(hasActivePlan()).toBe(true);

		finalizePlanStep(mockCtx());

		const stateAfterFinalize = inspectPlanState() as unknown as PlanState;
		expect(stateAfterFinalize).not.toBeNull();
		expect(stateAfterFinalize.steps[0].state).toBe("completed");
		expect(stateAfterFinalize.steps[1].state).toBe("pending");

		if (hasActivePlan()) setupPlanPanel("Test goal", ["Step A", "Step B"], mockCtx());

		completePlanStep(mockCtx());

		const stateAfterComplete = inspectPlanState() as unknown as PlanState;
		expect(stateAfterComplete).not.toBeNull();
		expect(stateAfterComplete.steps[0].state).toBe("completed");
		expect(stateAfterComplete.steps[1].state).toBe("pending");

		expect(stateAfterFinalize.completedCount).toBe(stateAfterComplete.completedCount);
		expect(stateAfterFinalize.totalCount).toBe(stateAfterComplete.totalCount);
	});

	it("both mark active step as completed and deactivate it", () => {
		setupPlanPanel("Goal", ["Step A", "Step B"], mockCtx());
		expect(hasActivePlan()).toBe(true);

		completePlanStep(mockCtx());
		const state1 = inspectPlanState() as unknown as PlanState;
		expect(state1.steps[0].state).toBe("completed");
		expect(state1.steps[0].detail).toBeNull();

		setupPlanPanel("Goal", ["Step A", "Step B"], mockCtx());
		expect(hasActivePlan()).toBe(true);
		finalizePlanStep(mockCtx());
		const state2 = inspectPlanState() as unknown as PlanState;
		expect(state2.steps[0].state).toBe("completed");
		expect(state2.steps[0].detail).toBeNull();
	});

	it("both skip when called without side effects on non-active plan (no throw)", () => {
		// Even with singleton state, both should not throw
		expect(() => completePlanStep(mockCtx())).not.toThrow();
		expect(() => finalizePlanStep(mockCtx())).not.toThrow();
	});
});
