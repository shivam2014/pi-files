/**
 * plan-seed — the child's plan is seeded at delegation start so the widget
 * shows real steps immediately (instead of the bash guard notice being the
 * first visible entry), and guard notices read as framework gates.
 */
import { describe, it, expect } from "vitest";
import {
	buildAutoPlanLabels,
	buildPlanSeedBlock,
	composeSeededTask,
	deriveChildPlanSteps,
	extractStepsFromTask,
	PLAN_SEED_MARKER,
} from "./delegate-pipeline.ts";
import { handleSubagentToolCall } from "./subagent-tool-guard.ts";

describe("extractStepsFromTask", () => {
	it("extracts a ## Steps list from the task text", () => {
		const task = [
			"Fix the auth bug.",
			"",
			"## Steps",
			"1. reproduce the failure",
			"2. patch the middleware",
			"3. run the login tests",
			"",
			"## Notes",
			"anything",
		].join("\n");
		expect(extractStepsFromTask(task)).toEqual([
			"reproduce the failure",
			"patch the middleware",
			"run the login tests",
		]);
	});

	it("strips checkbox markers from bulleted steps", () => {
		const task = "## Steps\n- [ ] first thing\n- [x] second thing";
		expect(extractStepsFromTask(task)).toEqual(["first thing", "second thing"]);
	});

	it("returns [] when the task has no explicit steps section", () => {
		expect(extractStepsFromTask("Just fix the bug.")).toEqual([]);
		expect(extractStepsFromTask("")).toEqual([]);
	});
});

describe("deriveChildPlanSteps", () => {
	it("prefers the task's explicit steps over the step label", () => {
		const task = "## Steps\n- plan A\n- plan B";
		expect(deriveChildPlanSteps(task, "fix auth")).toEqual(["plan A", "plan B"]);
	});

	it("falls back to the delegation's own step label", () => {
		expect(deriveChildPlanSteps("just fix it", "Fix login bug")).toEqual(["Fix login bug"]);
	});

	it("returns [] when nothing is derivable (caller falls back to today's behaviour)", () => {
		expect(deriveChildPlanSteps("", "")).toEqual([]);
		expect(deriveChildPlanSteps("", undefined)).toEqual([]);
	});
});

describe("buildPlanSeedBlock", () => {
	it("instructs planSteps as the FIRST action with the exact seeded steps", () => {
		const block = buildPlanSeedBlock("Fix login bug", ["repro", "patch", "test"]);
		expect(block).toContain(PLAN_SEED_MARKER);
		expect(block).toContain("FIRST action");
		expect(block).toContain("planSteps({ goal, steps })");
		expect(block).toContain('"Fix login bug"');
		expect(block).toContain('["repro","patch","test"]');
	});

	it("returns '' when there are no steps (fallback: no seed injection)", () => {
		expect(buildPlanSeedBlock("Fix login bug", [])).toBe("");
	});
});

describe("composeSeededTask — the seed gate", () => {
	const steplessTask = "Fix the flaky login test. Do not touch snapshots.";

	it("injects NO seed when the delegation has no label and the task has no ## Steps", () => {
		expect(composeSeededTask(steplessTask, undefined)).toBe(steplessTask);
		expect(composeSeededTask(steplessTask, undefined)).not.toContain(PLAN_SEED_MARKER);
		expect(composeSeededTask(steplessTask, "   ")).toBe(steplessTask);
	});

	it("never seeds a goal that starts with 'delegate to ' (parent-panel label shape)", () => {
		const parentShaped = "delegate to scout: READ-ONLY investigation";
		// A parent-shaped label alone is not structure → no seed at all.
		expect(composeSeededTask(steplessTask, parentShaped)).toBe(steplessTask);
		// With real structure the seed is injected, but never with the parent goal.
		const composed = composeSeededTask("Do the work.\n\n## Steps\n1. read the file\n2. patch it", parentShaped);
		expect(composed).toContain(PLAN_SEED_MARKER);
		expect(composed).not.toMatch(/goal: "delegate to /);
		expect(composed).toContain('"read the file"');
	});

	it("buildPlanSeedBlock never substitutes a goal that starts with 'delegate to '", () => {
		const block = buildPlanSeedBlock("delegate to scout: READ-ONLY investigation", ["read the file"]);
		expect(block).not.toMatch(/goal: "delegate to /);
		expect(block).toContain('goal: "read the file"');
		expect(buildPlanSeedBlock("delegate to scout: X", ["delegate to scout: Y"])).toBe("");
	});

	it("legitimate path: an explicit label with no ## Steps still seeds that goal", () => {
		const composed = composeSeededTask(steplessTask, "Health-check orchestrator");
		expect(composed).toContain(PLAN_SEED_MARKER);
		expect(composed).toContain('goal: "Health-check orchestrator"');
		expect(composed.endsWith(steplessTask)).toBe(true);
	});

	it("legitimate path: a task with a ## Steps section still seeds those steps", () => {
		const task = "Fix it.\n\n## Steps\n1. reproduce\n2. patch\n3. run the login tests";
		const composed = composeSeededTask(task, undefined);
		expect(composed.startsWith(PLAN_SEED_MARKER)).toBe(true);
		expect(composed).toContain('["reproduce","patch","run the login tests"]');
		expect(composed.endsWith(task)).toBe(true);
	});

	it("regression: the old call site's parent-panel labels always seeded the child", () => {
		const { autoGoal, stepLabel } = buildAutoPlanLabels("scout", "Scout", steplessTask);
		// Pre-fix expression: buildPlanSeedBlock(params.label?.trim() || autoGoal,
		// deriveChildPlanSteps(params.task, stepLabel)).
		const oldSeed = buildPlanSeedBlock(autoGoal, deriveChildPlanSteps(steplessTask, stepLabel));
		expect(oldSeed).toContain(PLAN_SEED_MARKER); // the bug this gate removes: always injected
		expect(oldSeed).toContain(`"${stepLabel}"`); // seeded with a machine-derived parent label
		expect(composeSeededTask(steplessTask, undefined)).toBe(steplessTask); // fix stays effective
	});
});

describe("guard notices read as framework gates", () => {
	it("plan gate reason is marked [guard] and is not a plan entry", () => {
		const event = { toolName: "bash", input: { command: "npx vitest run" } };
		const result = handleSubagentToolCall(event, true, undefined, {
			planParsed: false,
			blockedCalls: [],
		} as any);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("[guard]");
		expect(result?.reason).not.toBe("Call planSteps({ goal, steps }) first before using bash.");
	});

	it("gh write reason no longer tells the caller to use a tool the specialist lacks", () => {
		const event = { toolName: "bash", input: { command: "gh pr merge 42 --merge" } };
		const result = handleSubagentToolCall(event, true, undefined, {
			planParsed: true,
			blockedCalls: [],
		} as any);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("no gh write access");
		expect(result?.reason).not.toContain("Use the dedicated gh tool instead");
		expect(result?.reason).toContain("route the gh write request through the orchestrator");
	});
});
