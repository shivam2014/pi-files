/**
 * Peek overlay (Layer 3) — live subagent conversation viewer.
 * Design spec: VISION.md → Layer 3: Subagent Peek
 *
 * When user presses Ctrl+Q, opens a right-aligned overlay showing:
 * - Subagent goal
 * - Conversation messages from session
 * - Streaming text output
 *
 * Auto-scrolls, caps at ~50 lines, Escape to close, double-press x to abort.
 */

import { SPINNER_FRAMES, resetSpinner, currentFrame } from "./spinner-state.ts";
import { formatDuration } from "./ui-utils.ts";
import { styledSymbol, statusIcon, getTheme, formatTokens } from "./orchestrator-theme.ts";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

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
export const MIN_HEIGHT = 15;
const X_PRESS_WINDOW_MS = 600;
const STREAMING_BUFFER_MAX = 5000;

// ============================================================================
// Module-level state
// ============================================================================

let _peekLines: string[] = [];
let _peekGoal: string = "";
let _peekAbort: AbortController | null = null;
let _lastXPress: number = 0;
let _streamingBuffer: string = "";
/** Timer for debouncing pushStreamingText re-renders */
let _pushRenderTimer: ReturnType<typeof setTimeout> | null = null;

/** Stored refs for controlling the live overlay */
let _peekHandle: OverlayHandle | null = null;
let _peekComponent: PeekComponent | null = null;
let _peekTui: TUI | null = null;
let _peekDone: (() => void) | null = null;

/** Viewer state — conversation from session messages */
let _viewerSession: any | null = null;
let _viewerTask: string = "";
let _viewerOutput: string = "";
let _viewerStatus: "idle" | "running" | "completed" | "error" = "idle";

/** Token state for header display */
let _viewerTokens: { input: number; output: number; cached: number; ctxTokens?: number; ctxWindow?: number } | null = null;


// ============================================================================
// PeekComponent — renders live subagent content inside the overlay
// ============================================================================

export class PeekComponent implements Component {
    _theme: Theme | null = null;

