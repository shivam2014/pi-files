/**
 * Unit tests for render-scheduler.ts — the shared coalescing render driver.
 *
 * Verify: one shared timer drives N channels; teardown clears the timer; the
 * window is configurable; a failing channel does not starve the others.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	registerChannel,
	unregisterChannel,
	isSchedulerRunning,
	registeredChannels,
	setWindowMs,
	_resetScheduler,
	RENDER_WINDOW_MS,
} from "./render-scheduler.ts";

beforeEach(() => {
	_resetScheduler();
});

afterEach(() => {
	_resetScheduler();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("render-scheduler — window", () => {
	it("RENDER_WINDOW_MS matches the 80 ms spinner cadence", () => {
		expect(RENDER_WINDOW_MS).toBe(80);
	});
});

describe("render-scheduler — single shared timer", () => {
	it("arms exactly one interval no matter how many channels register", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

		registerChannel("plan:1", () => {});
		registerChannel("delegate:1", () => {});
		registerChannel("peek", () => {});

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(registeredChannels().sort()).toEqual(["delegate:1", "peek", "plan:1"]);
		expect(isSchedulerRunning()).toBe(true);
	});

	it("N channels are all flushed once per window tick", () => {
		vi.useFakeTimers();
		const plan = vi.fn();
		const delegate = vi.fn();
		const peek = vi.fn();
		registerChannel("plan:1", plan);
		registerChannel("delegate:1", delegate);
		registerChannel("peek", peek);

		vi.advanceTimersByTime(RENDER_WINDOW_MS);
		expect(plan).toHaveBeenCalledTimes(1);
		expect(delegate).toHaveBeenCalledTimes(1);
		expect(peek).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(RENDER_WINDOW_MS * 2);
		expect(plan).toHaveBeenCalledTimes(3);
		expect(delegate).toHaveBeenCalledTimes(3);
		expect(peek).toHaveBeenCalledTimes(3);
	});
});

describe("render-scheduler — teardown", () => {
	it("stops the shared timer only when the last channel unregisters", () => {
		vi.useFakeTimers();
		registerChannel("plan:1", () => {});
		registerChannel("delegate:1", () => {});
		expect(isSchedulerRunning()).toBe(true);

		unregisterChannel("plan:1");
		expect(isSchedulerRunning()).toBe(true);

		unregisterChannel("delegate:1");
		expect(isSchedulerRunning()).toBe(false);
		expect(registeredChannels()).toEqual([]);
	});

	it("does not flush an unregistered channel after teardown (no leaked timer)", () => {
		vi.useFakeTimers();
		const flush = vi.fn();
		registerChannel("plan:1", flush);
		unregisterChannel("plan:1");

		vi.advanceTimersByTime(RENDER_WINDOW_MS * 5);
		expect(flush).not.toHaveBeenCalled();
	});

	it("_resetScheduler clears channels and stops the timer", () => {
		vi.useFakeTimers();
		registerChannel("plan:1", () => {});
		_resetScheduler();
		expect(isSchedulerRunning()).toBe(false);
		expect(registeredChannels()).toEqual([]);
	});
});

describe("render-scheduler — channel replacement", () => {
	it("re-registering the same key replaces the callback without a second timer", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const first = vi.fn();
		const second = vi.fn();

		registerChannel("plan:1", first);
		registerChannel("plan:1", second);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(RENDER_WINDOW_MS);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});
});

describe("render-scheduler — fault isolation", () => {
	it("a throwing channel does not starve the other channels", () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const bad = vi.fn(() => {
			throw new Error("boom");
		});
		const good = vi.fn();

		registerChannel("bad", bad);
		registerChannel("good", good);

		vi.advanceTimersByTime(RENDER_WINDOW_MS);
		expect(good).toHaveBeenCalledTimes(1);
		expect(errSpy).toHaveBeenCalled();

		// Next window still flushes both.
		vi.advanceTimersByTime(RENDER_WINDOW_MS);
		expect(bad).toHaveBeenCalledTimes(2);
		expect(good).toHaveBeenCalledTimes(2);
	});

	it("a channel that unregisters itself mid-flush does not corrupt iteration", () => {
		vi.useFakeTimers();
		const b = vi.fn();
		const a = vi.fn(() => {
			unregisterChannel("b");
		});
		registerChannel("a", a);
		registerChannel("b", b);

		vi.advanceTimersByTime(RENDER_WINDOW_MS);
		// a unregistered b during the flush, but b was snapshotted for this tick.
		expect(b).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(RENDER_WINDOW_MS);
		expect(b).toHaveBeenCalledTimes(1); // gone on subsequent ticks
		expect(a).toHaveBeenCalledTimes(2);
	});
});

describe("render-scheduler — configurable window", () => {
	it("setWindowMs changes the flush cadence", () => {
		vi.useFakeTimers();
		setWindowMs(20);
		const flush = vi.fn();
		registerChannel("plan:1", flush);

		vi.advanceTimersByTime(20);
		expect(flush).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(20);
		expect(flush).toHaveBeenCalledTimes(2);
	});
});
