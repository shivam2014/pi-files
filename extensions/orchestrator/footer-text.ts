/**
 * footer-text.ts — footer hardening helpers.
 *
 * Measurement and truncation delegate to pi-tui's own primitives — `visibleWidth`
 * and `truncateToWidth` from "@earendil-works/pi-tui" — not a hand-rolled width
 * table (C3): a local table measured RGI emoji as 1 cell (U+23F3 ⏳, U+231A ⌚,
 * U+2B50 ⭐, U+2B55 ⭕, U+2139 ℹ️+VS16), while pi-tui segments graphemes and
 * returns 2 (`utils.js couldBeEmoji` + `rgiEmojiRegex`). A row padded to exactly
 * `contentWidth` by an under-counting table makes pi-tui re-wrap it into an EXTRA
 * row, and a changed row count is what re-opens the erase-only vacate path.
 *
 * Root cause this file exists for (two proven ghost/stale-text paths in Warp):
 *
 * 1. Subagent-derived strings reached the footer with ANSI/control codes intact
 *    and were cut by CHARACTER COUNT, so a cut could bisect an escape sequence.
 *    If a rendered row then measured wider than the terminal, pi-tui's screen
 *    guard writes a crash log, stops the TUI and THROWS BEFORE flushing the
 *    frame — nothing repaints, the old frame stays on screen.
 * 2. The footer's line count shrank/grew with content and vacated rows were only
 *    erased (`\x1b[2K`), never space-filled. Warp does not invalidate cells on
 *    erase-only writes, so glyph tails of the previous longer row stayed visible.
 *
 * INVARIANT (load-bearing): every line returned by `toFooterLines` satisfies
 * `displayWidth(line) <= width`. pi-tui throws and stops the TUI if a rendered
 * row exceeds the terminal width. `toFooterLines` also returns EXACTLY `maxLines`
 * entries so the emitted height never varies with content — no row is ever
 * vacated, which is the core ghost fix.
 */

import { truncateToWidth as piTuiTruncateToWidth, visibleWidth as piTuiVisibleWidth } from "@earendil-works/pi-tui";

