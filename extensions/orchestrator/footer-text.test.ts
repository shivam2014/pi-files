import { describe, it, expect } from "vitest";
import { visibleWidth as piTuiVisibleWidth } from "@earendil-works/pi-tui";
import {
	charWidth,
	displayWidth,
	footerWidth,
	padToWidth,
	stripControl,
	toFooterLines,
	truncateToWidth,
} from "./footer-text.ts";

// The invariant every assertion below circles: pi-tui's screen guard throws and
// stops the TUI (before flushing the frame) if a rendered row is wider than the
// terminal, and Warp keeps glyph tails on rows that are vacated instead of
// space-filled. So: never wider than `width`, and always exactly `maxLines` rows.

describe("stripControl", () => {
	it("removes CSI colour codes", () => {
		expect(stripControl("\x1b[31mred\x1b[0m text")).toBe("red text");
		expect(stripControl("\x1b[1;38;5;208mhi\x1b[22m")).toBe("hi");
	});

	it("removes OSC sequences (BEL- and ST-terminated)", () => {
		expect(stripControl("\x1b]0;window title\x07body")).toBe("body");
		expect(stripControl("\x1b]8;;https://example.com\x1b\\link")).toBe("link");
	});

	it("removes a TRUNCATED escape such as \"\\x1b[3\"", () => {
		expect(stripControl("\x1b[3")).toBe("");
		expect(stripControl("prefix\x1b[3")).toBe("prefix");
		expect(stripControl("prefix\x1b[38;5;20")).toBe("prefix"); // params, no final byte
		expect(stripControl("a\x1b")).toBe("a"); // lone ESC
	});

	it("keeps \\n but removes other control chars and normalises \\t", () => {
		expect(stripControl("a\r\nb\x07c\x00d")).toBe("a\nbcd");
		expect(stripControl("a\tb")).toBe("a b");
	});

	it("never leaves an \\x1b behind, whatever the input shape", () => {
		const nasty = "x\x1b[31m\x1b]2;\x07\x1b[3\x1bZ\x1b\x7fy";
		expect(stripControl(nasty)).not.toContain("\x1b");
	});

	it("keepSgr preserves well-formed SGR styling but still drops motion/OSC/truncated", () => {
		const kept = stripControl("\x1b[31mred\x1b[0m\x1b[2J\x1b]0;t\x07\x1b[38;5;20", { keepSgr: true });
		expect(kept).toContain("\x1b[31m");
		expect(kept).toContain("\x1b[0m");
		expect(kept).toContain("red");
		expect(kept).not.toContain("\x1b[2J"); // cursor/erase motion
		expect(kept).not.toContain("\x1b]0;t"); // OSC
		expect(kept).not.toContain("\x1b[38;5;20"); // truncated escape (params, no final byte)
		expect(kept.endsWith("\x1b[3")).toBe(false); // never a dangling half-escape
	});
});

describe("displayWidth", () => {
	it("counts ASCII as 1 and ignores escapes", () => {
		expect(displayWidth("hello")).toBe(5);
		expect(displayWidth("\x1b[31mhello\x1b[0m")).toBe(5);
	});

	it("counts CJK / fullwidth as 2 cells", () => {
		expect(displayWidth("中文")).toBe(4);
		expect(displayWidth("ＡＢ")).toBe(4); // fullwidth latin
		expect(displayWidth("こんにちは")).toBe(10);
		expect(charWidth("中")).toBe(2);
	});

	it("counts emoji as 2 cells", () => {
		expect(displayWidth("🚀")).toBe(2);
		expect(displayWidth("a🚀b")).toBe(4);
		expect(charWidth("🚀")).toBe(2);
	});

	it("counts combining marks and ZWJ/variation selectors as 0", () => {
		expect(displayWidth("e\u0301")).toBe(1); // e + combining acute
		expect(displayWidth("\ufe0f")).toBe(0);
		expect(displayWidth("\u200d")).toBe(0);
	});
});

