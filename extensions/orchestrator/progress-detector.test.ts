import { describe, it, expect } from "vitest";
import {
	classifyProgress,
	ProgressDetector,
	PROGRESS_STATE,
	type ToolExecutionSignal,
} from "./progress-detector.ts";
import { classifyProviderFailure, PROVIDER_FAILURE_KIND } from "./outcome.ts";
import { DELEGATION_OUTCOME, type ProviderFailureKind } from "./outcome.ts";
import { classifyDelegationOutcome } from "./delegate-pipeline.ts";

function sig(partial: Partial<ToolExecutionSignal>): ToolExecutionSignal {
	return {
		tool: "read",
		args: {},
		result: null,
		isError: false,
		isProviderError: false,
		hasEvidence: false,
		...partial,
	};
}

describe("classifyProgress (pure)", () => {
	it("returns HEALTHY when there is new evidence in the window", () => {
		const s = {
			evidenceDelta: 1,
			repeatedIdenticalCalls: 0,
			repeatedIdenticalErrors: 0,
			successfulAgentCalls: 1,
			totalAgentCalls: 1,
			providerFailures: 0,
			windowCheckpoints: 3,
		};
		expect(classifyProgress(s)).toBe(PROGRESS_STATE.HEALTHY);
	});

	it("returns STALLED on repeated identical (tool,args,result) calls", () => {
		expect(
			classifyProgress({
				evidenceDelta: 0,
				repeatedIdenticalCalls: 2,
				repeatedIdenticalErrors: 0,
				successfulAgentCalls: 1,
				totalAgentCalls: 3,
				providerFailures: 0,
				windowCheckpoints: 3,
			}),
		).toBe(PROGRESS_STATE.STALLED);
	});

	it("returns STALLED on repeated identical error strings", () => {
		expect(
			classifyProgress({
				evidenceDelta: 0,
				repeatedIdenticalCalls: 0,
				repeatedIdenticalErrors: 3,
				successfulAgentCalls: 0,
				totalAgentCalls: 3,
				providerFailures: 0,
				windowCheckpoints: 3,
			}),
		).toBe(PROGRESS_STATE.STALLED);
	});

	it("returns STALLED on flat-delta-without-liveness (sustained)", () => {
		expect(
			classifyProgress({
				evidenceDelta: 0,
				repeatedIdenticalCalls: 0,
				repeatedIdenticalErrors: 0,
				successfulAgentCalls: 0,
				totalAgentCalls: 0,
				providerFailures: 0,
				windowCheckpoints: 3,
			}),
		).toBe(PROGRESS_STATE.STALLED);
	});

	it("does NOT flag a single quiet checkpoint as STALLED (guard)", () => {
		expect(
			classifyProgress({
				evidenceDelta: 0,
				repeatedIdenticalCalls: 0,
				repeatedIdenticalErrors: 0,
				successfulAgentCalls: 0,
				totalAgentCalls: 0,
				providerFailures: 0,
				windowCheckpoints: 1,
			}),
		).toBe(PROGRESS_STATE.DEGRADED);
	});

	it("returns DEGRADED for activity with no new evidence", () => {
		expect(
			classifyProgress({
				evidenceDelta: 0,
				repeatedIdenticalCalls: 0,
				repeatedIdenticalErrors: 0,
				successfulAgentCalls: 1,
				totalAgentCalls: 1,
				providerFailures: 0,
				windowCheckpoints: 1,
			}),
		).toBe(PROGRESS_STATE.DEGRADED);
	});

	it("does NOT flag provider failures as agent stuckness", () => {
		// A window containing ONLY provider/infra failures must never be STALLED —
		// it routes to provider_failure, not stalled_no_progress.
		expect(
			classifyProgress({
				evidenceDelta: 0,
				repeatedIdenticalCalls: 0,
				repeatedIdenticalErrors: 0,
				successfulAgentCalls: 0,
				totalAgentCalls: 0,
				providerFailures: 3,
				windowCheckpoints: 3,
			}),
		).toBe(PROGRESS_STATE.DEGRADED);
	});
});