/** OSC: `ESC ] ... BEL` or `ESC ] ... ST` (or unterminated — truncated input). */
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g;
/** Well-formed CSI: `ESC [ params intermediates final`. */
const CSI_RE = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g;
/** Truncated CSI with no final byte, e.g. a cut `"\x1b[3"`. */
const PARTIAL_CSI_RE = /\x1b\[[0-9;?<>=!]*/g;
/** Two-char escapes: `ESC ( ... `, `ESC ]` leftovers, `ESC 7`, `ESC c`, … */
const ESC_PAIR_RE = /\x1b[@-Z\\-_0-9A-Za-z]/g;
/** SGR only — the one escape class that is safe to keep (styling, no motion). */
const SGR_RE = /\x1b\[[0-9;]*m/g;
/** Sentinels used to protect SGR while the rest of the escapes are stripped. */
const SGR_OPEN = "\uE000";
const SGR_CLOSE = "\uE001";
/** Control chars to drop. `\n` is preserved; `\t` is pre-converted to a space. */
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g;
/** Generic single escape token, anchored — used to step over escapes atomically. */
const ESC_TOKEN_RE = /^\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|\[[0-9;?<>=!]*[ -/]*[@-~]|[@-Z\\-_0-9A-Za-z])/;

/** Strip every control sequence. `keepSgr` preserves well-formed SGR colour only. */
function stripAllEscapes(text: string): string {
	return text
		.replace(OSC_RE, "")
		.replace(CSI_RE, "")
		.replace(PARTIAL_CSI_RE, "")
		.replace(ESC_PAIR_RE, "")
		.replace(/\x1b/g, "")
		.replace(CTRL_RE, "");
}

/**
 * Remove ANSI CSI/OSC/other escape sequences and stray control characters.
 * `\n` is kept (line structure); `\t` becomes a single space (a tab's rendered
 * width is terminal-dependent and unbounded, so it can never be measured).
 *
 * @param text - Raw text, possibly carrying escapes from a subagent.
 * @param opts.keepSgr - Keep well-formed SGR colour sequences (footer styling)
 *   while still stripping cursor moves, OSC, control chars and truncated
 *   escapes. Default `false` strips all escapes.
 */
export function stripControl(text: string, opts: { keepSgr?: boolean } = {}): string {
	let out = String(text ?? "").replace(/\t/g, " ");
	if (!opts.keepSgr) return stripAllEscapes(out);

	const kept: string[] = [];
	out = out.replace(SGR_RE, (match) => `${SGR_OPEN}${kept.push(match) - 1}${SGR_CLOSE}`);
	out = stripAllEscapes(out);
	return out.replace(/\uE000(\d+)\uE001/g, (_m, idx: string) => kept[Number(idx)] ?? "");
}

/**
 * Width of one code point in terminal cells — pi-tui's own grapheme measure, so
 * the footer's arithmetic can never disagree with the renderer's screen guard.
 */
export function charWidth(ch: string): number {
	return piTuiVisibleWidth(String(ch ?? ""));
}

/**
 * Width of `text` in terminal cells. Escape sequences contribute 0, so the
 * measurement is comparable to what the screen guard measures.
 */
export function displayWidth(text: string): number {
	// pi-tui's exact measure. Escapes are stripped first (they contribute 0) so a
	// rendered row carrying SGR measures the same as its visible glyphs.
	return piTuiVisibleWidth(stripAllEscapes(String(text ?? "")));
}

/** Trailing incomplete escape (command token with no final byte, or a lone ESC). */
const DANGLING_ESCAPE_RE = /\x1b(?:\[[0-9;?<>=!]*[ -/]*|\]|)$/;

/** Shared grapheme segmenter — the same unit pi-tui's measurer uses. */
let _graphemeSegmenter: Intl.Segmenter | null | undefined;

/** First grapheme cluster of `text`. Falls back to a code point without Intl. */
function firstGrapheme(text: string): string {
	if (!text) return "";
	if (_graphemeSegmenter === undefined) {
		try {
			_graphemeSegmenter =
				typeof Intl !== "undefined" && typeof (Intl as any).Segmenter === "function"
					? new (Intl as any).Segmenter(undefined, { granularity: "grapheme" })
					: null;
		} catch {
			_graphemeSegmenter = null;
		}
	}
	if (_graphemeSegmenter) {
		try {
			const it = _graphemeSegmenter.segment(text)[Symbol.iterator]().next();
			const seg = it.done ? undefined : (it.value as { segment?: string })?.segment;
			if (typeof seg === "string" && seg.length > 0) return seg;
		} catch {
			/* fall through to the code-point split */
		}
	}
	const cp = text.codePointAt(0);
	return cp === undefined ? text.slice(0, 1) : String.fromCodePoint(cp);
}

/**
 * Copy escape tokens atomically and whole grapheme clusters while they fit in
 * `budget` cells. Grapheme-wise so a ZWJ/VS16 sequence counts as the single
 * 2-cell unit pi-tui measures, and a cut can never bisect an escape sequence.
 */
function cutToWidth(src: string, budget: number): string {
	let out = "";
	let used = 0;
	let i = 0;
	while (i < src.length) {
		const esc = ESC_TOKEN_RE.exec(src.slice(i));
		if (esc) {
			out += esc[0];
			i += esc[0].length;
			continue;
		}
		const g = firstGrapheme(src.slice(i));
		if (!g) break;
		const w = displayWidth(g);
		if (used + w > budget) break;
		out += g;
		used += w;
		i += g.length;
	}
	return out;
}

/**
 * Width-aware truncate. Measurements come from pi-tui's `visibleWidth`; plain
 * (escape-free) text is cut with pi-tui's own `truncateToWidth`, escape-carrying
 * text with a grapheme-aware atomic walk so no sequence is ever bisected. The
 * ellipsis (default single-char `…`) is appended only when it actually cuts.
 *
 * @param opts.ellipsis - Marker appended after the cut. Widths are accounted for,
 *   so `{ ellipsis: "..." }` still guarantees `displayWidth(result) <= maxWidth`.
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	opts: { ellipsis?: string } = {},
): string {
	const src = String(text ?? "");
	const limit = Number.isFinite(maxWidth) ? Math.floor(maxWidth) : 0;
	if (limit <= 0) return "";
	if (displayWidth(src) <= limit) return src;

	const ellipsis = opts.ellipsis ?? "…";
	const ellWidth = displayWidth(ellipsis);
	if (ellWidth >= limit) {
		// No cell left for content + marker: keep just the marker, width-clamped.
		return cutToWidth(ellipsis, limit);
	}

	if (!src.includes("\x1b")) {
		try {
			const raw = piTuiTruncateToWidth(src, limit, ellipsis, false);
			if (typeof raw === "string") {
				// pi-tui appends its own reset even for escape-free input. This source
				// carries no SGR, so drop it: the footer boundary promises unstyled rows
				// never contain `\x1b` at all (an injected reset is pure noise there).
				const cut = raw.replace(/\x1b\[[0-9;]*m/g, "");
				if (displayWidth(cut) <= limit && !DANGLING_ESCAPE_RE.test(cut)) return cut;
			}
		} catch {
			/* fall through to the atomic walk */
		}
	}

	return cutToWidth(src, Math.max(0, limit - ellWidth)) + ellipsis;
}

