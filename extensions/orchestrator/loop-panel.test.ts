import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlanPanel, _instances } from "./plan-panel";
import type { LoopUntilConfig, LoopUntilState, LoopIteration } from "./types";

function makeConfig(overrides?: Partial<LoopUntilConfig>): LoopUntilConfig {
	return {
		criterion: "All tests pass",
		evaluator: "reviewer",
		maxIterations: 5,
		mode: "satisficing",
		satisficingPasses: 2,
		iterationTemplate: {
			specialist: "coder",
			task: "Fix tests {{iteration.N}}",
		},
		...overrides,
	};
}

function makeIteration(index: number, status: LoopIteration["status"], summary: string, scores?: Record<string, number>): LoopIteration {
	return { index, status, summary, scores };
}

function makeState(overrides?: Partial<LoopUntilState>): LoopUntilState {
	return {
		currentIteration: 0,
		consecutivePasses: 0,
		rollingSummary: "",
		status: "idle",
		iterations: [],
		...overrides,
	};
}

function makePanelWithLoop(stepLabel = "loop-step", config?: LoopUntilConfig): { panel: PlanPanel; ctx: ReturnType<typeof mockCtx> } {
	const ctx = mockCtx();
	const panel = new PlanPanel({ cwd: "/tmp" });
	_instances.set(ctx.sessionManager.sessionId, panel);

	panel.setupPlanPanel("Test goal", [stepLabel, "after-step"], ctx);

	// Mark the step as loop_until with config
	const planState = panel.getPlanState();
	const step = planState?.steps.find((s) => s.label === stepLabel);
	if (step) {
		step.kind = "loop_until";
		step.loopUntil = config ?? makeConfig();
	}

	return { panel, ctx };
}

function mockCtx() {
	return {
		sessionManager: { sessionId: "loop-panel-test-" + Math.random().toString(36).slice(2, 8) },
		ui: { setWidget: vi.fn() },
	};
}

