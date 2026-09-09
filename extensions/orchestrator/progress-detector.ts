/**
 * Runtime progress / stall detection for subagent delegations.
 *
 * The detector classifies whether an agent is making forward progress using ONLY
 * observable signals — never raw turn count or elapsed time alone. Signals are
 * collected into a sliding checkpoint window and reduced by a pure function
 * (`classifyProgress`) into HEALTHY | DEGRADED | STALLED.
 *
 * ── Observable signals ──────────────────────────────────────────────────────────
 *  (a) artifact/evidence delta — a new file/diff/checksum change or a new
 *      non-empty tool result (the agent produced something new).
 *  (b) repeated identical (tool, args) calls with identical results — the agent is
 *      looping on the same operation and getting the same answer.
 *  (c) repeated identical error strings from a tool — stuck retrying a real,
 *      agent-level failure.
 *  (d) no successful tool activity in the checkpoint window — flat delta without
 *      liveness.
 *
 * ── Provider failures are a SEPARATE taxonomy ──────────────────────────────────
 *  Provider / infrastructure failures (5xx, rate-limit, transport timeout, auth)
 *  are recorded in `providerFailures` and never folded into the agent-level
 *  repeat / liveness counters. classifyProgress therefore can NOT return STALLED
 *  for a window that only contains provider failures — that routes to the
 *  provider_failure outcome, not stalled_no_progress. Provider retries/backoff
 *  belong OUTSIDE the agent loop and never consume agent turns.
 *
 * ── Intervention state machine (not yet wired to termination/nudge) ────────────
 *
 *                  ┌─────────┐    new evidence     ┌─────────┐
 *   ──────────────►│ HEALTHY │◄────────────────────│         │
 *                  └────┬────┘                     │ DEGRADED│
 *       evidence stops  │   (prevents premature     │         │
 *       / degradation   │    re-grade to HEALTHY    └────┬────┘
 *                        ▼                              │
 *                  ┌─────────┐   sustained no-evidence  │
 *                  │         │   + no liveness OR       │
 *                  │ STALLED │◄─────────────────────────┘
 *                  │         │   + repeated identical calls/errors
 *                  └─────────┘
 *
 *   HEALTHY : new evidence in the window -> keep running. Nudge is NOT needed.
 *   DEGRADED: activity but no new evidence yet -> keep running, raise watch flag.
 *   STALLED : sustained no-evidence + no liveness, or a repeat loop -> eligible
 *             for intervention (termination/nudge). The intervention itself is NOT
 *             wired yet — only the detector is in scope.
 *
 *   Terminal outcomes these states feed (see outcome.ts DELEGATION_OUTCOME):
 *     HEALTHY/ongoing       -> DONE (or INCOMPLETE if stopped with steps left)
 *     STALLED (agent loop)  -> stalled_no_progress
 *     providerFailures only -> provider_failure  (NOT stalled_no_progress)
 *     blocked scope calls   -> blocked
 *     maxTurns/maxBudget hit -> resource_limit  (config backstop, not target)
 */

export const PROGRESS_STATE = {
	HEALTHY: "HEALTHY",
	DEGRADED: "DEGRADED",
	STALLED: "STALLED",
} as const;
export type ProgressState = (typeof PROGRESS_STATE)[keyof typeof PROGRESS_STATE];

/**
 * Aggregated observable signals across a sliding checkpoint window.
 * `*AgentCalls` counters EXCLUDE provider failures (those live in providerFailures).
 */
export interface WindowedSignals {
	/** Distinct artifact/evidence deltas (new file/diff/checksum, new non-empty result). */
	evidenceDelta: number;
	/** Number of repeated identical (tool, args, result) calls in the window. */
	repeatedIdenticalCalls: number;
	/** Number of repeated identical agent-level error strings in the window. */
	repeatedIdenticalErrors: number;
	/** Successful, non-provider tool executions in the window. */
	successfulAgentCalls: number;
	/** All non-provider tool executions (success + agent-level errors) in the window. */
	totalAgentCalls: number;
	/** Provider/infrastructure failures (5xx, rate-limit, timeout, auth) — separate taxonomy. */
	providerFailures: number;
	/** How many checkpoints the window currently holds (for the sustained-stall guard). */
	windowCheckpoints: number;
}

function emptySignals(): WindowedSignals {
	return {
		evidenceDelta: 0,
		repeatedIdenticalCalls: 0,
		repeatedIdenticalErrors: 0,
		successfulAgentCalls: 0,
		totalAgentCalls: 0,
		providerFailures: 0,
		windowCheckpoints: 0,
	};
}

/**
 * Pure classifier: windowed signals -> HEALTHY | DEGRADED | STALLED.
 *
 * Order of checks matters:
 *  1. New evidence is definitive proof of progress -> HEALTHY (healthy long task).
 *  2. A window with ONLY provider/infra failures is NOT agent stuckness -> DEGRADED
 *     (outcome layer routes it to provider_failure, never stalled_no_progress).
 *  3. Repeated identical calls/errors -> STALLED.
 *  4. Sustained flat-delta-without-liveness -> STALLED.
 *  5. Otherwise some activity but no evidence -> DEGRADED.
 */
