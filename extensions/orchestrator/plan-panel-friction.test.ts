/**
 * plan-panel-friction.test.ts
 *
 * Regression tests for two orchestrator plan-state frictions:
 *   FIX 1 — a COMPLETE plan must be distinguishable from an ABSENT one. The plan
 *           persists after all steps complete; the delegate auto-create path appends
 *           to it instead of replacing it with a fresh 1-step plan.
 *   FIX 2 — error messages name the ACTIVE plan (goal + step labels), and
 *           advance_plan_step returns a COMPLETE-specific message rather than the
 *           misleading "No active plan. Call plan() first." for a finished plan.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	setupPlanPanel,
	finalizePlanStep,
	clearPlanIfComplete,
	clearPlanPanel,
	hasActivePlan,
	getPlanState,
	modifyStep,
	startDelegationStep,
	_instances,
} from "./plan-panel.ts";
import { registerAdvancePlanStepTool } from "./plan-tool.ts";

function mockCtx(sessionId = "plan-panel-friction-test") {
	const setWidget = (_key: string, _content: string[] | undefined) => {};
	return {
		sessionManager: { sessionId },
		ui: { setWidget },
	};
}

/** Complete every step of a freshly-set-up plan. */
function completeAll(ctx: ReturnType<typeof mockCtx>, stepCount: number) {
	for (let i = 0; i < stepCount; i++) finalizePlanStep(ctx);
	clearPlanIfComplete(ctx);
}

/** Capture the advance_plan_step tool registered by plan-tool.ts. */
function captureAdvanceTool() {
	const tools: Record<string, { execute: (...a: any[]) => any }> = {};
	registerAdvancePlanStepTool({ registerTool: (t: any) => { tools[t.name] = t; } } as any);
	return tools.advance_plan_step;
}

const advanceTool = captureAdvanceTool();

describe("FIX 1 — a completed plan is preserved, not discarded", () => {
	beforeEach(() => { _instances.clear(); });

	it("survives the turn-boundary clear and the delegate auto-create path APPENDS to it", () => {
		const ctx = mockCtx();
		setupPlanPanel("Friction goal", ["A", "B", "C", "D"], ctx);
		completeAll(ctx, 4);

		// Turn boundary: agent_end / before_agent_start both call clearPlanPanel.
		clearPlanPanel(ctx);

		// The plan still exists, so the delegate auto-create guard is skipped.
		expect(hasActivePlan(ctx)).toBe(true);
		if (!hasActivePlan(ctx)) {
			setupPlanPanel("delegate to scout: autoreplace", ["Scout: autoreplace"], ctx);
		}
		// The delegate path then claims/appends its step.
		startDelegationStep("Scout: autoreplace", ctx);

		const state = getPlanState(ctx)!;
		expect(state.goal).toContain("Friction goal");
		expect(state.goal).not.toContain("autoreplace");
		expect(state.steps.map(s => s.label)).toEqual(["A", "B", "C", "D", "Scout: autoreplace"]);
	});

	it("a genuinely never-created plan still reports no active plan", () => {
		const ctx = mockCtx("friction-absent");
		expect(hasActivePlan(ctx)).toBe(false);
	});

	it("re-declaring the same goal after completion starts fresh (no carried-over completed flags)", () => {
		const ctx = mockCtx("friction-redeclare");
		setupPlanPanel("Regoal", ["A", "B"], ctx);
		completeAll(ctx, 2);
		clearPlanPanel(ctx);
		expect(hasActivePlan(ctx)).toBe(true);

		setupPlanPanel("Regoal", ["A", "B"], ctx);
		const state = getPlanState(ctx)!;
		expect(state.steps.every(s => !s.completed)).toBe(true);
		expect(state.steps[0].active).toBe(true);
	});
});

describe("FIX 2 — out-of-range errors name the active plan", () => {
	beforeEach(() => { _instances.clear(); });

	it("modify_step beyond the step count returns 'out of range' AND the active goal", () => {
		const ctx = mockCtx("friction-modify");
		setupPlanPanel("Modify goal", ["A", "B", "C", "D"], ctx);

		const res = modifyStep(6, "X", undefined, ctx);
		expect(res.success).toBe(false);
		expect(res.error).toContain("out of range");
		expect(res.error).toContain("Modify goal");
	});

	it("the out-of-range error hints at plan_add_steps() when the plan is complete", () => {
		const ctx = mockCtx("friction-modify-complete");
		setupPlanPanel("Modify complete goal", ["A"], ctx);
		completeAll(ctx, 1);

		const res = modifyStep(2, "X", undefined, ctx);
		expect(res.success).toBe(false);
		expect(res.error).toContain("out of range");
		expect(res.error).toContain("Modify complete goal");
		expect(res.error).toContain("plan_add_steps()");
	});
});

describe("FIX 2 — advance_plan_step distinguishes COMPLETE from ABSENT", () => {
	beforeEach(() => { _instances.clear(); });

	it("returns the COMPLETE-specific message on a finished plan (not 'No active plan')", async () => {
		const ctx = mockCtx("friction-advance-complete");
		setupPlanPanel("Advance goal", ["A"], ctx);
		completeAll(ctx, 1);

		const out = await advanceTool.execute("id", {}, undefined, () => {}, ctx);
		const text = out.content[0].text as string;
		expect(text).toContain("Plan complete");
		expect(text).toContain("plan_add_steps()");
		expect(text).not.toContain("No active plan");
	});

	it("still returns 'No active plan' when no plan exists at all", async () => {
		const ctx = mockCtx("friction-advance-absent");
		const out = await advanceTool.execute("id", {}, undefined, () => {}, ctx);
		const text = out.content[0].text as string;
		expect(text).toContain("No active plan");
		expect(text).not.toContain("Plan complete");
	});
});
