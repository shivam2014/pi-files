import { describe, it, expect, afterEach } from "vitest";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { createFooterWidget, FOOTER_PANEL_ROWS } from "./footer-widget.ts";
import { footerWidth, toFooterLines } from "./footer-text.ts";
import { setupPlanPanel, clearPlanPanel } from "./plan-panel.ts";

// C1 regression surface. The bug that shipped: `plan-panel.ts` emitted 9 rows from
// `toFooterLines`, but the blank filler was `" ".repeat(width)` and the widget went
// through the STRING-ARRAY path of `setWidget`, which wraps each entry in pi-tui's
// `Text` — and `Text` early-returns `[]` for whitespace-only text
// (`components/text.js`: `if (!this.text || this.text.trim() === "") return [];`).
// `" ".repeat(78).trim() === ""` ⇒ 9 rows in, 0 rows out for the pads ⇒ the panel's
// rendered height stayed content-dependent (1..9) ⇒ pi-tui vacated rows with
// erase-only writes (`"\r\n\x1b[2K"`) ⇒ Warp kept the stale glyphs.
//
// The fix routes the panel through the COMPONENT-FACTORY form of `setWidget`, whose
// `render(width)` output is the frame with no `Text` in between. Every assertion
// below is measured with pi-tui's OWN `visibleWidth`, not the local helper.

const WIDTH = 40;

/** A realistic plan-panel payload: goal line + N step lines, normalised by the real
 *  footer boundary the panel uses (toFooterLines at the panel's BUDGET). */
function planRows(steps: number, width = WIDTH): string[] {
	const body = [
		"  🔄 Goal",
		...Array.from({ length: steps }, (_, i) => `  • step ${i + 1} ${"x".repeat(12)}`),
	].join("\n");
	return toFooterLines(body, { maxLines: FOOTER_PANEL_ROWS, width, keepSgr: true });
}

describe("createFooterWidget — C1: pad rows survive to the screen", () => {
	it("returns EXACTLY rowCount rows for a 2-step, a 12-step and an empty plan", () => {
		for (const steps of [2, 12, 0]) {
			const widget = createFooterWidget(() => planRows(steps), () => WIDTH, FOOTER_PANEL_ROWS);
			expect(widget.render(WIDTH)).toHaveLength(FOOTER_PANEL_ROWS);
		}
	});

	it("every row satisfies pi-tui's visibleWidth(row) <= width", () => {
		for (const steps of [2, 12, 0]) {
			const widget = createFooterWidget(() => planRows(steps), () => WIDTH, FOOTER_PANEL_ROWS);
			for (const row of widget.render(WIDTH)) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(WIDTH);
			}
		}
	});

	it("blank rows are REAL full-width space strings — what pi-tui's Text renders as ZERO rows", () => {
		const widget = createFooterWidget(() => ["done"], () => WIDTH, FOOTER_PANEL_ROWS);
		const rows = widget.render(WIDTH);
		expect(rows).toHaveLength(FOOTER_PANEL_ROWS);
		expect(rows[0].trimEnd()).toBe("done");
		for (let i = 1; i < FOOTER_PANEL_ROWS; i++) {
			// The exact string the old array path lost: `.trim() === ""`.
			expect(rows[i]).toBe(" ".repeat(WIDTH));
			expect(visibleWidth(rows[i])).toBe(WIDTH);
		}
	});

	it("short/long/empty provider content all render the SAME frame height", () => {
		let content = planRows(9);
		const widget = createFooterWidget(() => content, () => WIDTH, FOOTER_PANEL_ROWS);
		const heights = new Set<number>();
		for (const next of [planRows(1), planRows(12), [], planRows(0)]) {
			content = next;
			widget.invalidate();
			heights.add(widget.render(WIDTH).length);
		}
		expect([...heights]).toEqual([FOOTER_PANEL_ROWS]);
	});

	it("never exceeds a render width narrower than the configured width", () => {
		const widget = createFooterWidget(() => planRows(12), () => 200, 10);
		const rows = widget.render(30);
		expect(rows).toHaveLength(10);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
	});

	it("pi-tui's Text still renders a whitespace-only pad row as ZERO rows (the C1 mechanism)", () => {
		const pad = " ".repeat(40);
		// Pin the pi-tui behaviour the fix depends on: this is what the string-array
		// path did to every pad row (`new Text(line, 1, 0)` per array entry).
		expect(new Text(pad, 1, 0).render(40)).toHaveLength(0);
		// The factory path hands the very same string to the renderer as-is.
		const widget = createFooterWidget(() => [pad], () => 40, 1);
		expect(widget.render(40)).toEqual([pad]);
	});
});