describe("truncateToWidth", () => {
	it("returns text unchanged when it already fits", () => {
		expect(truncateToWidth("abc", 3)).toBe("abc");
		expect(truncateToWidth("abc", 10)).toBe("abc");
	});

	it("adds a single-char ellipsis only when it actually cuts", () => {
		expect(truncateToWidth("abcdef", 4)).toBe("abc…");
		expect(displayWidth(truncateToWidth("abcdef", 4))).toBe(4);
	});

	it("is width-aware for wide characters", () => {
		const cut = truncateToWidth("中文字符", 5);
		expect(displayWidth(cut)).toBeLessThanOrEqual(5);
		expect(cut.endsWith("…")).toBe(true);
	});

	it("never bisects an escape sequence it walks over", () => {
		const out = truncateToWidth("\x1b[31mabcdef\x1b[0m", 4);
		expect(out).not.toMatch(/\x1b\[[0-9;]*$/); // no dangling params with no final byte
		expect(displayWidth(out)).toBeLessThanOrEqual(4);
	});

	it("degrades sanely at tiny widths", () => {
		expect(truncateToWidth("abc", 0)).toBe("");
		expect(truncateToWidth("abc", -5)).toBe("");
		expect(truncateToWidth("abc", 1)).toBe("…");
	});
});

describe("padToWidth", () => {
	it("appends spaces to reach an exact width and never truncates", () => {
		expect(padToWidth("ab", 5)).toBe("ab   ");
		expect(displayWidth(padToWidth("ab", 5))).toBe(5);
		expect(padToWidth("abcdef", 3)).toBe("abcdef");
	});

	it("accounts for wide characters", () => {
		const padded = padToWidth("中文", 6);
		expect(padded).toBe("中文  ");
		expect(displayWidth(padded)).toBe(6);
	});
});

describe("toFooterLines — footer boundary invariants", () => {
	const width = 40;

	const pad = (s: string) => s + " ".repeat(width - s.length);

	it("splits, strips and width-clamps every line", () => {
		const lines = toFooterLines("a\x1b[31mb\nc\r\nd", { maxLines: 5, width });
		expect(lines).toEqual([pad("ab"), pad("c"), pad("d"), " ".repeat(width), " ".repeat(width)]);
	});

	it("a 500-char colour-laden input yields no \\x1b, width<=limit, length===maxLines", () => {
		// Build one very long, heavily coloured line (sequences every ~10 chars).
		let long = "";
		for (let i = 0; i < 50; i++) long += `\x1b[3${i % 8}m${"x".repeat(10)}\x1b[0m`;
		const lines = toFooterLines(long, { maxLines: 6, width });
		expect(lines).toHaveLength(6);
		for (const line of lines) {
			expect(line).not.toContain("\x1b");
			expect(displayWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("does not include a stray \\x1b even when the input line ends mid-escape", () => {
		const lines = toFooterLines("ok\n\x1b[38;5;20", { maxLines: 3, width });
		expect(lines.join("")).not.toContain("\x1b");
	});

	it("SHRINKING content keeps an IDENTICAL array length and full-width padding", () => {
		const longText = Array.from({ length: 9 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n");
		const shortText = "done";

		const long = toFooterLines(longText, { maxLines: 9, width });
		const short = toFooterLines(shortText, { maxLines: 9, width });

		// Stable height is the core ghost fix: identical row count both times, so no
		// row is vacated (Warp keeps the glyphs of an erase-only row).
		expect(long.length).toBe(9);
		expect(short.length).toBe(9);
		expect(short.length).toBe(long.length);

		// Every row is padded to the full width — blank rows are spaces, not erases.
		for (const line of short) expect(displayWidth(line)).toBe(width);
		expect(short[1]).toBe(" ".repeat(width));
		expect(short[0].trimEnd()).toBe("done");
		expect(toFooterLines("", { maxLines: 4, width })).toEqual([
			" ".repeat(width),
			" ".repeat(width),
			" ".repeat(width),
			" ".repeat(width),
		]);
	});

	it("marks dropped overflow with `  … N more` and keeps the count exact", () => {
		const text = Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n");
		const lines = toFooterLines(text, { maxLines: 5, width });
		expect(lines).toHaveLength(5);
		expect(lines[4].trimEnd()).toBe("  … 8 more"); // 12 - 4 kept = 8 dropped
		expect(displayWidth(lines[4])).toBe(width); // marker row is space-filled too
		expect(lines[0].trimEnd()).toBe("row 0");
	});

	it("clamps the marker itself when width is tiny", () => {
		const text = Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n");
		const lines = toFooterLines(text, { maxLines: 3, width: 6 });
		expect(lines).toHaveLength(3);
		expect(displayWidth(lines[2])).toBeLessThanOrEqual(6);
	});

	it("keeps wide characters within width across many widths (fuzz)", () => {
		const sample = "中文 test 🚀 emoji 中文字符 mixed \x1b[31mcoloured\x1b[0m tail";
		for (let w = 1; w <= 60; w++) {
			const lines = toFooterLines(sample, { maxLines: 3, width: w });
			expect(lines).toHaveLength(3);
			for (const line of lines) {
				expect(displayWidth(line)).toBeLessThanOrEqual(w);
			}
		}
	});
});

describe("footerWidth", () => {
	it("is at least 1 and never exceeds columns - 2 (pi-tui's content width)", () => {
		const w = footerWidth();
		expect(w).toBeGreaterThanOrEqual(1);
		if (Number.isFinite(process.stdout?.columns) && process.stdout.columns > 2) {
			expect(w).toBeLessThanOrEqual(process.stdout.columns - 2);
		}
	});

	it("is exactly columns - 2 once the terminal can hold it (C3 small-terminal clamp)", () => {
		const original = process.stdout.columns;
		try {
			Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
			expect(footerWidth()).toBe(98);
			Object.defineProperty(process.stdout, "columns", { value: 22, configurable: true });
			expect(footerWidth()).toBe(20);
			// Small terminal: the old `Math.max(20, cols - 2)` returned 10 here — MORE
			// than pi-tui's contentWidth (8), so every padded row would re-wrap.
			Object.defineProperty(process.stdout, "columns", { value: 10, configurable: true });
			expect(footerWidth()).toBe(8);
			expect(footerWidth()).toBeLessThanOrEqual(10 - 2);
		} finally {
			Object.defineProperty(process.stdout, "columns", { value: original, configurable: true });
		}
	});
});

describe("C3 — width agreement with pi-tui's own measure", () => {
	it("matches pi-tui's visibleWidth for RGI emoji the old table under-counted", () => {
		const samples = ["⏳", "⌚", "⭐", "⭕", "ℹ️", "👨‍👩‍👧‍👦", "🇯🇵", "🚀", "中文", "Ａ", "e\u0301", "\ufe0f", "\u200d"];
		for (const sample of samples) {
			expect(displayWidth(sample)).toBe(piTuiVisibleWidth(sample));
			expect(charWidth(sample)).toBe(piTuiVisibleWidth(sample));
		}
	});

	it("measures the emoji the hand-rolled table called 1 cell as 2 cells", () => {
		for (const sample of ["⏳", "⌚", "⭐", "⭕", "ℹ️"]) {
			expect(displayWidth(sample)).toBe(2);
		}
		// Zero-width sequences stay zero-width (pi-tui's zeroWidthRegex).
		expect(displayWidth("\ufe0f")).toBe(0);
		expect(displayWidth("\u200d")).toBe(0);
	});

	it("toFooterLines rows stay within pi-tui's measure when emoji are present", () => {
		const body = `⏳ timer ${"x".repeat(40)} ⭐\nℹ️ info 👨‍👩‍👧‍👦 ${"y".repeat(40)}`;
		for (const w of [6, 10, 22, 40, 78]) {
			const rows = toFooterLines(body, { maxLines: 9, width: w, keepSgr: true });
			expect(rows).toHaveLength(9);
			for (const row of rows) expect(piTuiVisibleWidth(row)).toBeLessThanOrEqual(w);
		}
	});

	it("an emoji row pads to EXACTLY the width, so pi-tui cannot wrap in an extra row", () => {
		// Under-counting ⏳/⭐/⌚/ℹ️ as 1 cell padded a row to width+4 visible cells:
		// pi-tui's screen guard re-wraps that into an extra row ⇒ changed row count ⇒
		// back to the erase-only vacate path.
		const width = 20;
		const rows = toFooterLines("⏳ ⭐ ⌚ ℹ️", { maxLines: 9, width });
		expect(rows).toHaveLength(9);
		expect(piTuiVisibleWidth(rows[0])).toBe(width);
		expect(displayWidth(rows[0])).toBe(width);
	});
});

describe("W2 — per-row SGR reset (no colour bleed into the fill)", () => {
	it("a row carrying SGR ends with a reset after the space fill", () => {
		const rows = toFooterLines("\x1b[31mred\x1b[0m\nplain", { maxLines: 3, width: 10, keepSgr: true });
		expect(rows[0].startsWith("\x1b[31mred")).toBe(true);
		expect(rows[0].endsWith("\x1b[0m")).toBe(true);
		expect(piTuiVisibleWidth(rows[0])).toBe(10);
		expect(rows[1].endsWith("\x1b[0m")).toBe(false); // plain row untouched
		expect(rows[2]).toBe(" ".repeat(10)); // blank pad row stays plain
	});

	it("an unterminated styled span is closed at the row end", () => {
		const rows = toFooterLines("\x1b[7m" + "x".repeat(40), { maxLines: 2, width: 12, keepSgr: true });
		expect(rows[0]).toContain("\x1b[7m");
		expect(rows[0].endsWith("\x1b[0m")).toBe(true);
		expect(piTuiVisibleWidth(rows[0])).toBeLessThanOrEqual(12);
	});
});

describe("C2 — constant delegate frame height", () => {
	it("10 rows for a 10-line live payload AND for a 1-line completed payload", () => {
		const maxLines = 10;
		const live = toFooterLines(
			Array.from({ length: 10 }, (_, i) => `live row ${i}`).join("\n"),
			{ maxLines, width: 60, keepSgr: true },
		);
		const completed = toFooterLines("\x1b[32mall done\x1b[0m", { maxLines, width: 60, keepSgr: true });
		expect(live).toHaveLength(maxLines);
		expect(completed).toHaveLength(maxLines);
		expect(completed.length).toBe(live.length);
		for (const row of completed) expect(piTuiVisibleWidth(row)).toBeLessThanOrEqual(60);
	});
});
