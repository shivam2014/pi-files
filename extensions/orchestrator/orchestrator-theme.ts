/**
 * Central theme & symbol module for the orchestrator extension.
 *
 * Imports the pi SDK Theme singleton and layers orchestrator-specific
 * symbol keys, formatting helpers, and status-icon utilities on top.
 *
 * Every UI module should import this rather than reaching into the SDK
 * theme directly — keeps symbol definitions in one place.
 */

// ── Dependencies ───────────────────────────────────────────────────
// SDK theme singleton is stored on globalThis[Symbol.for(...)] after initTheme() runs.
// The barrel does NOT export the theme value, only the Theme class + initTheme.
// We read the singleton directly via globalThis to avoid the broken import.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { currentFrame } from "./spinner-state.ts";

// ── Symbol key type & map ──────────────────────────────────────────

/** All symbol keys used across the orchestrator UI. */
export type SymbolKey =
  // GROUP 1 — Status indicators
  | "status.completed"
  | "status.error"
  | "status.warning"
  | "status.pending"
  | "status.running"
  | "status.done"
  | "status.aborted"
  // GROUP 2 — Box drawing
  | "boxRound.topLeft"
  | "boxRound.topRight"
  | "boxRound.bottomLeft"
  | "boxRound.bottomRight"
  | "boxRound.horizontal"
  | "boxRound.vertical"
  // GROUP 3 — Tree connectors
  | "tree.branch"
  | "tree.last"
  | "tree.vertical"
  | "tree.horizontal"
  // GROUP 4 — Separators
  | "sep.dot"
  | "sep.slash"
  | "sep.pipe"
  // GROUP 5 — Icons
  | "icon.goal"
  | "icon.plug"
  | "icon.subagent"
  | "icon.tool"
  // GROUP 6 — Extra (fusion-tui / nav)
  | "boxRound.teeRight"
  | "boxRound.teeLeft"
  | "nav.cursor"
  // GROUP 7 — Token counters
  | "token.input"
  | "token.output"
  | "token.cacheRead";

/** Canonical Unicode values for every symbol key. */
export const SYMBOLS: Record<SymbolKey, string> = {
  // Status indicators
  "status.completed": "✓",
  "status.error":     "✗",
  "status.warning":   "⚠",
  "status.pending":   "○",
  "status.running":   "⠋",
  "status.done":      "●",
  "status.aborted":   "−",

  // Box drawing
  "boxRound.topLeft":      "╭",
  "boxRound.topRight":     "╮",
  "boxRound.bottomLeft":   "╰",
  "boxRound.bottomRight":  "╯",
  "boxRound.horizontal":   "─",
  "boxRound.vertical":     "│",

  // Tree connectors
  "tree.branch":    "├──",
  "tree.last":      "└──",
  "tree.vertical":  "│",
  "tree.horizontal": "──",

  // Separators
  "sep.dot":   "·",
  "sep.slash": "/",
  "sep.pipe":  "|",

  // Icons
  "icon.goal":     "◆",
  "icon.plug":     "⚡",
  "icon.subagent": "⊞",
  "icon.tool":     "→",

  // Extra — fusion-tui / navigation
  "boxRound.teeRight": "├",
  "boxRound.teeLeft":  "┤",
  "nav.cursor":        "▸",

  // Token counters
  "token.input":     "↑",
  "token.output":    "↓",
  "token.cacheRead": "⇄",
};

// ── Strikethrough animation constants ────────────────────────────

/** ANSI escape: start strikethrough */
export const STRIKE_START = "\x1b[9m";
/** ANSI escape: end strikethrough */
export const STRIKE_END = "\x1b[29m";

/** Hold frames before reveal starts (text fully struck during hold) */
export const HOLD_FRAMES = 2;
/** Reveal frames — struck portion shrinks from full to zero over this many frames */
export const REVEAL_FRAMES = 12;
/** Total animation frames = HOLD_FRAMES + REVEAL_FRAMES */
export const TOTAL_STRIKE_FRAMES = HOLD_FRAMES + REVEAL_FRAMES;

/** Wrap entire text in strikethrough ANSI codes */
export function strikethroughText(text: string): string {
  return `${STRIKE_START}${text}${STRIKE_END}`;
}

/**
 * Partial strikethrough: first `visibleChars` characters struck, rest plain.
 * If visibleChars <= 0: all plain. If >= text length: all struck.
 */
