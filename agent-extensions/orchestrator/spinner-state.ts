/**
 * Shared spinner state — single source of truth for all UI modules.
 *
 * Eliminates duplicate _spinnerIndex / SPINNER_FRAMES across:
 * - plan-panel.ts
 * - activity-feed.ts
 * - peek-overlay.ts
 * - delegate-tool.ts
 *
 * All modules import from here so spinner frames stay in sync.
 */

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export let _spinnerIndex = 0;

/** Advance spinner by one frame. Returns new index. */
export function advanceSpinner(): number {
	_spinnerIndex++;
	return _spinnerIndex;
}

/** Get current spinner index (read-only). */
export function getSpinnerIndex(): number {
	return _spinnerIndex;
}

/** Reset spinner to frame 0 (e.g. on step transition). */
export function resetSpinner(): void {
	_spinnerIndex = 0;
}

/** Get current spinner frame character. */
export function currentFrame(): string {
	return SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length];
}