describe("Loop Mode", () => {
	describe("initLoopState", () => {
		it("creates initial state with iteration 0 and running status", () => {
			const { panel } = makePanelWithLoop();
			const config = makeConfig();
			panel.initLoopState("loop-step", config);

			const states = PlanPanel.getLoopStates();
			const state = states.get("loop-step");
			expect(state).toBeDefined();
			expect(state!.currentIteration).toBe(0);
			expect(state!.consecutivePasses).toBe(0);
			expect(state!.status).toBe("running");
			expect(state!.iterations).toEqual([]);
		});

		it("attaches config and state to the plan step", () => {
			const { panel } = makePanelWithLoop();
			const config = makeConfig();
			panel.initLoopState("loop-step", config);

			const step = panel.getPlanState()?.steps.find((s) => s.label === "loop-step");
			expect(step?.loopUntil).toBe(config);
			expect(step?.loopUntilState).toBeDefined();
			expect(step?.loopUntilState?.status).toBe("running");
		});

		it("overwrites existing state for same step label", () => {
			const { panel } = makePanelWithLoop();
			panel.initLoopState("loop-step", makeConfig({ maxIterations: 3 }));
			// Run some iterations to mutate state
			panel.getPlanState(); // just confirm it exists

			panel.initLoopState("loop-step", makeConfig({ maxIterations: 10 }));
			const state = PlanPanel.getLoopStates().get("loop-step");
			expect(state!.currentIteration).toBe(0);
			expect(state!.status).toBe("running");
		});
	});

	describe("runLoopIteration", () => {
		it("increments iteration counter", async () => {
			const { panel } = makePanelWithLoop();
			panel.initLoopState("loop-step", makeConfig({ maxIterations: 5 }));

			const result = await panel.runLoopIteration("loop-step");
			const state = PlanPanel.getLoopStates().get("loop-step");

			expect(state!.currentIteration).toBe(1);
			expect(state!.status).toBe("running");
			expect(result.done).toBe(false);
		});

		it("returns done when max iterations reached", async () => {
			const { panel } = makePanelWithLoop();
			panel.initLoopState("loop-step", makeConfig({ maxIterations: 2 }));

			await panel.runLoopIteration("loop-step");
			const result = await panel.runLoopIteration("loop-step");

			expect(result.done).toBe(true);
			expect(result.reason).toBe("max-reached");

			const state = PlanPanel.getLoopStates().get("loop-step");
			expect(state!.status).toBe("max-reached");
			expect(state!.currentIteration).toBe(2);
		});

		it("builds task from template with iteration number", async () => {
			const { panel } = makePanelWithLoop();
			const config = makeConfig({
				iterationTemplate: { specialist: "coder", task: "Run batch {{iteration.N}} of tests" },
			});
			panel.initLoopState("loop-step", config);

			await panel.runLoopIteration("loop-step");

			const step = panel.getPlanState()?.steps.find((s) => s.label === "loop-step");
			// detail should mention iteration 1
			expect(step?.detail).toContain("1/5");
		});

		it("returns done for non-loop step", async () => {
			const ctx = mockCtx();
			const panel = new PlanPanel({ cwd: "/tmp" });
			_instances.set(ctx.sessionManager.sessionId, panel);
			panel.setupPlanPanel("Goal", ["regular-step"], ctx);

			const result = await panel.runLoopIteration("regular-step");
			expect(result.done).toBe(true);
			expect(result.reason).toBe("Not a loop step");
		});

		it("returns done when no loop state exists", async () => {
			const { panel } = makePanelWithLoop("no-state-step");
			// Don't call initLoopState — step has kind but no state
			const result = await panel.runLoopIteration("no-state-step");
			expect(result.done).toBe(true);
			expect(result.reason).toBe("No loop state");
		});
	});

	describe("evaluateLoopCriterion", () => {
		it("detects pass from success markers", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const result = panel.evaluateLoopCriterion(
				"✅ All tests passed. Issue closed.",
				makeConfig(),
				makeState()
			);
			expect(result.pass).toBe(true);
		});

		it("detects pass from 'completed' marker", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const result = panel.evaluateLoopCriterion(
				"Build completed successfully",
				makeConfig(),
				makeState()
			);
			expect(result.pass).toBe(true);
		});

		it("detects fail from [error] marker", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const result = panel.evaluateLoopCriterion(
				"[error] Tests failed on line 42",
				makeConfig(),
				makeState()
			);
			expect(result.pass).toBe(false);
			expect(result.feedback).toBe("Error detected in output");
		});

		it("detects fail from ❌ marker", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const result = panel.evaluateLoopCriterion(
				"❌ Criterion not met: 3 tests still failing",
				makeConfig(),
				makeState()
			);
			expect(result.pass).toBe(false);
		});

		it("returns false when no markers present", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const result = panel.evaluateLoopCriterion(
				"Nothing conclusive here",
				makeConfig(),
				makeState()
			);
			expect(result.pass).toBe(false);
		});

		it("error takes precedence over success", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const result = panel.evaluateLoopCriterion(
				"✅ Tests passed but [error] compilation failed",
				makeConfig(),
				makeState()
			);
			expect(result.pass).toBe(false);
		});
	});

	describe("updateRollingSummary", () => {
		it("builds structured facts from iterations", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState();
			const iteration = makeIteration(0, "pass", "Tests green", { correctness: 9, coverage: 7 });

			panel.updateRollingSummary(state, iteration);

			expect(state.iterations).toHaveLength(1);
			expect(state.rollingSummary).toContain("Iteration Facts");
			expect(state.rollingSummary).toContain("Iter 1: pass");
			expect(state.rollingSummary).toContain("9/7"); // scores
		});

		it("keeps narrative for recent iterations (<=10)", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState();

			panel.updateRollingSummary(state, makeIteration(0, "pass", "First attempt"));
			panel.updateRollingSummary(state, makeIteration(1, "fail", "Second try"));

			expect(state.rollingSummary).toContain("Recent Context");
			expect(state.rollingSummary).toContain("Iteration 1: First attempt");
			expect(state.rollingSummary).toContain("Iteration 2: Second try");
		});

		it("drops narrative after 10 iterations (facts only)", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState();

			for (let i = 0; i < 11; i++) {
				panel.updateRollingSummary(state, makeIteration(i, i < 8 ? "fail" : "pass", `Attempt ${i + 1}`));
			}

			expect(state.rollingSummary).toContain("Iteration Facts");
			expect(state.rollingSummary).not.toContain("Recent Context");
		});

		it("handles iterations without scores", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState();

			panel.updateRollingSummary(state, makeIteration(0, "pass", "Simple pass"));

			expect(state.rollingSummary).toContain("Iter 1: pass — Simple pass");
		});
	});

	describe("detectStall", () => {
		it("returns false when fewer than window iterations", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState({
				iterations: [
					makeIteration(0, "fail", "Nope"),
					makeIteration(1, "fail", "Still no"),
				],
			});

			const result = panel.detectStall(state, 3);
			expect(result.stalled).toBe(false);
		});

		it("detects stall when all recent iterations failed", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState({
				iterations: [
					makeIteration(0, "pass", "OK"),
					makeIteration(1, "fail", "Bad"),
					makeIteration(2, "fail", "Bad"),
					makeIteration(3, "error", "Crash"),
				],
			});

			const result = panel.detectStall(state, 3);
			expect(result.stalled).toBe(true);
			expect(result.reason).toContain("No improvement");
			expect(result.reason).toContain("3");
		});

		it("returns false when recent iterations have mixed results", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState({
				iterations: [
					makeIteration(0, "fail", "Bad"),
					makeIteration(1, "fail", "Bad"),
					makeIteration(2, "pass", "Good"),
					makeIteration(3, "fail", "Bad"),
				],
			});

			const result = panel.detectStall(state, 3);
			expect(result.stalled).toBe(false);
		});

		it("uses default window of 3", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState({
				iterations: [
					makeIteration(0, "fail", "1"),
					makeIteration(1, "fail", "2"),
					makeIteration(2, "fail", "3"),
				],
			});

			const result = panel.detectStall(state);
			expect(result.stalled).toBe(true);
		});

		it("detects stall with custom window", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const state = makeState({
				iterations: [
					makeIteration(0, "pass", "Good"),
					makeIteration(1, "fail", "Bad"),
					makeIteration(2, "fail", "Bad"),
					makeIteration(3, "fail", "Bad"),
					makeIteration(4, "fail", "Bad"),
				],
			});

			const result = panel.detectStall(state, 4);
			expect(result.stalled).toBe(true);
		});
	});

	describe("composeFeedback", () => {
		it("composes pass feedback", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const feedback = panel.composeFeedback(
				makeConfig(),
				{ pass: true },
				makeState()
			);
			expect(feedback).toContain("✅");
			expect(feedback).toContain("Criterion met");
		});

		it("composes fail feedback without scores", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const feedback = panel.composeFeedback(
				makeConfig(),
				{ pass: false, feedback: "Tests still failing" },
				makeState()
			);
			expect(feedback).toContain("❌");
			expect(feedback).toContain("Criterion not met");
			expect(feedback).toContain("Tests still failing");
		});

		it("composes fail feedback with score breakdown", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const feedback = panel.composeFeedback(
				makeConfig(),
				{
					pass: false,
					scores: { correctness: 9, coverage: 4, performance: 6 },
				},
				makeState()
			);
			expect(feedback).toContain("What passed");
			expect(feedback).toContain("correctness (9)");
			expect(feedback).toContain("What needs work");
			expect(feedback).toContain("coverage (4)");
			expect(feedback).toContain("performance (6)");
		});

		it("only shows failing when all scores below 8", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const feedback = panel.composeFeedback(
				makeConfig(),
				{ pass: false, scores: { a: 3, b: 5 } },
				makeState()
			);
			expect(feedback).not.toContain("What passed");
			expect(feedback).toContain("What needs work");
		});

		it("only shows passing when all scores >= 8", () => {
			const panel = new PlanPanel({ cwd: "/tmp" });
			const feedback = panel.composeFeedback(
				makeConfig(),
				{ pass: false, scores: { a: 9, b: 10 } },
				makeState()
			);
			expect(feedback).toContain("What passed");
			expect(feedback).not.toContain("What needs work");
		});
	});

	describe("clearPlanIfComplete", () => {
		it("preserves plan when loop is active", () => {
			const { panel, ctx } = makePanelWithLoop();
			const config = makeConfig();
			panel.initLoopState("loop-step", config);

			// Set loop state to running
			const loopState = PlanPanel.getLoopStates().get("loop-step")!;
			loopState.status = "running";
			loopState.currentIteration = 2;

			// Call clearPlanIfComplete — should NOT clear
			panel.clearPlanIfComplete(ctx);

			expect(panel.hasActivePlan()).toBe(true);
		});

		it("clears plan when all steps complete and no active loop", () => {
			const { panel, ctx } = makePanelWithLoop();
			const config = makeConfig();
			panel.initLoopState("loop-step", config);

			// Complete both steps
			const planState = panel.getPlanState();
			for (const step of planState!.steps) {
				step.completed = true;
				step.active = false;
			}

			// Set loop state to completed (not running)
			const loopState = PlanPanel.getLoopStates().get("loop-step")!;
			loopState.status = "completed";

			panel.clearPlanIfComplete(ctx);

			// Plan should still be alive (stopped timer, re-rendered)
			expect(panel.hasActivePlan()).toBe(true);
		});

		it("does not clear when steps are incomplete", () => {
			const { panel, ctx } = makePanelWithLoop();
			panel.initLoopState("loop-step", makeConfig());

			const planState = panel.getPlanState();
			// Only complete first step, leave "after-step" incomplete
			planState!.steps[0].completed = true;
			planState!.steps[0].active = false;
			planState!.steps[1].completed = false;

			panel.clearPlanIfComplete(ctx);

			expect(panel.hasActivePlan()).toBe(true);
		});
	});
});