export function partialStrikethrough(text: string, visibleChars: number): string {
  if (visibleChars <= 0) return text;
  const chars = [...text]; // spread handles multi-byte Unicode
  if (visibleChars >= chars.length) return strikethroughText(text);
  return `${strikethroughText(chars.slice(0, visibleChars).join(""))}${chars.slice(visibleChars).join("")}`;
}

/**
 * Compute visibleChars for an animation frame.
 * Frame 0..HOLD_FRAMES-1: return 0 (fully struck, no reveal).
 * Frame HOLD_FRAMES..TOTAL_STRIKE_FRAMES: linearly reveal from full to zero.
 */
export function revealCount(textLength: number, frame: number): number {
  if (frame < HOLD_FRAMES) return 0;
  const revealFrame = frame - HOLD_FRAMES;
  if (revealFrame >= REVEAL_FRAMES) return textLength; // animation done — fully revealed
  return Math.ceil(textLength * revealFrame / REVEAL_FRAMES);
}

// ── Theme accessor ─────────────────────────────────────────────────

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** Return the pi SDK Theme singleton. */
export function getTheme(): Theme {
  const t = (globalThis as any)[THEME_KEY] as Theme | undefined;
  if (!t) {
    throw new Error(
      "Theme not initialized. Call initTheme() first, or ensure pi has started."
    );
  }
  return t;
}

// ── Symbol helpers ─────────────────────────────────────────────────

/**
 * Look up a symbol by its key.
 * Returns the raw Unicode string (no styling applied).
 */
export function styledSymbol(key: SymbolKey): string {
  return SYMBOLS[key];
}

// ── Status icon ────────────────────────────────────────────────────

/**
 * Return a color-coded status icon string.
 *
 * - completed → green ✓
 * - error     → red ✗
 * - running   → accent spinner frame
 * - pending   → dim ○
 * - aborted   → muted −
 */
export function statusIcon(
  status: "completed" | "error" | "running" | "pending" | "aborted",
): string {
  switch (status) {
    case "completed":
      return getTheme().fg("success", styledSymbol("status.completed"));
    case "error":
      return getTheme().fg("error", styledSymbol("status.error"));
    case "running":
      return getTheme().fg("accent", currentFrame());
    case "pending":
      return getTheme().fg("dim", styledSymbol("status.pending"));
    case "aborted":
      return getTheme().fg("muted", styledSymbol("status.aborted"));
  }
}

// ── Formatting helpers ─────────────────────────────────────────────

/**
 * Wrap `label` in `[brackets]` with the given color.
 * Default color is "accent".
 */
export function formatBadge(
  label: string,
  color: ThemeColor = "accent",
): string {
  const t = getTheme();
  return t.fg(color, `[${label}]`);
}

/**
 * Format a millisecond duration as a human-readable short string.
 *
 * - <1s  → "0s"
 * - <60s → "Xs"
 * - ≥60s → "Xm Ys"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return getTheme().fg("dim", "0s");
  const s = Math.floor(ms / 1000);
  if (s < 60) return getTheme().fg("dim", `${s}s`);
  const m = Math.floor(s / 60);
  return getTheme().fg("dim", `${m}m ${s % 60}s`);
}

/**
 * Format a token count as a compact human-readable string.
 *
 * - <1k   → "N"
 * - <10k  → "N.Nk"
 * - <1M   → "Nk"
 * - ≥1M   → "N.NM"
 */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Build a one-line status string with optional icon, badge, and meta.
 *
 * ```
 * icon  title: description [badge] meta1 · meta2
 * ```
 */
export function formatStatusLine(opts: {
  icon?: string;
  title: string;
  description?: string;
  badge?: { label: string; color: ThemeColor };
  meta?: string[];
}): string {
  const t = getTheme();

  let line = opts.icon
    ? `${opts.icon} ${t.fg("accent", opts.title)}`
    : t.fg("accent", opts.title);

  if (opts.description) {
    line += `: ${t.fg("muted", opts.description)}`;
  }

  if (opts.badge) {
    line += ` ${t.fg(opts.badge.color, `[${opts.badge.label}]`)}`;
  }

  if (opts.meta?.length) {
    line += ` ${t.fg("dim", opts.meta.join(` ${styledSymbol("sep.dot")} `))}`;
  }

  return line;
}