describe("plan panel — C1 regression: the old string-array path is gone", () => {
	const sessionIds: string[] = [];

	afterEach(() => {
		for (const id of sessionIds) {
			clearPlanPanel({ cwd: "/tmp", sessionManager: { sessionId: id }, ui: { setWidget: () => {} } } as any);
		}
		sessionIds.length = 0;
	});

	function makeCtx() {
		const sessionId = `footer-widget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		sessionIds.push(sessionId);
		const calls: { key: string; content: unknown }[] = [];
		const ctx = {
			cwd: `/tmp/orchestrator-footer-widget-${sessionId}`,
			sessionManager: { sessionId },
			ui: {
				setWidget: (key: string, content: unknown) => {
					calls.push({ key, content });
				},
			},
		};
		return { ctx, calls };
	}

	it("installs the plan widget as a component FACTORY (function), not a string array", () => {
		const { ctx, calls } = makeCtx();
		setupPlanPanel("Goal", ["Step A", "Step B"], ctx as any);
		expect(calls.length).toBeGreaterThan(0);
		const content = calls[calls.length - 1].content;
		expect(Array.isArray(content)).toBe(false); // was `string[]` before the fix
		expect(typeof content).toBe("function"); // component-factory form of setWidget
	});

	it("the factory's component emits EXACTLY 9 full-width rows, blank pads included", () => {
		const { ctx, calls } = makeCtx();
		setupPlanPanel("Goal", ["Step A", "Step B"], ctx as any);
		const content = calls[calls.length - 1].content as (
			tui: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		const component = content({}, {});
		const width = footerWidth();
		const rows = component.render(width);
		expect(rows).toHaveLength(FOOTER_PANEL_ROWS);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		// A real space-filled row must be present: that is the row pi-tui's Text
		// dropped, and the row whose absence re-opened the vacate/ghost path.
		expect(rows.some((row) => row === " ".repeat(width))).toBe(true);
	});
});

describe("delegate block — C2: live and completed branches emit the same row count", () => {
	it("renderResult: 10-row live frame and 1-line completed frame are both 10 rows", async () => {
		const { registerDelegateTool } = await import("./delegate-tool.ts");
		let def: any = null;
		const pi = { registerTool: (d: any) => { def = d; } } as any;
		registerDelegateTool(pi);
		expect(def).toBeTruthy();

		const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
		const component = { text: "", setText(t: string) { this.text = t; } } as any;
		const context = { state: {}, lastComponent: component, invalidate: () => {} } as any;

		// Live branch: a long streaming feed.
		const liveText = Array.from({ length: 40 }, (_, i) => `live line ${i}`).join("\n");
		def.renderResult(
			{ content: [{ type: "text", text: liveText }], details: { specialist: "coder" } },
			{ isPartial: true, expanded: false },
			theme,
			context,
		);
		const liveRows = component.text.split("\n");

		// Completed branch: a short one-line result. Before the fix this shrank to 2
		// rows and pi-tui cleared the vacated 8 rows erase-only.
		def.renderResult(
			{ content: [{ type: "text", text: "all done" }], details: { specialist: "coder" } },
			{ isPartial: false, expanded: false },
			theme,
			context,
		);
		const completedRows = component.text.split("\n");

		expect(completedRows.length).toBe(liveRows.length);
		expect(completedRows).toHaveLength(10);
		for (const row of completedRows) expect(visibleWidth(row)).toBeLessThanOrEqual(footerWidth());
	});
});
