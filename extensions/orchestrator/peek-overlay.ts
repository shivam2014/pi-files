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

class PeekComponent implements Component {
    private _cachedLines: string[] | null = null;

    render(width: number): string[] {
        const lines: string[] = [];
        const innerWidth = Math.max(width - 4, 20);

        // ── Header ──
        const goalLabel = _peekGoal || "Subagent";
        lines.push(`\x1b[1m◆ Peek: ${goalLabel}\x1b[0m`);
        lines.push("─".repeat(innerWidth));

        // ── Current step from feed ──
        if (_peekFeedState) {
            const feed = _peekFeedState;
            if (feed.steps.length > 0 && feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
                const step = feed.steps[feed.currentStep];
                const icon = step.completed ? "✓" : SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length];
                lines.push(`${icon} Step: ${truncate(step.label, innerWidth - 8)}`);

                // Show recent substeps (last 3)
                const recentSubs = step.substeps.slice(-3);
                for (const sub of recentSubs) {
                    const subIcon = sub.completed ? "✓" : SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length];
                    const subLabel = truncate(sub.label, innerWidth - 6);
                    lines.push(`  ${subIcon} ${subLabel}`);
                }
            }

            // Show completed step count
            const completed = feed.steps.filter((s) => s.completed).length;
            if (feed.steps.length > 1) {
                lines.push(`  [${completed}/${feed.steps.length} steps]`);
            }
        }

        // ── Separator ──
        if (_peekLines.length > 0 || _peekFeedState) {
            lines.push("─".repeat(innerWidth));
        }

        // ── Streaming content lines (capped) ──
        if (_peekLines.length > 0) {
            // Show most recent lines that fit within budget
            const budget = MAX_PEEK_LINES - lines.length - 2; // reserve for footer
            const visibleLines = _peekLines.slice(-Math.max(budget, 10));
            for (const line of visibleLines) {
                lines.push(truncate(line, innerWidth));
            }
        }

        // ── Footer ──
        lines.push("─".repeat(innerWidth));
        const footer = "Esc: close  xx\u2032: abort";
        lines.push(footer);

        this._cachedLines = lines;
        return lines;
    }

    handleInput(data: string): void {
        // Escape → close overlay
        if (data === "escape" || data === "esc") {
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

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + "…";
}

function startSpinnerTimer(): void {
    stopSpinnerTimer();
    _spinnerTimer = setInterval(() => {
        advanceSpinner();
        _peekTui?.requestRender();
    }, 80);
}

function stopSpinnerTimer(): void {
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
        (tui: TUI, _theme: any, _keybindings: any, done: () => void) => {
            _peekTui = tui;
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
    ).catch(() => {
        // Overlay dismissed — clean up silently
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
        try { _peekHandle.hide(); } catch {}
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
