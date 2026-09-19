/**
 * plan-lifecycle.test.ts — lifecycle coverage for two defects fixed in newly-added code:
 *
 *   DEFECT 1 — `planState.completed` was NOT reset when a pending step was appended.
 *              Every append entry point (delegate fallback append, plan_add_steps,
 *              insert_step) must clear the flag so a plan is never reported "complete"
 *              while pending work exists. _markCompleteIfAllDone() must set it back to
 *              true once the appended step completes.
 *
 *   DEFECT 2 — session_shutdown retained a completed plan (and its _instances entry)
 *              for the process lifetime. session_shutdown must fully discard the
 *              instance, while turn-boundary clears (agent_end / before_agent_start)
 *              keep preserving a completed plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	setupPlanPanel,
	completePlanStep,
	finalizePlanStep,
	clearPlanPanel,
	discardPlanPanel,
	hasActivePlan,
	inspectPlanState,
	getPlanState,
	startDelegationStep,
	addSteps,
	insertSteps,
	_instances,
} from "./plan-panel.ts";
import orchestrator from "./index";

interface StepView { index: number; label: string; state: string; }
interface PlanView { totalCount: number; completedCount: number; steps: StepView[]; }

function mockCtx(sessionId: string) {
	const setWidget = vi.fn();
	return {
		sessionManager: { sessionId },
		ui: { setWidget },
	};
}
type Ctx = ReturnType<typeof mockCtx>;

function view(ctx: Ctx): PlanView {
	return inspectPlanState(ctx) as unknown as PlanView;
}
/** `completed` lives on planState but is not part of the narrow public type. */
function completedFlag(ctx: Ctx): boolean | undefined {
	return (getPlanState(ctx) as any)?.completed;
}

let ctx: Ctx;
let sid: string;

beforeEach(() => {
	_instances.clear();
	sid = "plan-lifecycle-" + Math.random().toString(36).slice(2, 8);
	ctx = mockCtx(sid);
});

afterEach(() => {
	// Full teardown clears in-memory + on-disk state so tests never leak into each other.
	discardPlanPanel(ctx);
	_instances.clear();
});

// ─── 1. completing a multi-step plan sets completed = true ──────────────────

describe("1. completion flag", () => {
	it("is false while work remains and true once every step completes", () => {
		setupPlanPanel("Goal", ["A", "B", "C"], ctx);
		expect(completedFlag(ctx)).toBe(false);

		completePlanStep(ctx); // A
		expect(completedFlag(ctx)).toBe(false);

		completePlanStep(ctx); // B
		expect(completedFlag(ctx)).toBe(false);

		completePlanStep(ctx); // C — last one
		expect(completedFlag(ctx)).toBe(true);
		expect(view(ctx).completedCount).toBe(3);
	});
});

// ─── 2. every append entry point clears the flag ────────────────────────────

describe("2. appending a pending step reopens a completed plan", () => {
	it("delegate fallback append (startDelegationStep) clears completed", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		expect(completedFlag(ctx)).toBe(true);

		// No active/pending bindable step remains -> fallback append path.
		const idx = startDelegationStep("New step", ctx);
		expect(idx).toBeGreaterThanOrEqual(0);

		expect(completedFlag(ctx)).toBe(false);
		const v = view(ctx);
		expect(v.totalCount).toBe(2);
		expect(v.steps[1].label).toBe("New step");
		// delegate-start step is "active", never "completed"
		expect(v.steps[1].state).not.toBe("completed");
	});

	it("plan_add_steps (addSteps) clears completed", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		expect(completedFlag(ctx)).toBe(true);

		const res = addSteps(["New step"], ctx);
		expect(res?.added).toBe(1);

		expect(completedFlag(ctx)).toBe(false);
		const v = view(ctx);
		expect(v.totalCount).toBe(2);
		expect(v.steps[1].label).toBe("New step");
		expect(v.steps[1].state).toBe("pending");
	});

	it("insert_step (insertSteps) clears completed", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		expect(completedFlag(ctx)).toBe(true);

		const res = insertSteps(["New step"], { index: 1 }, ctx);
		expect(res.inserted).toBe(1);

		expect(completedFlag(ctx)).toBe(false);
		const v = view(ctx);
		expect(v.totalCount).toBe(2);
		expect(v.steps[1].label).toBe("New step");
		expect(v.steps[1].state).toBe("pending");
	});
});

// ─── 3. completing the appended step sets completed = true again ────────────

