/**
 * Peek overlay (Layer 3) — live subagent conversation viewer.
 * Design spec: VISION.md → Layer 3: Subagent Peek
 *
 * When user presses Ctrl+Q, opens a right-aligned overlay showing:
 * - Subagent goal
 * - Current step from activity feed
 * - Recent tool calls (with status)
 * - Streaming text output
 *
 * Auto-scrolls, caps at ~50 lines, Escape to close, double-press x to abort.
 */

import type { ActivityFeedState } from "./types.ts";
import { SPINNER_FRAMES, getSpinnerIndex, advanceSpinner, resetSpinner } from "./spinner-state.ts";
import { formatDuration } from "./ui-utils.ts";

// Local interface subset — avoids module resolution issues with pi-tui imports.
// At runtime these are the same types from @earendil-works/pi-tui.
interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
}
interface OverlayHandle {
    hide(): void;
    setHidden(hidden: boolean): void;
    isHidden(): boolean;
}
interface TUI {
    requestRender(force?: boolean): void;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_PEEK_LINES = 50;
export const MIN_HEIGHT = 9;
const X_PRESS_WINDOW_MS = 600;

// ============================================================================
// Module-level state
// ============================================================================

let _peekLines: string[] = [];
let _peekGoal: string = "";
let _peekAbort: AbortController | null = null;
let _lastXPress: number = 0;
let _spinnerTimer: ReturnType<typeof setInterval> | null = null;

/** Stored refs for controlling the live overlay */
let _peekHandle: OverlayHandle | null = null;
let _peekComponent: PeekComponent | null = null;
let _peekTui: TUI | null = null;
let _peekDone: (() => void) | null = null;
let _peekFeedState: ActivityFeedState | null = null;

/** Feed registered by subagent-runner — used by shortcut handler */
let _registeredFeed: ActivityFeedState | null = null;
let _registeredAbort: AbortController | null = null;
let _registeredGoal: string = "";

// ============================================================================
// PeekComponent — renders live subagent content inside the overlay
// ============================================================================

export class PeekComponent implements Component {
    _theme: any = null;
    private _cachedLines: string[] | null = null;

    render(width: number): string[] {
        const lines: string[] = [];
        const innerWidth = Math.max(width - 4, 20);
        const t = this._theme;

        // visible length (strip ANSI codes)
        const vLen = (s: string): number => visibleLen(s).length;

        // Theme helpers — fallback to raw text if theme not yet set
        const mute = (s: string): string => t ? t.fg("muted", s) : s;
        const accent = (s: string): string => t ? t.fg("accent", s) : s;
        const success = (s: string): string => t ? t.fg("success", s) : s;
        const errCol = (s: string): string => t ? t.fg("error", s) : s;
        const bld = (s: string): string => t ? t.bold(s) : s;

        // Build a content line with box borders
        const box = (content: string): string =>
            `│ ${content}${' '.repeat(Math.max(0, innerWidth - vLen(content)))} │`;

        // ── Empty state ──
        if (!_peekFeedState && _peekLines.length === 0) {
            const topPad = Math.max(0, width - 4);
            lines.push(mute("┌ ") + mute("─".repeat(topPad)) + mute(" ┐"));
            lines.push(box(mute("○ Waiting for subagent...")));
            while (lines.length < MIN_HEIGHT - 1) {
                lines.push(box(""));
            }
            lines.push(mute("└─") + mute("─".repeat(Math.max(0, width - 4))) + mute("─┘"));
            this._cachedLines = lines;
            return lines;
        }

        // ── Line 0: Top border with header ──
        const goalLabel = _peekGoal || "Subagent";
        const topInnerText = ` ◆ Peek: ${goalLabel} `;
        const topInner = ` ${accent(`◆ Peek: ${bld(goalLabel)}`)} `;
        const topPad = Math.max(0, (width - 2) - vLen(topInnerText));
        lines.push(mute("┌") + topInner + mute("─".repeat(topPad)) + mute("┐"));

        // ── Line 1: Progress dots row ──
        if (_peekFeedState) {
            const feed = _peekFeedState;
            const dots = feed.steps.map((s, i) => {
                if (s.errored) return errCol("✗");
                if (s.completed) return success("●");
                if (i === feed.currentStep) {
                    const blink = Math.floor(Date.now() / 1000) % 2 === 0;
                    return blink ? accent("●") : mute("○");
                }
                return mute("○");
            }).join("");
            const doneCount = feed.steps.filter((s) => s.completed || s.errored).length;
            const countStr = ` ${doneCount}/${feed.steps.length}`;
            lines.push(box(dots + countStr));
        } else {
            // No feed — still show progress area as empty
            lines.push(box(""));
        }

        // ── Step tree (lines 2+) ──
        const MAX_VISIBLE_SUBSTEPS = 3;
        if (_peekFeedState && _peekFeedState.steps.length > 0) {
            const feed = _peekFeedState;
            for (let i = 0; i < feed.steps.length; i++) {
                const step = feed.steps[i];
                const isCompleted = !!step.completed;
                const isErrored = !!step.errored;
                const isActive = i === feed.currentStep && !isCompleted && !isErrored;
                const isPending = i > feed.currentStep || (i === feed.currentStep && !isActive && !isCompleted && !isErrored);

                // Step icon
                let stepIcon: string;
                if (isErrored) stepIcon = errCol("✗");
                else if (isCompleted) stepIcon = success("✓");
                else if (isActive) stepIcon = accent(SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]);
                else stepIcon = mute("○");

                // Step duration
                let durationStr = "";
                if (step.startTime) {
                    if (isCompleted && step.endTime) {
                        durationStr = ` (${formatDuration(step.endTime - step.startTime)})`;
                    } else if (step.startTime) {
                        durationStr = ` (${formatDuration(Date.now() - step.startTime)})`;
                    }
                }

                // Build step line
                let stepLine: string;
                if (isErrored) {
                    stepLine = errCol(`${stepIcon} Step ${i + 1}: ${step.label}${durationStr}`);
                } else if (isCompleted) {
                    stepLine = success(`${stepIcon} Step ${i + 1}: ${step.label}${durationStr}`);
                } else if (isActive) {
                    stepLine = stepIcon + ` Step ${i + 1}: ${step.label}`;
                } else {
                    stepLine = mute(`○ Step ${i + 1}: ${step.label}`);
                }
                lines.push(box(stepLine));

                // Substeps
                if (isPending) continue; // no substeps for pending

                const subs = step.substeps;
                const showSubs = subs.slice(0, MAX_VISIBLE_SUBSTEPS);
                const extraCount = subs.length - MAX_VISIBLE_SUBSTEPS;

                for (let si = 0; si < showSubs.length; si++) {
                    const sub = showSubs[si];
                    const subCompleted = !!sub.completed;
                    const subErrored = !!sub.errored;
                    const subActive = !subCompleted && !subErrored;

                    let subIcon: string;
                    if (subErrored) subIcon = errCol("✗");
                    else if (subCompleted) subIcon = success("✓");
                    else if (subActive) subIcon = accent(SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]);
                    else subIcon = mute("○");

                    const subLine = `  ${subIcon} ${sub.label}`;
                    lines.push(box(subLine));

                    // Tool detail (only for active substep with toolDetail)
                    if (subActive && sub.toolDetail) {
                        const toolIcon = accent(SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]);
                        const toolLine = `    ${toolIcon} Running: ${sub.toolDetail}`;
                        lines.push(box(toolLine));
                    }
                }