/** Append spaces until `displayWidth(result) === width`. Never truncates. */
export function padToWidth(text: string, width: number): string {
	const src = String(text ?? "");
	const target = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const current = displayWidth(src);
	return current >= target ? src : src + " ".repeat(target - current);
}

/** Any well-formed SGR sequence — the class of escape `keepSgr` lets through. */
const SGR_IN_ROW_RE = /\x1b\[[0-9;]*m/;

/**
 * Normalise ONE footer row: width-truncate, space-fill to `width`, then append a
 * reset AFTER the fill (W2, ghost hardening). Without the trailing `\x1b[0m` the
 * ellipsis and every padding cell inherit an unterminated colour span — and a
 * preserved background/`\x1b[7m` turns a pad row into a full-width stripe that
 * bleeds into the next row. Reset only when SGR is actually present, so blank
 * pad rows stay plain full-width space strings.
 */
export function normalizeFooterRow(row: string, width: number): string {
	const padded = padToWidth(truncateToWidth(row, width, { ellipsis: "" }), width);
	return SGR_IN_ROW_RE.test(padded) && !padded.endsWith("\x1b[0m") ? `${padded}\x1b[0m` : padded;
}

/**
 * Normalise arbitrary text into EXACTLY `maxLines` footer rows.
 *
 * - each line is control-stripped, then width-truncated (`displayWidth <= width`)
 * - overflow beyond `maxLines` is dropped and replaced by `  … N more`
 * - short content is padded with full-width blank rows (`" ".repeat(width)`),
 *   never left as an erased-only row (Warp keeps the old glyphs otherwise)
 *
 * @param text - Raw content, `\n`-separated.
 * @param opts.maxLines - Exact number of returned rows.
 * @param opts.width - Hard cell budget per row.
 * @param opts.keepSgr - Keep well-formed SGR styling (default `false`).
 */
export function toFooterLines(
	text: string,
	opts: { maxLines: number; width: number; keepSgr?: boolean },
): string[] {
	const maxLines = Math.max(1, Math.floor(Number.isFinite(opts?.maxLines) ? opts.maxLines : 1));
	const width = Math.max(1, Math.floor(Number.isFinite(opts?.width) ? opts.width : 1));
	const stripOpts = opts?.keepSgr ? { keepSgr: true } : {};

	const raw = stripControl(text == null ? "" : String(text), stripOpts).split("\n");
	// Truncate for the width invariant, then SPACE-FILL every row to the full width.
	// Padding matters as much as truncation: Warp does not invalidate cells on an
	// erase-only write (`\x1b[2K`), so a row that is merely blank still keeps the
	// glyphs of whatever occupied it before. A full-width row overwrites them.
	// `normalizeFooterRow` also closes any SGR span after the fill (W2).
	const content = raw.map((line) => normalizeFooterRow(line, width));

	let rows: string[];
	if (content.length <= maxLines) {
		rows = content;
	} else if (maxLines === 1) {
		// One row only: the content itself outranks the marker.
		rows = [content[0]];
	} else {
		const keep = content.slice(0, maxLines - 1);
		const dropped = content.length - keep.length;
		rows = [...keep, normalizeFooterRow(`  … ${dropped} more`, width)];
	}

	const blank = " ".repeat(width);
	while (rows.length < maxLines) rows.push(blank);
	return rows.slice(0, maxLines);
}

/**
 * The single place that decides footer width. Always ≤ pi-tui's content width
 * (`columns - paddingX * 2`, i.e. `columns - 2`) and never below 1 cell, so a
 * padded row can never exceed the terminal — including small terminals, where
 * the old `Math.max(20, cols - 2)` clamp could return MORE than `cols - 2`.
 */
export function footerWidth(): number {
	const cols =
		typeof process !== "undefined" && process.stdout && Number.isFinite(process.stdout.columns)
			? (process.stdout.columns as number)
			: undefined;
	if (cols === undefined || cols <= 0) return 78; // 80 columns - 2
	return Math.max(1, Math.floor(cols) - 2);
}