    render(width: number): string[] {
        const lines: string[] = [];
        const innerWidth = Math.max(width - 4, 20);
        const t = this._theme;

        const vLen = (s: string): number => visibleLen(s).length;
        const mute = (s: string): string => t ? t.fg("muted", s) : s;
        const accent = (s: string): string => t ? t.fg("accent", s) : s;
        const success = (s: string): string => t ? t.fg("success", s) : s;
        const errCol = (s: string): string => t ? t.fg("error", s) : s;
        const bld = (s: string): string => t ? t.bold(s) : s;
        const dim = (s: string): string => t ? t.fg("dim", s) : s;

        const box = (content: string): string =>
            `│ ${content}${' '.repeat(Math.max(0, innerWidth - vLen(content)))} │`;

        // ── Empty state ──
        if (!_viewerSession && _peekLines.length === 0 && !_viewerOutput) {
            const topPad = Math.max(0, width - 4);
            lines.push(mute(styledSymbol("boxRound.topLeft") + " ") + mute(styledSymbol("boxRound.horizontal").repeat(topPad)) + mute(" " + styledSymbol("boxRound.topRight")));
            lines.push(box(mute(statusIcon("pending") + " Waiting for subagent...")));
            while (lines.length < MIN_HEIGHT - 1) {
                lines.push(box(""));
            }
            lines.push(mute(styledSymbol("boxRound.bottomLeft") + styledSymbol("boxRound.horizontal")) + mute(styledSymbol("boxRound.horizontal").repeat(Math.max(0, width - 4))) + mute(styledSymbol("boxRound.horizontal") + styledSymbol("boxRound.bottomRight")));
            return lines;
        }

        // ── Header ──
        const goalLabel = _viewerTask || _peekGoal || "Subagent";
        const topInnerText = ` ◆ ${goalLabel} `;
        const topPad = Math.max(0, (width - 2) - vLen(topInnerText));
        lines.push(mute(styledSymbol("boxRound.topLeft")) + accent(styledSymbol("icon.goal")) + ` ${bld(goalLabel)} ` + mute(styledSymbol("boxRound.horizontal").repeat(topPad)) + mute(styledSymbol("boxRound.topRight")));

        // Status line
        let statusText = "";
        if (_viewerStatus === "running") statusText = statusIcon("running") + " Running";
        else if (_viewerStatus === "completed") statusText = statusIcon("completed") + " Completed";
        else if (_viewerStatus === "error") statusText = statusIcon("error") + " Error";
        if (statusText) lines.push(box(statusText));

        // Token line
        if (_viewerTokens) {
            const parts: string[] = [];
            if (_viewerTokens.input) parts.push(`↑${formatTokens(_viewerTokens.input)}`);
            if (_viewerTokens.cached) {
                parts.push(`⇄${formatTokens(_viewerTokens.cached)}`);
                const input = _viewerTokens.input ?? 0;
                const total = input + _viewerTokens.cached;
                const pct = Math.round(_viewerTokens.cached / total * 100);
                parts.push(`CH${pct}%`);
            }
            if (_viewerTokens.output) parts.push(`↓${formatTokens(_viewerTokens.output)}`);
            if (_viewerTokens.ctxTokens) {
                if (_viewerTokens.ctxWindow) {
                    parts.push(`↕${formatTokens(_viewerTokens.ctxTokens)}/${formatTokens(_viewerTokens.ctxWindow)}`);
                } else {
                    parts.push(`↕${formatTokens(_viewerTokens.ctxTokens)}`);
                }
            }
            if (parts.length > 0) {
                lines.push(box(parts.join(" ")));
            }
        }

        // ── Build content lines from session messages ──
        const contentLines: string[] = [];

        // Part 1: Session messages (committed history)
        if (_viewerSession) {
            const session = _viewerSession as any;
            const messages: any[] = session.state?.messages ?? session.messages ?? [];

            for (const msg of messages) {
                // Handle different role formats
                const role = typeof msg.role === "string" ? msg.role : "";

                if (role === "user") {
                    const text = extractMsgText(msg.content ?? msg.text ?? "");
                    if (!text?.trim()) continue;
                    contentLines.push(accent("[User]"));
                    const wrapped = wrapText(text.trim(), innerWidth - 2);
                    contentLines.push(dim(styledSymbol('boxRound.horizontal').repeat(3)));
                } else if (role === "assistant") {
                    contentLines.push(bld("[Assistant]"));
                    // Try multiple content formats
                    let textParts: string[] = [];
                    let tools: string[] = [];

                    const content = msg.content ?? [];
                    if (typeof content === "string") {
                        textParts.push(content);
                    } else if (Array.isArray(content)) {
                        for (const part of content) {
                            if (part.type === "text" && part.text) textParts.push(part.text);
                            if (part.type === "inputText" && part.text) textParts.push(part.text);
                            const toolName = part.name ?? part.toolName ?? part.tool_use?.name ?? "";
                            if ((part.type === "toolUse" || part.type === "toolCall" || part.type === "tool_use") && toolName) {
                                tools.push(toolName);
                            }
                        }
                    }
                    if (textParts.length > 0) {
                        const wrapped = wrapText(textParts.join("\n").trim(), innerWidth - 2);
                        for (const line of wrapped) contentLines.push(` ${line}`);
                    }
                    for (const name of tools) {
                        contentLines.push(dim(`  [Tool: ${name}]`));
                    }
                    contentLines.push(dim(styledSymbol('boxRound.horizontal').repeat(3)));
                } else if (role === "toolResult" || role === "tool_result" || role === "tool") {
                    const text = extractMsgText(msg.content ?? msg.text ?? "");
                    if (!text?.trim()) continue;
                    const truncated = text.length > 500 ? text.slice(0, 500) + dim("... (truncated)") : text;
                    contentLines.push(dim("[Result]"));
                    const wrapped = wrapText(truncated.trim(), innerWidth - 2);
                    for (const line of wrapped) contentLines.push(dim(` ${line}`));
                    contentLines.push(dim(styledSymbol('boxRound.horizontal').repeat(3)));
                }
            }
        }

        // Part 3: Streaming model text (continuous, word-wrapped)
        if (_streamingBuffer.length > 0) {
            // Show last 800 chars of streaming buffer
            const displayText = _streamingBuffer.length > 800 
                ? "…" + _streamingBuffer.slice(-800) 
                : _streamingBuffer;
            const wrapped = wrapText(displayText, innerWidth - 2);
            for (const line of wrapped) {
                contentLines.push(line);
            }
        }

        // Part 4: Output section (completed/error)
        if (_viewerOutput) {
            if (contentLines.length > 0) {
                contentLines.push(dim("─ output ─"));
            }
            const prefix = _viewerStatus === "error" ? `${statusIcon("error")} ` : `${statusIcon("completed")} `;
            contentLines.push(prefix + truncate(_viewerOutput, Math.max(innerWidth - 2, 10)));
        }

        // ── Fallback ──
        if (contentLines.length === 0) {
            if (_viewerStatus === "running") {
                contentLines.push(dim("Waiting for subagent output..."));
            } else if (_viewerStatus === "idle") {
                contentLines.push(getTheme().fg("dim", statusIcon("pending") + " Waiting for subagent..."));
            }
        }

        // ── Render visible content lines ──
        const usedSoFar = lines.length;
        const maxContent = Math.max(3, MIN_HEIGHT - usedSoFar - 2);
        const visibleLines = contentLines.slice(-maxContent);
        for (const line of visibleLines) {
            lines.push(box(line));
        }

        // ── Bottom border ──
        const bottomText = "─ Esc: close  xx′: abort ";
        const bottomPad = Math.max(0, (width - 2) - vLen(bottomText));
        lines.push(mute(styledSymbol("boxRound.bottomLeft")) + mute(bottomText) + mute(styledSymbol("boxRound.horizontal").repeat(bottomPad)) + mute(styledSymbol("boxRound.bottomRight")));

        // Pad to MIN_HEIGHT
        while (lines.length < MIN_HEIGHT) {
            lines.push(box(""));
        }

        return lines;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("q"))) {
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
        // Cache invalidation handled by callers before requestRender
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

function extractMsgText(content: any): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const texts = content
            .filter((p: any) => (p.type === "text" || p.type === "inputText") && p.text)
            .map((p: any) => p.text);
        if (texts.length > 0) return texts.join("\n");
        // Fallback: try any text-like field
        for (const p of content) {
            if (typeof p === "string") return p;
            if (p.text) return String(p.text);
            if (p.content) return extractMsgText(p.content);
        }
        return "";
    }
    if (typeof content === "object") {
        // Single content block
        if (content.text) return String(content.text);
        if (content.content) return extractMsgText(content.content);
        return JSON.stringify(content).slice(0, 200);
    }
    return String(content).slice(0, 500);
}