                if (extraCount > 0) {
                    lines.push(box(mute(`  …+${extraCount} more`)));
                }
            }
        }

        // ── Separator & streaming lines ──
        const hasStreaming = _peekLines.length > 0;

        if (hasStreaming) {
            // ├─ Output ──...──┤ separator
            const sepText = "─ Output ";
            const sepPad = Math.max(0, (width - 2) - vLen(sepText));
            lines.push(mute("├") + mute(sepText) + mute("─".repeat(sepPad)) + mute("┤"));

            // Streaming content lines
            const usedSoFar = lines.length;
            // Reserve 1 line for bottom border, aim for at least 3 streaming lines
            const maxStreamLines = Math.max(3, MIN_HEIGHT - usedSoFar - 2);
            const streamLines = _peekLines.slice(-maxStreamLines);
            for (const rawLine of streamLines) {
                const visLen = vLen(rawLine);
                const truncated = visLen > innerWidth
                    ? truncate(rawLine, Math.max(innerWidth - 1, 1)) + "…"
                    : rawLine;
                lines.push(box(truncated));
            }

            // Bottom border with footer
            const bottomText = "─ Esc: close  xx′: abort ";
            const bottomPad = Math.max(0, (width - 2) - vLen(bottomText));
            lines.push(mute("└") + mute(bottomText) + mute("─".repeat(bottomPad)) + mute("┘"));
        } else {
            // No streaming text — bottom border directly after step tree
            const bottomText = "─ Esc: close  xx′: abort ";
            const bottomPad = Math.max(0, (width - 2) - vLen(bottomText));
            lines.push(mute("└") + mute(bottomText) + mute("─".repeat(bottomPad)) + mute("┘"));
        }

        // Pad to MIN_HEIGHT
        while (lines.length < MIN_HEIGHT) {
            lines.push(box(""));
        }

        this._cachedLines = lines;
        return lines;
    }

    handleInput(data: string): void {
        const keyCode = data.charCodeAt(0) || 0;
        if (data === 'escape' || data === 'esc' || data === '27' || keyCode === 27 || data === '\\x1b' || data === 'ctrl+q' || data === 'C-q') {
            hidePeek();
            return;
        }

        // Double-press x → abort subagent
        if (data === "x") {
            const now = Date.now();
            if (now - _lastXPress < X_PRESS_WINDOW_MS) {
                // Double-press detected — abort
                _lastXPress = 0;
                if (_peekAbort) {
                    _peekAbort.abort();
                }
                hidePeek();
                return;
            }
            _lastXPress = now;
        }
    }

    invalidate(): void {
        this._cachedLines = null;
    }
}