describe("ProgressDetector (sliding window)", () => {
	it("stays HEALTHY on a healthy long task with new evidence each window", () => {
		const d = new ProgressDetector(4);
		// Simulate a long, productive task: new evidence every step.
		for (let i = 0; i < 50; i++) {
			d.record(sig({ tool: "read", args: { path: `f${i}` }, result: `content-${i}`, hasEvidence: true }));
			expect(d.state()).toBe(PROGRESS_STATE.HEALTHY);
		}
	});

	it("flags repeated identical calls with identical results as STALLED", () => {
		const d = new ProgressDetector(4);
		d.record(sig({ args: { path: "a" }, result: "same", hasEvidence: false }));
		d.record(sig({ args: { path: "a" }, result: "same", hasEvidence: false }));
		expect(d.state()).toBe(PROGRESS_STATE.STALLED);
	});

	it("flags repeated identical error strings as STALLED", () => {
		const d = new ProgressDetector(4);
		for (let i = 0; i < 3; i++) {
			d.record(sig({ isError: true, result: "Error: boom", hasEvidence: false }));
		}
		expect(d.state()).toBe(PROGRESS_STATE.STALLED);
	});

	it("tracks provider failures separately and never reads them as agent stuckness", () => {
		const d = new ProgressDetector(4);
		for (let i = 0; i < 3; i++) {
			d.record(sig({ isError: true, isProviderError: true, result: "429 Too Many Requests", hasEvidence: false }));
		}
		expect(d.providerFailures()).toBe(3);
		expect(d.state()).not.toBe(PROGRESS_STATE.STALLED);
		expect(d.state()).toBe(PROGRESS_STATE.DEGRADED);
	});

	it("flags flat-delta-without-liveness after silence rolls across the window", () => {
		const d = new ProgressDetector(4);
		// A productive start...
		d.record(sig({ hasEvidence: true, result: "x" }));
		expect(d.state()).toBe(PROGRESS_STATE.HEALTHY);
		// ...then the agent goes silent; silence checkpoints crowd out the evidence.
		for (let i = 0; i < 4; i++) d.rollSilence();
		expect(d.state()).toBe(PROGRESS_STATE.STALLED);
	});

	it("slides the window so old evidence stops protecting the agent", () => {
		const d = new ProgressDetector(3);
		d.record(sig({ hasEvidence: true, result: "x" }));
		d.rollSilence();
		d.rollSilence();
		// Evidence still within the window -> still healthy-ish or degraded, not stalled yet.
		expect(d.state()).toBe(PROGRESS_STATE.HEALTHY);
		d.rollSilence(); // third silence pushes evidence out of a size-3 window
		expect(d.state()).toBe(PROGRESS_STATE.STALLED);
	});

	// ── C2 regression: an agent looping on agent-level errors (previously masked
	// by loose AUTH regex) must now read as STALLED, never provider-only DEGRADED.
	it("flags STALLED when the agent loops on 'Permission denied' (agent-level)", () => {
		const d = new ProgressDetector(4);
		for (let i = 0; i < 3; i++) {
			d.record(sig({ isError: true, result: "bash: Permission denied", hasEvidence: false }));
		}
		expect(d.providerFailures()).toBe(0);
		expect(d.state()).toBe(PROGRESS_STATE.STALLED);
	});

	it("flags STALLED when the agent loops on generic timeouts (agent-level)", () => {
		const d = new ProgressDetector(4);
		for (let i = 0; i < 3; i++) {
			d.record(sig({ isError: true, result: "Command timed out after 120000 ms", hasEvidence: false }));
		}
		expect(d.providerFailures()).toBe(0);
		expect(d.state()).toBe(PROGRESS_STATE.STALLED);
	});
});

describe("classifyProviderFailure (provider taxonomy)", () => {
	it("classifies rate-limit", () => {
		expect(classifyProviderFailure("429 Too Many Requests")).toBe(PROGRESS_STATE && PROVIDER_FAILURE_KIND.RATE_LIMIT);
	});
	it("classifies HTTP 5xx", () => {
		expect(classifyProviderFailure("502 Bad Gateway from provider")).toBe(PROGRESS_STATE && PROVIDER_FAILURE_KIND.HTTP_5XX);
	});
	it("classifies transport timeout", () => {
		expect(classifyProviderFailure("request timed out after 30s")).toBe(PROGRESS_STATE && PROVIDER_FAILURE_KIND.TRANSPORT_TIMEOUT);
	});
	it("classifies auth denial", () => {
		expect(classifyProviderFailure("401 Unauthorized: invalid api key")).toBe(PROGRESS_STATE && PROVIDER_FAILURE_KIND.AUTH);
	});
	it("returns null for non-provider agent errors", () => {
		expect(classifyProviderFailure("File not found at src/foo.ts")).toBeNull();
	});
});

