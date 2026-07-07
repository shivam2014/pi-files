/**
 * Failing tests for activity-feed race condition fix.
 *
 * Bug: completeLastSubstep() finds FIRST uncompleted substep by position.
 * Parallel tool calls complete out of order → substeps get wrong output.
 *
 * Fix: completeSubstepByToolCallId() targets substep by toolCallId instead.
 */

import { describe, it, assert } from "vitest";
import type { ActivityFeedState, Step } from "./types.ts";
import {
	addSubstep,
	completeLastSubstep,
	completeSubstepByToolCallId,
} from "./activity-feed.ts";

/** Helper: create a minimal state with one step and given substeps */
function makeState(substepLabels: string[], toolCallIds?: string[]): ActivityFeedState {
	const substeps = substepLabels.map((label, i) => ({
		label,
		completed: false,
		startTime: Date.now(),
		...(toolCallIds?.[i] ? { toolCallId: toolCallIds[i] } : {}),
	}));

	return {
		goal: "test goal",
		steps: [
			{
				label: "Step 1",
				completed: false,
				substeps,
				startTime: Date.now(),
			},
		],
		currentStep: 0,
		rawText: "",
		planParsed: true,
	};
}

describe("completeSubstepByToolCallId", () => {
	it("completes the correct substep when completed out of order", () => {
		// Two substeps, both uncompleted. Complete call_2 FIRST (out of order).
		const state = makeState(
			["Reading file_a.ts", "Reading file_b.ts"],
			["call_1", "call_2"],
		);

		const result = completeSubstepByToolCallId(state, "call_2", "output from b");

		const step = result.steps[0];

		// call_1 should remain uncompleted
		assert.equal(step.substeps[0].completed, false, "call_1 should stay uncompleted");
		assert.equal(step.substeps[0].outputPreview, undefined, "call_1 should have no output");

		// call_2 should be completed with correct output
		assert.equal(step.substeps[1].completed, true, "call_2 should be completed");
		assert.equal(step.substeps[1].outputPreview, "output from b", "call_2 should have correct output");
	});

	it("completes in reverse order without affecting earlier substeps", () => {
		const state = makeState(
			["grep pattern", "read file", "bash cmd"],
			["call_1", "call_2", "call_3"],
		);

		// Complete last tool first
		let result = completeSubstepByToolCallId(state, "call_3", "bash output");

		// Then middle
		result = completeSubstepByToolCallId(result, "call_2", "read output");

		const step = result.steps[0];

		// call_1 still uncompleted
		assert.equal(step.substeps[0].completed, false);
		// call_2 and call_3 completed with correct outputs
		assert.equal(step.substeps[1].completed, true);
		assert.equal(step.substeps[1].outputPreview, "read output");
		assert.equal(step.substeps[2].completed, true);
		assert.equal(step.substeps[2].outputPreview, "bash output");
	});

	it("marks error correctly by toolCallId", () => {
		const state = makeState(
			["edit file_a", "edit file_b"],
			["call_1", "call_2"],
		);

		const result = completeSubstepByToolCallId(state, "call_1", "error message", true);

		assert.equal(result.steps[0].substeps[0].completed, true);
		assert.equal(result.steps[0].substeps[0].errored, true);
		assert.equal(result.steps[0].substeps[1].completed, false);
	});

	it("is a no-op when toolCallId not found", () => {
		const state = makeState(
			["Reading file"],
			["call_1"],
		);

		const result = completeSubstepByToolCallId(state, "call_nonexistent", "output");

		// Original substep should remain untouched
		assert.equal(result.steps[0].substeps[0].completed, false);
	});

	it("demonstrates the bug: completeLastSubstep completes WRONG substep in parallel", () => {
		// This test should PASS with current code but shows the race condition.
		// With two parallel calls, completeLastSubstep always grabs the first
		// uncompleted one regardless of which tool actually finished.
		const state = makeState(
			["grep pattern", "read file"],
			["call_1", "call_2"],
		);

		// Simulate: grep finishes first (call_1), then read finishes (call_2)
		// This sequential case works fine with completeLastSubstep:
		const afterFirst = completeLastSubstep(state, "grep output");
		assert.equal(afterFirst.steps[0].substeps[0].completed, true);
		assert.equal(afterFirst.steps[0].substeps[0].outputPreview, "grep output");

		const afterSecond = completeLastSubstep(afterFirst, "read output");
		assert.equal(afterSecond.steps[0].substeps[1].completed, true);
		assert.equal(afterSecond.steps[0].substeps[1].outputPreview, "read output");
	});

	it("demonstrates the bug: completeLastSubstep assigns wrong output when order is reversed", () => {
		// This is the race condition: read finishes first, but completeLastSubstep
		// gives its output to grep (position 0) instead of read (position 1).
		const state = makeState(
			["grep pattern", "read file"],
			["call_1", "call_2"],
		);

		// Simulate: read finishes FIRST (out of order), then grep
		// completeLastSubstep gives read's output to grep!
		const afterRead = completeLastSubstep(state, "read output");
		// BUG: "read output" goes to substep[0] (grep), not substep[1] (read)
		assert.equal(afterRead.steps[0].substeps[0].completed, true);
		assert.equal(afterRead.steps[0].substeps[0].outputPreview, "read output"); // WRONG — this is grep's slot

		const afterGrep = completeLastSubstep(afterRead, "grep output");
		assert.equal(afterGrep.steps[0].substeps[1].completed, true);
		assert.equal(afterGrep.steps[0].substeps[1].outputPreview, "grep output"); // WRONG — this is read's slot
	});
});