export function classifyProgress(s: WindowedSignals): ProgressState {
	if (s.evidenceDelta > 0) return PROGRESS_STATE.HEALTHY;

	// Provider/infra failures alone must never read as agent stuckness.
	if (s.providerFailures > 0 && s.totalAgentCalls === 0) return PROGRESS_STATE.DEGRADED;

	if (s.repeatedIdenticalCalls > 0) return PROGRESS_STATE.STALLED;
	if (s.repeatedIdenticalErrors > 0) return PROGRESS_STATE.STALLED;

	// Flat delta without liveness: no evidence and no successful agent activity,
	// sustained across at least two checkpoints (guards single-snapshot false alarms).
	if (s.evidenceDelta === 0 && s.successfulAgentCalls === 0 && s.windowCheckpoints >= 2) {
		return PROGRESS_STATE.STALLED;
	}

	return PROGRESS_STATE.DEGRADED;
}

/** One tool execution observed by the detector. */
export interface ToolExecutionSignal {
	tool: string;
	args: unknown;
	/** Normalized result text, or null if there was no produceable result. */
	result: string | null;
	isError: boolean;
	/** True when the failure is provider/infra (5xx, rate-limit, timeout, auth). */
	isProviderError: boolean;
	/** True when this produced a new artifact/evidence delta. */
	hasEvidence: boolean;
}

/** Stable, order-insensitive fingerprint of (tool, args) for repeat detection. */
function fingerprint(tool: string, args: unknown): string {
	let argsKey = "";
	try {
		argsKey = JSON.stringify(args ?? {});
	} catch {
		argsKey = String(args);
	}
	return `${tool}|${argsKey}`;
}

/**
 * Maintains a sliding checkpoint window of tool executions and summarizes them
 * into a ProgressState. Feed it one ToolExecutionSignal per tool_execution_end,
 * and call `rollSilence()` on a timer so quiet (no-tool) periods count as checkpoints.
 */
export class ProgressDetector {
	private checkpoints: WindowedSignals[] = [];
	private readonly windowSize: number;
	private lastCallKey: string | null = null;
	private lastResult: string | null = null;
	private lastError: string | null = null;

	constructor(windowSize = 4) {
		this.windowSize = windowSize;
	}

	record(sig: ToolExecutionSignal): void {
		const c = emptySignals();
		const callKey = fingerprint(sig.tool, sig.args);

		if (sig.isProviderError) {
			// Provider/infra failures tracked in their own taxonomy. They are never
			// counted as agent repeats or agent error repeats, so they cannot produce
			// a STALLED agent classification.
			c.providerFailures = 1;
		} else {
			c.totalAgentCalls = 1;
			const repeatedCall =
				this.lastCallKey === callKey && sig.result !== null && sig.result === this.lastResult;
			const repeatedError =
				sig.isError && sig.result !== null && sig.result === this.lastError;
			if (repeatedCall) c.repeatedIdenticalCalls = 1;
			if (repeatedError) c.repeatedIdenticalErrors = 1;
			if (!sig.isError) c.successfulAgentCalls = 1;
			if (sig.hasEvidence && !sig.isError) c.evidenceDelta = 1;

			// Update error / result trackers only for agent-level frames so provider
			// failures don't pollute agent repeat detection.
			if (sig.isError) {
				if (sig.result !== null) this.lastError = sig.result;
			} else if (sig.result !== null) {
				this.lastResult = sig.result;
			}
		}

		this.lastCallKey = callKey;
		this.pushCheckpoint(c);
	}

	/** Push an empty checkpoint to represent elapsed time with no tool activity. */
	rollSilence(): void {
		this.pushCheckpoint(emptySignals());
	}

	private pushCheckpoint(c: WindowedSignals): void {
		this.checkpoints.push(c);
		if (this.checkpoints.length > this.windowSize) {
			this.checkpoints = this.checkpoints.slice(-this.windowSize);
		}
	}

	/** Aggregate the current sliding window. */
	aggregate(): WindowedSignals {
		const agg = emptySignals();
		agg.windowCheckpoints = this.checkpoints.length;
		for (const c of this.checkpoints) {
			agg.evidenceDelta += c.evidenceDelta;
			agg.repeatedIdenticalCalls += c.repeatedIdenticalCalls;
			agg.repeatedIdenticalErrors += c.repeatedIdenticalErrors;
			agg.successfulAgentCalls += c.successfulAgentCalls;
			agg.totalAgentCalls += c.totalAgentCalls;
			agg.providerFailures += c.providerFailures;
		}
		return agg;
	}

	/** Reduce the sliding window to a ProgressState. */
	state(): ProgressState {
		return classifyProgress(this.aggregate());
	}

	/** Number of provider/infra failures in the current window (separate taxonomy). */
	providerFailures(): number {
		return this.aggregate().providerFailures;
	}
}
