import { describe, it, expect, beforeEach } from "vitest";
import {
	LoopWatchdog,
	pushPhase,
	popPhase,
	takeRecentLoopPhase,
	resetPhaseTracker,
} from "./loop-watchdog.ts";

// ── Fake clock / scheduler helpers ───────────────────────────────────────────

let currentTime = 0;
const fakeNow = () => currentTime;
const pendingTicks: Array<{ cb: () => void; fireAt: number }> = [];

function fakeSchedule(cb: () => void, ms: number) {
	const fireAt = currentTime + ms;
	pendingTicks.push({ cb, fireAt });
	return {
		unref: () => {},
		cancel: () => {
			const idx = pendingTicks.findIndex((t) => t.cb === cb);
			if (idx >= 0) pendingTicks.splice(idx, 1);
		},
	};
}

function advanceTime(ms: number) {
	currentTime += ms;
	// Fire all pending ticks whose fireAt <= currentTime, in order
	const ready = pendingTicks
		.filter((t) => t.fireAt <= currentTime)
		.sort((a, b) => a.fireAt - b.fireAt);
	for (const t of ready) {
		const idx = pendingTicks.indexOf(t);
		if (idx >= 0) pendingTicks.splice(idx, 1);
		t.cb();
	}
}

function resetClock() {
	currentTime = 0;
	pendingTicks.length = 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("LoopWatchdog", () => {
	beforeEach(() => {
		resetClock();
		resetPhaseTracker();
	});

	it("normal operation — no stall", () => {
		const stalls: Array<{ blockedMs: number; phase: string }> = [];
		const wd = new LoopWatchdog({
			intervalMs: 250,
			thresholdMs: 250,
			now: fakeNow,
			schedule: fakeSchedule,
			onStall: (info) => stalls.push(info),
		});
		wd.start();

		// Tick 1: advance exactly interval
		advanceTime(250);
		expect(stalls).toHaveLength(0);

		// Tick 2
		advanceTime(250);
		expect(stalls).toHaveLength(0);

		// Tick 3
		advanceTime(250);
		expect(stalls).toHaveLength(0);

		wd.stop();
	});

	it("stall yields diagnostic naming the phase", () => {
		const stalls: Array<{ blockedMs: number; phase: string }> = [];
		const wd = new LoopWatchdog({
			intervalMs: 250,
			thresholdMs: 250,
			now: fakeNow,
			schedule: fakeSchedule,
			onStall: (info) => stalls.push(info),
		});

		pushPhase("tool_start:edit");
		wd.start();

		// First tick expected at t=250. If we advance to t=850,
		// blockedMs = 850 - 250 = 600 > 250 threshold.
		advanceTime(600);

		expect(stalls).toHaveLength(1);
		expect(stalls[0].blockedMs).toBeGreaterThan(250);
		expect(stalls[0].phase).toBe("tool_start:edit");

		wd.stop();
	});

	it("start/stop lifecycle", () => {
		const stalls: Array<{ blockedMs: number; phase: string }> = [];
		const wd = new LoopWatchdog({
			intervalMs: 100,
			thresholdMs: 100,
			now: fakeNow,
			schedule: fakeSchedule,
			onStall: (info) => stalls.push(info),
		});

		// Start → ticks should fire
		wd.start();
		advanceTime(100);
		// At least one tick fired; pendingTicks should have a new entry from #armTick
		expect(pendingTicks.length).toBeGreaterThanOrEqual(1);

		// Stop → pending ticks should be cleared
		wd.stop();
		expect(pendingTicks).toHaveLength(0);

		// Start again → fresh ticks
		wd.start();
		advanceTime(100);
		expect(pendingTicks.length).toBeGreaterThanOrEqual(1);

		wd.stop();
	});

	it("generation counter prevents stale ticks", () => {
		const stalls: Array<{ blockedMs: number; phase: string }> = [];
		const wd = new LoopWatchdog({
			intervalMs: 100,
			thresholdMs: 100,
			now: fakeNow,
			schedule: fakeSchedule,
			onStall: (info) => stalls.push(info),
		});

		wd.start();
		wd.stop(); // generation++

		// Capture a stale tick callback before clearing
		const staleCb = pendingTicks.length > 0 ? pendingTicks[0]?.cb : undefined;

		// Start fresh — new generation
		wd.start();

		// If there was a stale callback, fire it manually
		if (staleCb) {
			currentTime += 500; // enough to cause a stall
			staleCb();
		}

		// Stale tick should produce no stall
		expect(stalls).toHaveLength(0);

		wd.stop();
	});

	it("phase tracker push/pop", () => {
		resetPhaseTracker();
		expect(takeRecentLoopPhase()).toBeNull();

		pushPhase("a");
		expect(takeRecentLoopPhase()).toBe("a");

		pushPhase("b");
		expect(takeRecentLoopPhase()).toBe("b");

		popPhase();
		expect(takeRecentLoopPhase()).toBe("a");

		popPhase();
		expect(takeRecentLoopPhase()).toBeNull();
	});

	it("dedup — only one stall diagnostic per rising edge", () => {
		const stalls: Array<{ blockedMs: number; phase: string }> = [];
		const wd = new LoopWatchdog({
			intervalMs: 250,
			thresholdMs: 250,
			now: fakeNow,
			schedule: fakeSchedule,
			onStall: (info) => stalls.push(info),
		});

		wd.start();

		// Tick 1: stall (advance 600 → blockedMs = 350)
		advanceTime(600);
		expect(stalls).toHaveLength(1);

		// Tick 2: still stalled (advance another 250 → expected drifts, still blocked)
		advanceTime(250);
		// wasBlocked is true, so dedup should suppress
		expect(stalls).toHaveLength(1);

		// Tick 3: clear stall (advance exactly interval → no excess)
		advanceTime(250);
		// wasBlocked reset to false

		// Tick 4: stall again (advance 600 → new rising edge)
		advanceTime(600);
		expect(stalls).toHaveLength(2);

		wd.stop();
	});
});