// ============================================================================
// Helpers
// ============================================================================

function visibleLen(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + "…";
}

export function startSpinnerTimer(): void {
    stopSpinnerTimer();
    _spinnerTimer = setInterval(() => {
        advanceSpinner();
        if (_peekHandle && !_peekHandle.isHidden()) {
            _peekTui?.requestRender();
        }
    }, 250);
}

export function stopSpinnerTimer(): void {
    if (_spinnerTimer !== null) {
        clearInterval(_spinnerTimer);
        _spinnerTimer = null;
    }
}

function clearPeekState(): void {
    _peekLines = [];
    _peekGoal = "";
    _peekAbort = null;
    _peekFeedState = null;
    _peekHandle = null;
    _peekComponent = null;
    _peekTui = null;
    _peekDone = null;
    _lastXPress = 0;
    resetSpinner();
    stopSpinnerTimer();
}

// ============================================================================
// Feed registration — lets subagent-runner store state for shortcut access
// ============================================================================

/**
 * Register the current subagent's feed state for peek access.
 * Called by subagent-runner when a subagent starts.
 */
export function registerPeekFeed(
    feed: ActivityFeedState,
    abortController: AbortController,
    goal: string,
): void {
    _registeredFeed = feed;
    _registeredAbort = abortController;
    _registeredGoal = goal;
}

/**
 * Unregister the current subagent feed.
 * Called by delegate-tool after subagent completes.
 */
export function unregisterPeekFeed(): void {
    _registeredFeed = null;
    _registeredAbort = null;
    _registeredGoal = "";
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the peek overlay showing live subagent activity.
 * Can be called with explicit state or use previously registered feed.
 *
 * @param ctx - Extension context (needs ctx.ui.custom)
 * @param feedState - Live activity feed state (optional, uses registered feed)
 * @param abortController - AbortController for the running subagent (optional)
 * @param goal - Short goal label (optional)
 */
export function showPeek(
    ctx: { ui: { custom: any } },
    feedState?: ActivityFeedState,
    abortController?: AbortController,
    goal?: string,
): void {
    // If already open, just update the feed reference and return
    if (_peekHandle && !_peekHandle.isHidden()) {
        if (feedState) _peekFeedState = feedState;
        if (goal) _peekGoal = goal;
        if (abortController) _peekAbort = abortController;
        _peekTui?.requestRender();
        return;
    }

    // Clear any stale state
    clearPeekState();

    // Use explicit args or fall back to registered feed
    _peekFeedState = feedState ?? _registeredFeed;
    _peekGoal = goal || _registeredGoal;
    _peekAbort = abortController ?? _registeredAbort;

    const component = new PeekComponent();
    _peekComponent = component;

    ctx.ui.custom(
        (tui: TUI, theme: any, _keybindings: any, done: () => void) => {
            _peekTui = tui;
            component._theme = theme;
            _peekDone = done;
            startSpinnerTimer();
            return component;
        },
        {
            overlay: true,
            overlayOptions: {
                anchor: "right-center",
                width: "50%",
                maxHeight: "80%",
            },
            onHandle: (handle: OverlayHandle) => {
                _peekHandle = handle;
            },
        },
    ).catch((err: unknown) => {
        console.error('[peek] overlay error:', err);
        clearPeekState();
    });
}

/**
 * Push new content text into the peek overlay.
 * Splits text into lines, appends to buffer, caps at MAX_PEEK_LINES.
 * Triggers re-render.
 *
 * @param text - New content text (may contain newlines)
 */
export function updatePeek(text: string): void {
    if (!_peekHandle || _peekHandle.isHidden()) return;

    const newLines = text.split("\n");
    _peekLines.push(...newLines);

    // Cap at MAX_PEEK_LINES — trim oldest
    while (_peekLines.length > MAX_PEEK_LINES) {
        _peekLines.shift();
    }

    // Trigger TUI re-render
    _peekTui?.requestRender();
}

/**
 * Update the feed state reference (for live step/substep updates).
 * Call this when the activity feed changes.
 */
export function updatePeekFeed(feedState: ActivityFeedState): void {
    _peekFeedState = feedState;
    _peekTui?.requestRender();
}

/**
 * Update the peek goal label.
 */
export function setPeekGoal(goal: string): void {
    _peekGoal = goal;
    _peekTui?.requestRender();
}

/**
 * Close the peek overlay and clean up all state.
 */
export function hidePeek(): void {
    stopSpinnerTimer();
    if (_peekHandle) {
        try { _peekHandle.hide(); } catch (err: unknown) { console.error('[peek] hide error:', err); }
    }
    clearPeekState();
}

/**
 * Check if the peek overlay is currently open.
 */
export function isPeekOpen(): boolean {
    return _peekHandle !== null && !_peekHandle.isHidden();
}

/**
 * Return the feed currently registered for peek access, if any.
 */
export function getRegisteredFeed(): ActivityFeedState | null {
    return _registeredFeed;
}
