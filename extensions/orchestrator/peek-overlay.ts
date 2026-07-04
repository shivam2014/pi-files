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
 *
 * ARCH-005: State is encapsulated in PeekSession class instances.
 * Module-level singleton state is replaced by a session-keyed registry.
 * Exported API remains backward-compatible — delegates to `_current` session.
 */

import { SPINNER_FRAMES, getSpinnerIndex, advanceSpinner, resetSpinner } from "./spinner-state.ts";
import { formatDuration } from "./ui-utils.ts";
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
const MAX_SESSIONS = 10;

// ============================================================================
// PeekSession — encapsulates all state for one peek overlay instance
// ============================================================================

class PeekSession {
    private _lines: string[] = [];
    private _goal: string = "";
    private _abort: AbortController | null = null;
    private _lastXPress: number = 0;
    private _streamingBuffer: string = "";
    private _handle: OverlayHandle | null = null;
    private _component: PeekComponent | null = null;
    private _tui: TUI | null = null;
    private _done: (() => void) | null = null;
    private _viewerSession: any | null = null;
    private _viewerTask: string = "";
    private _viewerOutput: string = "";
    private _viewerStatus: "idle" | "running" | "completed" | "error" = "idle";

    // -- Getters (for PeekComponent rendering) --

    get lines(): string[] { return this._lines; }
    get goal(): string { return this._goal; }
    get abort(): AbortController | null { return this._abort; }
    get lastXPress(): number { return this._lastXPress; }
    get streamingBuffer(): string { return this._streamingBuffer; }
    get handle(): OverlayHandle | null { return this._handle; }
    get component(): PeekComponent | null { return this._component; }
    get tui(): TUI | null { return this._tui; }
    get done(): (() => void) | null { return this._done; }
    get viewerSession(): any { return this._viewerSession; }
    get viewerTask(): string { return this._viewerTask; }
    get viewerOutput(): string { return this._viewerOutput; }
    get viewerStatus(): "idle" | "running" | "completed" | "error" { return this._viewerStatus; }

    // -- Setters --

    set goal(v: string) { this._goal = v; }
    set abort(v: AbortController | null) { this._abort = v; }
    set lastXPress(v: number) { this._lastXPress = v; }
    set streamingBuffer(v: string) { this._streamingBuffer = v; }
    set handle(v: OverlayHandle | null) { this._handle = v; }
    set component(v: PeekComponent | null) { this._component = v; }
    set tui(v: TUI | null) { this._tui = v; }
    set done(v: (() => void) | null) { this._done = v; }
    set viewerSession(v: any) { this._viewerSession = v; }
    set viewerTask(v: string) { this._viewerTask = v; }
    set viewerOutput(v: string) { this._viewerOutput = v; }
    set viewerStatus(v: "idle" | "running" | "completed" | "error") { this._viewerStatus = v; }
    set lines(v: string[]) { this._lines = v; }

    // -- Methods --

    appendLines(newLines: string[]): void {
        this._lines.push(...newLines);
        while (this._lines.length > MAX_PEEK_LINES) {
            this._lines.shift();
        }
    }

    appendStreamingText(text: string): void {
        this._streamingBuffer += text;
    }

    invalidateRender(): void {
        this._component?.invalidate();
        this._tui?.requestRender();
    }

    clear(): void {
        this._lines = [];
        this._streamingBuffer = "";
        this._goal = "";
        this._abort = null;
        this._handle = null;
        this._component = null;
        this._tui = null;
        this._done = null;
        this._lastXPress = 0;
        this._viewerSession = null;
        this._viewerTask = "";
        this._viewerOutput = "";
        this._viewerStatus = "idle";
        resetSpinner();
        stopSpinnerTimer();
    }
}

// ============================================================================
// Session registry
// ============================================================================

let _sessionCounter = 0;
const _sessions = new Map<string, PeekSession>();
let _current: PeekSession | null = null;

function _evictOldest(): void {
    if (_sessions.size >= MAX_SESSIONS) {
        const oldestKey = _sessions.keys().next().value;
        if (oldestKey !== undefined) {
            const oldest = _sessions.get(oldestKey)!;
            oldest.clear();
            _sessions.delete(oldestKey);
            if (_current === oldest) _current = null;
        }
    }
}

// ============================================================================
// PeekComponent — renders live subagent content inside the overlay
// ============================================================================

export class PeekComponent implements Component {
    _theme: Theme | null = null;
    session: PeekSession | null = null;

