/**
 * render-scheduler.ts — single shared coalescing render driver.
 *
 * Problem it solves: the extension ran several independent `setInterval`
 * render drivers (plan-panel spinner, delegate-tool spinner, peek-overlay
 * spinner), each firing its own `invalidate()` / `_renderWidget()` /
 * `requestRender()` on its own 80 ms cadence. Up to three timers fired
 * independently during a live delegation, each emitting a separate re-render.
 *
 * This module replaces those N independent timers with ONE shared timer that
 * flushes every registered channel once per window — N triggers driven by a
 * single timer.
 *
 * Design:
 *   - Each caller registers a *named channel* with its own flush callback.
 *   - The caller keeps its own *reason* to render (spinner frame advance,
 *     elapsed refresh, stream delta); only the emission cadence is shared.
 *   - While at least one channel is registered, one shared `setInterval`
 *     runs. On each tick it flushes every registered channel exactly once.
 *   - When the last channel unregisters, the shared timer is cleared — no
 *     leaked timers after a delegation ends.
 *
 * The spinner frame index is derived from wall-clock time (see
 * `spinner-state.ts`), not a mutable counter, so the 80 ms animation cadence
 * is unaffected by which timer triggers the flush.
 *
 * NOTE: this is a cadence-only refactor. It does not change what any caller
 * renders — only when/how often the render is emitted.
 */

import { SPINNER_INTERVAL_MS } from "./spinner-state.ts";

/** Default coalescing window (ms) — matches the 80 ms spinner cadence. */
export const RENDER_WINDOW_MS = SPINNER_INTERVAL_MS;

/** A channel flush callback: does the caller-specific render work. */
export type FlushFn = () => void;

const _channels = new Map<string, FlushFn>();
let _timer: ReturnType<typeof setInterval> | null = null;
let _windowMs = RENDER_WINDOW_MS;

/** Flush every registered channel once. Snapshot the keys so a channel that
 *  unregisters itself (or another) mid-flush does not corrupt iteration. */
function _flushAll(): void {
	for (const [key, flush] of Array.from(_channels)) {
		try {
			flush();
		} catch (err) {
			console.error(`[render-scheduler] channel "${key}" flush failed:`, err);
		}
	}
}

function _ensureTimer(): void {
	if (_timer === null && _channels.size > 0) {
		_timer = setInterval(_flushAll, _windowMs);
	}
}

function _stopTimer(): void {
	if (_timer !== null) {
		clearInterval(_timer);
		_timer = null;
	}
}

/**
 * Register (or replace) a periodic render channel.
 *
 * While at least one channel is registered the shared timer runs and flushes
 * every channel once per window. Registering a key that already exists
 * replaces its flush callback (and does not arm a second timer).
 *
 * @param key   Stable identifier for the channel (e.g. "plan:1", "delegate:2").
 * @param flush Callback that performs the caller-specific render.
 */
export function registerChannel(key: string, flush: FlushFn): void {
	_channels.set(key, flush);
	_ensureTimer();
}

/**
 * Unregister a channel. When the last channel is removed the shared timer is
 * cleared — this is the single teardown point that prevents leaked timers.
 */
export function unregisterChannel(key: string): void {
	_channels.delete(key);
	if (_channels.size === 0) _stopTimer();
}

/** True while the shared timer is armed. Diagnostics/tests. */
export function isSchedulerRunning(): boolean {
	return _timer !== null;
}

/** Snapshot of registered channel keys. Diagnostics/tests. */
export function registeredChannels(): string[] {
	return Array.from(_channels.keys());
}

/**
 * Override the coalescing window (ms). Restarts the shared timer if running.
 */
export function setWindowMs(ms: number): void {
	_windowMs = ms;
	if (_timer !== null) {
		_stopTimer();
		_ensureTimer();
	}
}

/** Clears all channels and stops the shared timer. Test-only. */
export function _resetScheduler(): void {
	_channels.clear();
	_stopTimer();
	_windowMs = RENDER_WINDOW_MS;
}
