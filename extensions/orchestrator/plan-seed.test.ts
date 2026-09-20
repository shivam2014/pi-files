/**
 * plan-seed — the child's plan is seeded at delegation start so the widget
 * shows real steps immediately (instead of the bash guard notice being the
 * first visible entry), and guard notices read as framework gates.
 */
import { describe, it, expect } from "vitest";
import {
	buildPlanSeedBlock,
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