    render(width: number): string[] {
        const s = this.session;
        const lines: string[] = [];
        const innerWidth = Math.max(width - 4, 20);
        const t = this._theme;

        const vLen = (str: string): number => visibleLen(str).length;
        const mute = (str: string): string => t ? t.fg("muted", str) : str;
        const accent = (str: string): string => t ? t.fg("accent", str) : str;
        const success = (str: string): string => t ? t.fg("success", str) : str;
        const errCol = (str: string): string => t ? t.fg("error", str) : str;
        const bld = (str: string): string => t ? t.bold(str) : str;
        const dim = (str: string): string => t ? t.fg("dim", str) : str;

        const box = (content: string): string =>
            `│ ${content}${' '.repeat(Math.max(0, innerWidth - vLen(content)))} │`;

        // Read state from session (null-safe for tests that create component without session)
        const viewerSession = s?.viewerSession ?? null;
        const peekLines = s?.lines ?? [];
        const viewerOutput = s?.viewerOutput ?? "";
        const viewerTask = s?.viewerTask ?? "";
        const viewerStatus = s?.viewerStatus ?? "idle";
        const peekGoal = s?.goal ?? "";
        const streamingBuffer = s?.streamingBuffer ?? "";

        // ── Empty state ──
        if (!viewerSession && peekLines.length === 0 && !viewerOutput) {
            const topPad = Math.max(0, width - 4);
            lines.push(mute("┌ ") + mute("─".repeat(topPad)) + mute(" ┐"));
            lines.push(box(mute("○ Waiting for subagent...")));
            while (lines.length < MIN_HEIGHT - 1) {
                lines.push(box(""));
            }
            lines.push(mute("└─") + mute("─".repeat(Math.max(0, width - 4))) + mute("─┘"));
            return lines;
        }

        // ── Header ──
        const goalLabel = viewerTask || peekGoal || "Subagent";
        const topInnerText = ` ◆ ${goalLabel} `;
        const topPad = Math.max(0, (width - 2) - vLen(topInnerText));
        lines.push(mute("┌") + accent("◆") + ` ${bld(goalLabel)} ` + mute("─".repeat(topPad)) + mute("┐"));

        // Status line
        let statusText = "";
        if (viewerStatus === "running") statusText = accent("● Running");
        else if (viewerStatus === "completed") statusText = success("✓ Completed");
        else if (viewerStatus === "error") statusText = errCol("✗ Error");
        if (statusText) lines.push(box(statusText));

        // ── Build content lines from session messages ──
        const contentLines: string[] = [];

        // Part 1: Session messages (committed history)
        if (viewerSession) {
            const session = viewerSession as any;
            const messages: any[] = session.state?.messages ?? session.messages ?? [];

            for (const msg of messages) {
                // Handle different role formats
                const role = typeof msg.role === "string" ? msg.role : "";

                if (role === "user") {
                    const text = extractMsgText(msg.content ?? msg.text ?? "");
                    if (!text?.trim()) continue;
                    contentLines.push(accent("[User]"));
                    const wrapped = wrapText(text.trim(), innerWidth - 2);
                    for (const line of wrapped) contentLines.push(` ${line}`);
                    contentLines.push(dim("───"));
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
                    contentLines.push(dim("───"));
                } else if (role === "toolResult" || role === "tool_result" || role === "tool") {
                    const text = extractMsgText(msg.content ?? msg.text ?? "");
                    if (!text?.trim()) continue;
                    const truncated = text.length > 500 ? text.slice(0, 500) + dim("... (truncated)") : text;
                    contentLines.push(dim("[Result]"));
                    const wrapped = wrapText(truncated.trim(), innerWidth - 2);
                    for (const line of wrapped) contentLines.push(dim(` ${line}`));
                    contentLines.push(dim("───"));
                }
            }
        }

        // Part 3: Streaming model text (continuous, word-wrapped)
        if (streamingBuffer.length > 0) {
            // Show last 800 chars of streaming buffer
            const displayText = streamingBuffer.length > 800
                ? "…" + streamingBuffer.slice(-800)
                : streamingBuffer;
            const wrapped = wrapText(displayText, innerWidth - 2);
            for (const line of wrapped) {
                contentLines.push(line);
            }
        }

        // Part 4: Output section (completed/error)
        if (viewerOutput) {
            if (contentLines.length > 0) {
                contentLines.push(dim("─ output ─"));
            }
            const prefix = viewerStatus === "error" ? errCol("✗ ") : success("✓ ");
            contentLines.push(prefix + truncate(viewerOutput, Math.max(innerWidth - 2, 10)));
        }

        // ── Fallback ──
        if (contentLines.length === 0) {
            if (viewerStatus === "running") {
                contentLines.push(dim("Waiting for subagent output..."));
            } else if (viewerStatus === "idle") {
                contentLines.push(dim("○ Waiting for subagent..."));
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
        lines.push(mute("└") + mute(bottomText) + mute("─".repeat(bottomPad)) + mute("┘"));

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
            if (this.session && now - this.session.lastXPress < X_PRESS_WINDOW_MS) {
                // Double-press detected — abort
                this.session.lastXPress = 0;
                if (this.session.abort) {
                    this.session.abort.abort();
                }
                hidePeek();
                return;
            }
            if (this.session) {
                this.session.lastXPress = now;
            }
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

// ============================================================================
// Spinner API (module-level — shared infrastructure, reads from _current)
// ============================================================================

let _spinnerTimer: ReturnType<typeof setInterval> | null = null;

export function startSpinnerTimer(): void {
    stopSpinnerTimer();
    _spinnerTimer = setInterval(() => {
        advanceSpinner();
        if (_current?.handle && !_current.handle.isHidden()) {
            _current.component?.invalidate();
            _current.tui?.requestRender();
        }
    }, 250);
}

export function stopSpinnerTimer(): void {
    if (_spinnerTimer !== null) {
        clearInterval(_spinnerTimer);
        _spinnerTimer = null;
    }
}

// ============================================================================
// Viewer state API
// ============================================================================

/**
 * Set the session to display in the viewer.
 */
export function setViewerSession(session: any, task: string): void {
    if (!_current) return;
    _current.viewerSession = session;
    _current.viewerTask = task;
    _current.viewerStatus = "running";
    _current.invalidateRender();
}

/**
 * Set the viewer output on completion.
 */
export function setViewerOutput(output: string): void {
    if (!_current) return;
    _current.viewerOutput = output;
    _current.viewerStatus = "completed";
    _current.invalidateRender();
}

/**
 * Set the viewer error state.
 */
export function setViewerError(error: string): void {
    if (!_current) return;
    _current.viewerOutput = error;
    _current.viewerStatus = "error";
    _current.invalidateRender();
}

/**
 * Clear the viewer state.
 */
export function clearViewerState(): void {
    if (!_current) return;
    _current.viewerSession = null;
    _current.viewerTask = "";
    _current.viewerOutput = "";
    _current.viewerStatus = "idle";
    _current.invalidateRender();
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
    if (_current?.handle && !_current.handle.isHidden()) {
        if (goal) _current.goal = goal;
        if (abortController) _current.abort = abortController;
        _current.invalidateRender();
        return;
    }

    // Evict if at capacity, then create new session
    _evictOldest();
    const session = new PeekSession();
    const key = `peek-${++_sessionCounter}`;
    _sessions.set(key, session);
    _current = session;

    if (goal) session.goal = goal;
    if (abortController) session.abort = abortController;

    const component = new PeekComponent();
    component.session = session;
    session.component = component;

    ctx.ui.custom(
        (tui: TUI, theme: any, _keybindings: any, done: () => void) => {
            session.tui = tui;
            component._theme = theme;
            session.done = done;
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
                session.handle = handle;
            },
        },
    ).catch((err: unknown) => {
        console.error('[peek] overlay error:', err);
        session.clear();
        _sessions.delete(key);
        if (_current === session) _current = null;
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
    if (!_current?.handle || _current.handle.isHidden()) return;
    _current.appendLines(text.split("\n"));
    _current.invalidateRender();
}

/**
 * Push streaming model text — accumulates into a continuous buffer
 * that gets word-wrapped when rendered. Unlike updatePeek which
 * creates individual lines, this prevents one-word-per-line issues.
 */
export function pushStreamingText(text: string): void {
    if (!_current?.handle || _current.handle.isHidden()) return;
    _current.appendStreamingText(text);
    _current.invalidateRender();
}

/**
 * Update the peek goal label.
 */
export function setPeekGoal(goal: string): void {
    if (!_current) return;
    _current.goal = goal;
    _current.invalidateRender();
}

/**
 * Close the peek overlay and clean up all state.
 */
export function hidePeek(): void {
    stopSpinnerTimer();
    if (_current?.handle) {
        try { _current.handle.hide(); } catch (err: unknown) { console.error('[peek] hide error:', err); }
    }
    // Remove from registry
    if (_current) {
        for (const [key, session] of _sessions) {
            if (session === _current) {
                _sessions.delete(key);
                break;
            }
        }
        _current.clear();
        _current = null;
    }
}

/**
 * Check if the peek overlay is currently open.
 */
export function isPeekOpen(): boolean {
    return _current !== null && _current.handle !== null && !_current.handle.isHidden();
}