describe("3. completing the appended step re-completes the plan", () => {
	it("after a delegate fallback append", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		startDelegationStep("New step", ctx); // active
		expect(completedFlag(ctx)).toBe(false);

		completePlanStep(ctx); // completes the active appended step
		expect(completedFlag(ctx)).toBe(true);
	});

	it("after a plan_add_steps append", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		addSteps(["New step"], ctx);
		expect(completedFlag(ctx)).toBe(false);

		finalizePlanStep(ctx, 1); // explicit index (step is pending, not active)
		expect(completedFlag(ctx)).toBe(true);
	});

	it("after an insert_step append", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		insertSteps(["New step"], { index: 1 }, ctx);
		expect(completedFlag(ctx)).toBe(false);

		finalizePlanStep(ctx, 1);
		expect(completedFlag(ctx)).toBe(true);
	});
});

// ─── 4. session_shutdown discards the instance ──────────────────────────────

describe("4. session_shutdown discards the retained plan", () => {
	it("discardPlanPanel drops the instance + completed plan", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		expect(completedFlag(ctx)).toBe(true);
		expect(_instances.has(sid)).toBe(true);
		expect(hasActivePlan(ctx)).toBe(true);

		discardPlanPanel(ctx);

		expect(_instances.has(sid)).toBe(false);
		expect(hasActivePlan(ctx)).toBe(false);
		expect(getPlanState(ctx)).toBeFalsy();
		expect(inspectPlanState(ctx)).toBeFalsy();
	});

	it("the real session_shutdown handler removes the _instances entry", async () => {
		const tools: any[] = [];
		const handlers: Record<string, any[]> = {};
		const pi = {
			registerTool: (t: any) => tools.push(t),
			unregisterTool: () => {},
			getAllTools: () => tools,
			setActiveTools: () => {},
			on: (event: string, handler: any) => {
				handlers[event] = handlers[event] || [];
				handlers[event].push(handler);
			},
			registerCommand: () => {},
			registerShortcut: () => {},
			getActiveToolsHistory: () => [],
			async trigger(event: string, ...args: any[]) {
				const res: any[] = [];
				for (const h of handlers[event] || []) res.push(await h(...args));
				return res;
			},
		};
		orchestrator(pi as any);

		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		expect(_instances.has(sid)).toBe(true);

		await pi.trigger("session_shutdown", {}, ctx);

		expect(_instances.has(sid)).toBe(false);
		expect(hasActivePlan(ctx)).toBe(false);
	});
});

// ─── 5. turn-boundary clears still preserve a completed plan ────────────────

describe("5. turn-boundary behaviour unchanged (completed plan preserved)", () => {
	it("clearPlanPanel (agent_end / before_agent_start) keeps the completed plan", () => {
		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);
		expect(completedFlag(ctx)).toBe(true);

		// Both agent_end and before_agent_start call clearPlanPanel in index.ts.
		clearPlanPanel(ctx);

		expect(hasActivePlan(ctx)).toBe(true);
		expect(_instances.has(sid)).toBe(true);
		expect(completedFlag(ctx)).toBe(true);
		const v = view(ctx);
		expect(v.totalCount).toBe(1);
		expect(v.steps[0].state).toBe("completed");
	});

	it("the real agent_end handler preserves the completed plan", async () => {
		const tools: any[] = [];
		const handlers: Record<string, any[]> = {};
		const pi = {
			registerTool: (t: any) => tools.push(t),
			unregisterTool: () => {},
			getAllTools: () => tools,
			setActiveTools: () => {},
			on: (event: string, handler: any) => {
				handlers[event] = handlers[event] || [];
				handlers[event].push(handler);
			},
			registerCommand: () => {},
			registerShortcut: () => {},
			getActiveToolsHistory: () => [],
			async trigger(event: string, ...args: any[]) {
				const res: any[] = [];
				for (const h of handlers[event] || []) res.push(await h(...args));
				return res;
			},
		};
		orchestrator(pi as any);

		setupPlanPanel("Goal", ["A"], ctx);
		completePlanStep(ctx);

		await pi.trigger("agent_end", {}, ctx);

		expect(_instances.has(sid)).toBe(true);
		expect(hasActivePlan(ctx)).toBe(true);
		expect(completedFlag(ctx)).toBe(true);
	});
});

// ─── 6. no plan at all ──────────────────────────────────────────────────────

describe("6. no-plan-at-all still reports no active plan", () => {
		it("reports no active plan when nothing was created", () => {
		expect(hasActivePlan(ctx)).toBe(false);
		expect(getPlanState(ctx)).toBeFalsy();
		expect(inspectPlanState(ctx)).toBeFalsy();
	});

	it("a clear/discard on a non-existent plan is a no-op that keeps reporting none", () => {
		expect(() => clearPlanPanel(ctx)).not.toThrow();
		expect(() => discardPlanPanel(ctx)).not.toThrow();
		expect(hasActivePlan(ctx)).toBe(false);
		expect(getPlanState(ctx)).toBeFalsy();
	});
});