function wrapText(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        if (paragraph.length === 0) { lines.push(""); continue; }
        let start = 0;
        while (start < paragraph.length) {
            const end = Math.min(start + width, paragraph.length);
            if (end < paragraph.length && paragraph[end] !== " " && paragraph[end - 1] !== " ") {
                const spaceIdx = paragraph.lastIndexOf(" ", end);
                if (spaceIdx > start) {
                    lines.push(paragraph.slice(start, spaceIdx));
                    start = spaceIdx + 1;
                    continue;
                }
            }
            lines.push(paragraph.slice(start, end));
            start = end;
        }
    }
    return lines;
}


function clearPeekState(): void {
    _peekLines = [];
    _streamingBuffer = "";
    _peekGoal = "";
    _peekAbort = null;
    _peekHandle = null;
    _peekComponent = null;
    _peekTui = null;
    _peekDone = null;
    _lastXPress = 0;
    _viewerSession = null;
    _viewerTask = "";
    _viewerOutput = "";
    _viewerStatus = "idle";
    _viewerTokens = null;
    _pushRenderTimer = null;
    resetSpinner();
}

// ============================================================================
// Viewer state API
// ============================================================================

/**
 * Set the session to display in the viewer.
 */
export function setViewerSession(session: any, task: string): void {
    _viewerSession = session;
    _viewerTask = task;
    _viewerStatus = "running";
    _viewerTokens = null;
    scheduleRender();
}