// ── C2: tightened provider regexes — agent-level errors must NOT classify as
// provider failures (that masks stuck agents, since providerFailures never
// produce a STALLED classification).
describe("classifyProviderFailure (C2 tightening — agent errors are not provider faults)", () => {
	const kind = PROVIDER_FAILURE_KIND;
	const expectKind = (k: ProviderFailureKind) => k;

	it("bare 'Permission denied' (bash chmod/exec) is NOT auth", () => {
		expect(classifyProviderFailure("Permission denied")).toBeNull();
	});
	it("bash permission error with path context is NOT auth", () => {
		expect(classifyProviderFailure("chmod: changing permissions of '/tmp/x.sh': Permission denied")).toBeNull();
		expect(classifyProviderFailure("./script.sh: Permission denied")).toBeNull();
	});
	it('permission denied WITH provider/credential context IS auth', () => {
		expect(classifyProviderFailure("API returned: Permission denied for this key")).toBe(kind.AUTH);
		expect(classifyProviderFailure("permission denied — invalid token scope")).toBe(kind.AUTH);
	});
	it('generic tool-output timeout is NOT transport_timeout', () => {
		expect(classifyProviderFailure("Command timed out after 120000 ms")).toBeNull();
		expect(classifyProviderFailure("jest worker timed out")).toBeNull();
	});
	it('transport-level timeouts still classify', () => {
		expect(classifyProviderFailure("connect ETIMEDOUT 1.2.3.4:443")).toBe(kind.TRANSPORT_TIMEOUT);
		expect(classifyProviderFailure("connection timed out after 30s")).toBe(kind.TRANSPORT_TIMEOUT);
		expect(classifyProviderFailure("gateway timeout from proxy")).toBe(kind.TRANSPORT_TIMEOUT);
	});
	it('existing request-timed-out test case still classifies', () => {
		expect(classifyProviderFailure("request timed out after 30s")).toBe(kind.TRANSPORT_TIMEOUT);
	});
	it("bare '503' in results is NOT http_5xx", () => {
		expect(classifyProviderFailure("503")).toBeNull();
		expect(classifyProviderFailure("test suite failed: expected 500 got 503")).toBeNull();
	});
	it('provider-context 5xx DOES classify as http_5xx', () => {
		expect(classifyProviderFailure("upstream 503")).toBe(expectKind("http_5xx"));
		expect(classifyProviderFailure("API responded with 502")).toBe(kind.HTTP_5XX);
		expect(classifyProviderFailure("502 Bad Gateway from provider")).toBe(kind.HTTP_5XX);
	});
	it('a stuck agent looping on agent-level errors yields null every time', () => {
		for (let i = 0; i < 4; i++) {
			expect(classifyProviderFailure(`bash: Permission denied (attempt ${i})`)).toBeNull();
		}
	});
});

// ── C1: outcome mapping — a completed delegation with a quiet (tool-free) tail
// must be 'done', never 'stalled_no_progress'.
describe("classifyDelegationOutcome (C1 — completed quiet-tail is done)", () => {
	const O = DELEGATION_OUTCOME;

	it("completed + STALLED window + NOT stall-terminated → done", () => {
		expect(classifyDelegationOutcome({
			status: "completed",
			stopReason: "stop",
			progressState: "STALLED",
			providerFailures: 0,
			stallTerminated: false,
		})).toBe(O.DONE);
	});

	it("completed + STALLED + terminated after unanswered nudge → stalled_no_progress", () => {
		expect(classifyDelegationOutcome({
			status: "completed",
			stopReason: "stop",
			progressState: "STALLED",
			providerFailures: 0,
			stallTerminated: true,
		})).toBe(O.STALLED_NO_PROGRESS);
	});

	it("non-completed + STALLED with zero provider failures → stalled_no_progress", () => {
		expect(classifyDelegationOutcome({
			status: "aborted",
			progressState: "STALLED",
			providerFailures: 0,
			stallTerminated: false,
		})).toBe(O.STALLED_NO_PROGRESS);
	});

	it("clean completion without STALLED state → done", () => {
		expect(classifyDelegationOutcome({
			status: "completed",
			stopReason: "stop",
			progressState: "HEALTHY",
			providerFailures: 0,
			stallTerminated: false,
		})).toBe(O.DONE);
	});

	it("error with genuine provider errorMessage → provider_failure", () => {
		expect(classifyDelegationOutcome({
			status: "error",
			errorMessage: "upstream returned 503",
			progressState: "HEALTHY",
		})).toBe(O.PROVIDER_FAILURE);
	});
});
