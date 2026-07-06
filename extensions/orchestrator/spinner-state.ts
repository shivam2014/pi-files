/**
 * Shared spinner state — single source of truth for all UI modules.
 *
 * Spinner frame is derived from wall-clock time, not a mutable counter.
 * This eliminates the need for modules to call advanceSpinner() at 80ms
 * intervals, and prevents the double-tick artifact when multiple timers
 * run concurrently.
 *
 * Frame = SPINNER_FRAMES[⌊(now - startTime) / SPINNER_INTERVAL_MS⌋ % N]
 *
 * All modules that need a spinner frame call currentFrame() at render time.
 * The frame is always correct regardless of which timer triggers the render.
 */

export const SPINNER_INTERVAL_MS = 80;
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let _spinnerStartTime = Date.now();

/** Get current spinner frame character — purely time-derived. */
export function currentFrame(): string {
	return SPINNER_FRAMES[Math.floor((Date.now() - _spinnerStartTime) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
}

/** Reset spinner to frame 0 (e.g. on step transition). */
export function resetSpinner(): void {
	_spinnerStartTime = Date.now();
}