/**
 * Set token data for the viewer header.
 */
export function setViewerTokens(tokens: { input: number; output: number; cached: number; ctxTokens?: number; ctxWindow?: number } | null): void {
    _viewerTokens = tokens;
    scheduleRender();
}

/**
 * Set the viewer output on completion.
 */
export function setViewerOutput(output: string): void {
    _viewerOutput = output;
    _viewerStatus = "completed";
    scheduleRender();
}

/**
 * Set the viewer error state.
 */
export function setViewerError(error: string): void {
    _viewerOutput = error;
    _viewerStatus = "error";
    scheduleRender();
}



/**
 * Clear the viewer state.
 */
export function clearViewerState(): void {
    _viewerSession = null;
    _viewerTask = "";
    _viewerOutput = "";
    _viewerStatus = "idle";
    scheduleRender();
}

// Shared render scheduler — coalesces multiple rapid invalidate+requestRender
// calls into a single microtask, preventing compounding render triggers.
let _renderScheduled = false;
function scheduleRender(): void {
    if (_renderScheduled) return;
    _renderScheduled = true;
    queueMicrotask(() => {
        _renderScheduled = false;
        _peekComponent?.invalidate();
        _peekTui?.requestRender();
    });
}

// ============================================================================
// Spinner timer — drives re-renders so time-based spinner frames update visually
// ============================================================================

let _spinnerTimer: ReturnType<typeof setInterval> | null = null;

export function stopSpinnerTimer(): void {
    if (_spinnerTimer !== null) {
        clearInterval(_spinnerTimer);
        _spinnerTimer = null;
    }
}

export function startSpinnerTimer(): void {
    stopSpinnerTimer();
    _spinnerTimer = setInterval(() => {
        scheduleRender();
    }, 80);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the peek overlay showing live subagent activity.
 *
 * @param ctx - Extension context (needs ctx.ui.custom)
 * @param _feedState - Ignored (kept for backward compat)
 * @param abortController - AbortController for the running subagent (optional)
 * @param goal - Short goal label (optional)
 */
export function showPeek(
    ctx: { ui: { custom: any } },
    _feedState?: any,
    abortController?: AbortController,
    goal?: string,
): void {
    // If already open, just update references and return
    if (_peekHandle && !_peekHandle.isHidden()) {
        if (goal) _peekGoal = goal;
        if (abortController) _peekAbort = abortController;
        _peekComponent?.invalidate();
        _peekTui?.requestRender();
        return;
    }

    // Clear any stale state
    clearPeekState();

    // Use explicit args
    if (goal) _peekGoal = goal;
    if (abortController) _peekAbort = abortController;

    const component = new PeekComponent();
    _peekComponent = component;

    ctx.ui.custom(
        (tui: TUI, theme: any, _keybindings: any, done: () => void) => {
            _peekTui = tui;
            component._theme = theme;
            _peekDone = done;
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
    scheduleRender();
}

/**
 * Push streaming model text — accumulates into a continuous buffer
 * that gets word-wrapped when rendered. Unlike updatePeek which
 * creates individual lines, this prevents one-word-per-line issues.
 */
export function pushStreamingText(text: string): void {
    if (!_peekHandle || _peekHandle.isHidden()) return;
    _streamingBuffer += text;
    
    // GC: trim oldest text when buffer exceeds max
    if (_streamingBuffer.length > STREAMING_BUFFER_MAX) {
        _streamingBuffer = _streamingBuffer.slice(-STREAMING_BUFFER_MAX);
    }
    
    // Debounce re-renders during rapid streaming — max ~5fps
    if (_pushRenderTimer) clearTimeout(_pushRenderTimer);
    _pushRenderTimer = setTimeout(() => {
        _pushRenderTimer = null;
        scheduleRender();
    }, 200);
}

/**
 * Update the peek goal label.
 */
export function setPeekGoal(goal: string): void {
    _peekGoal = goal;
    scheduleRender();
}

/**
 * Close the peek overlay and clean up all state.
 */
export function hidePeek(): void {
    if (_pushRenderTimer) {
        clearTimeout(_pushRenderTimer);
        _pushRenderTimer = null;
    }
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
