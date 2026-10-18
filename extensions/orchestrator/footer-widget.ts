/**
 * footer-widget.ts — pi-tui component whose rendered row count is CONSTANT.
 *
 * Why this module exists (C1, verified against pi-tui source):
 *
 * the string-array form of `setWidget` wraps every array entry in
 * `new Text(line, 1, 0)` (interactive-mode.js), and pi-tui's `Text` early-returns
 * `[]` for whitespace-only text (`components/text.js`:
 * `if (!this.text || this.text.trim() === "") { return []; }`). A blank pad row
 * written as `" ".repeat(width)` therefore renders as ZERO rows: a panel padded
 * to 9 rows still collapses to a content-dependent height (1..9), pi-tui vacates
 * the missing rows with erase-only writes (`"\r\n\x1b[2K"`), and Warp keeps the
 * previous glyphs — the stale-text artifact the footer boundary closes.
 *
 * The component-factory form of `setWidget(key, (tui, theme) => Component &
 * { dispose?(): void }, options?)` (`core/extensions/types.d.ts`) adds the
 * returned component directly to the widget list, so `render(width)`'s return
 * value IS the frame: no `Text` wrapper sits between the widget and the screen,
 * and the blank pad rows (real full-width space strings) reach the renderer.
 *
 * Invariant: `render(width)` always returns EXACTLY `rowCount` rows, each with
 * `visibleWidth(row) <= width` under pi-tui's own measure (see footer-text.ts).
 */

import { normalizeFooterRow } from "./footer-text.ts";

/** Rows the plan panel occupies. Kept here so tests and the panel agree. */
export const FOOTER_PANEL_ROWS = 9;

/** The slice of pi-tui's `Component` this widget uses. */
export interface FooterWidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
}

/**
 * Build a constant-height footer component.
 *
 * @param linesProvider - Current content rows, re-read on every `render` call
 *   (the plan panel already pads them to `rowCount`; shorter input is padded here).
 * @param width - Fallback cell budget (the panel's `footerWidth()`), used when the
 *   renderer hands us a width that is missing or non-positive.
 * @param rowCount - Exact number of rows to emit. Constant for the widget's life.
 */
export function createFooterWidget(
	linesProvider: () => string[],
	width: () => number,
	rowCount: number = FOOTER_PANEL_ROWS,
): FooterWidgetComponent {
	const target =
		Number.isFinite(rowCount) && rowCount > 0 ? Math.floor(rowCount) : FOOTER_PANEL_ROWS;

	// The renderer's width is authoritative (it is what the screen guard measures
	// with); `width()` only narrows it, never widens it. Never below 1 cell.
	const resolveWidth = (renderWidth: number): number => {
		let provided = 0;
		try {
			const w = width();
			provided = Number.isFinite(w) && w > 0 ? Math.floor(w) : 0;
		} catch {
			provided = 0;
		}
		const rendered = Number.isFinite(renderWidth) && renderWidth > 0 ? Math.floor(renderWidth) : 0;
		if (rendered > 0 && provided > 0) return Math.min(rendered, provided);
		if (rendered > 0) return rendered;
		if (provided > 0) return provided;
		return 1;
	};

	return {
		// Rows are rebuilt from the provider on EVERY call — the widget's content is
		// never frozen at `setWidget` time, so a plan/timer update always paints.
		render(renderWidth: number): string[] {
			const w = resolveWidth(renderWidth);
			let source: unknown = [];
			try {
				source = linesProvider();
			} catch {
				source = [];
			}
			const lines = Array.isArray(source) ? source : [];
			const rows: string[] = [];
			for (let i = 0; i < target; i++) {
				const line = typeof lines[i] === "string" ? (lines[i] as string) : "";
				rows.push(normalizeFooterRow(line, w));
			}
			return rows;
		},
		// Standard `Component` hook. render() is stateless (it re-reads the provider
		// every call), so there is no cached frame to drop; the method exists so the
		// panel can signal "content changed" without depending on that detail.
		invalidate(): void {
			/* stateless by design — render() recomputes from the provider each call */
		},
		// Kept for the `Component & { dispose?(): void }` contract: this widget owns
		// no timers and no buffers, so teardown is a no-op.
		dispose(): void {
			/* no owned resources */
		},
	};
}
