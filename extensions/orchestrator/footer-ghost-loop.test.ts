/**
 * footer-ghost-loop.test.ts — feedback loop for the Warp footer ghost.
 *
 * THE BUG (user-facing): on Warp, stale glyphs stay in pi's footer strip after
 * the footer content changes/shrinks. Mouse selection clears them.
 *
 * MECHANISM (established, not re-derived here): pi-tui's differential renderer
 * repaints only the CHANGED rows, writes `\x1b[2K` before each row, and clears
 * VACATED rows with an erase-only write (`"\r\x1b[2K"`) — no spaces are ever
 * written into those cells. Warp does not invalidate cells on erase-only writes,
 * so the previous glyphs survive. Therefore: ANY footer surface whose rendered
 * ROW COUNT shrinks leaves stale text.
 *
 * WHY THIS FILE EXISTS: `footer-text.test.ts` / `footer-widget.test.ts` assert a
 * helper's return value against the local width function (helper-vs-helper). A
 * reviewer proved that seam cannot see this defect. This loop drives the REAL
 * chain instead:
 *
 *   widget payload → real pi-tui `Container` (+ real `Text` for the array path,
 *   exactly as `InteractiveMode.setExtensionWidget` builds it)
 *   → real `TUI.doRender()` → captured `Terminal.write()` byte stream
 *
 * and asserts the SYMPTOM on the byte stream:
 *   (1) the painted row count is IDENTICAL across frames, and
 *   (2) every row vacated in the later frame is written back as a full-width run
 *       of spaces (cells overwritten) instead of only `\x1b[2K` / `\r\x1b[2K`.
 *
 * The array→`Text` path is included as the CONTROL and is asserted to FAIL the
 * invariant (that is the red-capable proof: pad rows render as zero rows and the
 * surface collapses). The delegations surface is asserted to HOLD the invariant.
 *
 * Deterministic: pinned width, no timers, no sleeps.
 * Run: npx vitest run footer-ghost-loop.test.ts
 */
import { describe, expect, it, afterEach } from "vitest";
import * as piTui from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { createFooterWidget, FOOTER_PANEL_ROWS } from "./footer-widget.ts";
import { footerWidth, toFooterLines } from "./footer-text.ts";
import {
	DELEGATION_KEY,
	clearDelegationWidgets,
	completeDelegationWidget,
	progressDelegationWidget,
	startDelegationWidget,
} from "./delegation-widget-controller.ts";

/** Pinned terminal geometry — the loop must never depend on a real TTY. */
const COLS = 80;
const ROWS = 24;
/** pi's `InteractiveMode.MAX_WIDGET_LINES` — the array path's line cap. */
const MAX_WIDGET_LINES = 10;

type ComponentLike = Parameters<Container["addChild"]>[0];
/** `TUI` reaches us through the module namespace object: the class is a runtime
 * value either way, but the typings resolved by `tsc` declare it type-only. */
interface TuiLike {
	terminal: unknown;
	setClearOnShrink(enabled: boolean): void;
	addChild(component: ComponentLike): void;
	doRender(): void;
}
const TuiCtor = (piTui as unknown as { TUI: new (terminal: unknown) => TuiLike }).TUI;
type WidgetFactory = (tui: unknown, theme: unknown) => ComponentLike;
type WidgetContent = string[] | WidgetFactory | undefined;

// ── Fake terminal (implements pi-tui's Terminal surface) ──────────────────

class FakeTerminal {
	columns = COLS;
	rows = ROWS;
	/** EVERY byte pi-tui hands the terminal, in write order. */
	chunks: string[] = [];
	write(data: string): void {
		this.chunks.push(data);
	}
	start(): void {}
	stop(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	moveBy(_lines: number): void {}
	cursorTo(_row: number, _col: number): void {}
	clearLine(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
}

// ── The real widget pipeline ──────────────────────────────────────────────

/**
 * Faithful stand-in for `InteractiveMode.setExtensionWidget` + `renderWidgets`:
 * the widget area is one `Container`; the array form wraps each entry in
 * `new Text(line, 1, 0)`, the factory form adds the returned component directly,
 * and `undefined` removes the component (the surface then shrinks).
 */
function makePiWidgetArea() {
	const area = new Container();
	const setWidget = (_key: string, content: WidgetContent): void => {
		area.clear();
		if (content === undefined) return;
		if (Array.isArray(content)) {
			const box = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) box.addChild(new Text(line, 1, 0));
			area.addChild(box);
			return;
		}
		area.addChild(content({}, {}));
	};
	return { area, setWidget };
}

interface Loop {
	setWidget: (key: string, content: WidgetContent) => void;
	/** Exactly what `TUI.doRender()` diffs: the widget area's rendered rows. */
	rows(): string[];
	/** Run one real render cycle and return the bytes it wrote. */
	paint(): string;
}

function createLoop(): Loop {
	const fake = new FakeTerminal();
	const tui = new TuiCtor(fake);
	// pi's default (`settingsManager.getClearOnShrink()` is off): a shrink is
	// handled by the differential/vacate path, NOT by a scrollback-wiping clear.
	tui.setClearOnShrink(false);
	const { area, setWidget } = makePiWidgetArea();
	tui.addChild(area);
	return {
		setWidget,
		rows: () => area.render(fake.columns),
		paint: () => {
			fake.chunks = [];
			tui.doRender();
			return fake.chunks.join("");
		},
	};
}

// ── Symptom-level analysis helpers ────────────────────────────────────────

/** A row carries no visible glyphs (padding spaces only). */
function isBlankRow(row: string): boolean {
	return row.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
}

/** Row indexes that held glyphs in `before` and are blank in `after`. */
function vacatedRows(before: readonly string[], after: readonly string[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < before.length; i++) {
		if (!isBlankRow(before[i]) && (i >= after.length || isBlankRow(after[i]))) out.push(i);
	}
	return out;
}

/** How often the byte stream tells the terminal to overwrite a full-width row. */
function fullWidthSpaceWrites(bytes: string, width: number): number {
	return (bytes.match(new RegExp(` {${width},}`, "g")) ?? []).length;
}

function planRows(n: number): string[] {
	const rows = ["● Goal: close the footer ghost"];
	for (let i = 0; i < n; i++) rows.push(`  ${i % 2 === 0 ? "✓" : "○"} step ${i + 1} of ${n}`);
	return rows;
}

function detailLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `tool call ${i + 1}: read file ${i + 1}`);
}

// Pin `process.stdout.columns` so `footerWidth()` is fixed for every frame.
const ORIGINAL_COLUMNS = process.stdout.columns;
process.stdout.columns = COLS;
afterEach(() => {
	Object.defineProperty(process.stdout, "columns", {
		value: ORIGINAL_COLUMNS,
		configurable: true,
		writable: true,
	});
});

describe("footer ghost loop — painted row count must never shrink", () => {
	it("FACTORY surface (createFooterWidget, as the plan panel installs it): constant rows + real space rows", () => {
		const loop = createLoop();
		let content = planRows(12);
		const widget = createFooterWidget(
			() => toFooterLines(content.join("\n"), { maxLines: FOOTER_PANEL_ROWS, width: footerWidth(), keepSgr: true }),
			() => footerWidth(),
			FOOTER_PANEL_ROWS,
		);
		loop.setWidget("orchestrator-status", () => widget);

		const bytesA = loop.paint();
		const rowsA = loop.rows();
		content = planRows(2);
		const bytesB = loop.paint();
		const rowsB = loop.rows();
		const vacated = vacatedRows(rowsA, rowsB);
		const spacesB = fullWidthSpaceWrites(bytesB, footerWidth());
		console.log(
			`[GHOST-LOOP factory] rowsA=${rowsA.length} rowsB=${rowsB.length} vacated=${vacated.length} ` +
				`fullWidthSpaceWrites(B)=${spacesB} bytesA=${bytesA.length} bytesB=${bytesB.length}`,
		);

		expect(rowsA).toHaveLength(FOOTER_PANEL_ROWS);
		expect(rowsB).toHaveLength(rowsA.length);
		expect(rowsB).not.toEqual(rowsA); // the content really changed
		expect(rowsB.filter(isBlankRow).length).toBeGreaterThan(0); // real blank rows in frame B
		expect(vacated.length).toBeGreaterThan(0);
		expect(spacesB).toBeGreaterThanOrEqual(vacated.length);
	});

	it("DELEGATIONS surface (orchestrator-delegations): constant rows + real space rows", () => {
		const loop = createLoop();
		const ctx = { sessionManager: { sessionId: "ghost-loop" }, ui: { setWidget: loop.setWidget } };

		startDelegationWidget(ctx, { id: "d1", label: "Coder: fix footer ghost", specialist: "coder" });
		progressDelegationWidget(ctx, "d1", detailLines(8));
		const bytesA = loop.paint();
		const rowsA = loop.rows();

		progressDelegationWidget(ctx, "d1", ["done"]); // content shrinks hard
		completeDelegationWidget(ctx, "d1");
		const bytesB = loop.paint();
		const rowsB = loop.rows();
		const vacated = vacatedRows(rowsA, rowsB);
		const spacesB = fullWidthSpaceWrites(bytesB, footerWidth());
		console.log(
			`[GHOST-LOOP delegations] rowsA=${rowsA.length} rowsB=${rowsB.length} vacated=${vacated.length} ` +
				`fullWidthSpaceWrites(B)=${spacesB} bytesA=${bytesA.length} bytesB=${bytesB.length}`,
		);

		expect(rowsA).toHaveLength(FOOTER_PANEL_ROWS);
		expect(rowsB).toHaveLength(rowsA.length);
		expect(rowsB).not.toEqual(rowsA);
		expect(rowsB.filter(isBlankRow).length).toBeGreaterThan(0);
		expect(vacated.length).toBeGreaterThan(0);
		expect(spacesB).toBeGreaterThanOrEqual(vacated.length);
	});

	it("CONTROL (array → Text, pi's string[] path): the SAME invariant FAILS — that is the red-capable proof", () => {
		const loop = createLoop();
		const pad = " ".repeat(footerWidth());

		loop.setWidget(DELEGATION_KEY, planRows(8)); // 9 non-blank rows
		const bytesA = loop.paint();
		const rowsA = loop.rows();

		// 2 real rows + 3 explicitly blank pad rows → Text drops the pad rows.
		loop.setWidget(DELEGATION_KEY, [planRows(1)[0], "  ✓ step one", pad, pad, pad]);
		const bytesB = loop.paint();
		const rowsB = loop.rows();
		const vacated = vacatedRows(rowsA, rowsB);
		const spacesB = fullWidthSpaceWrites(bytesB, footerWidth());
		console.log(
			`[GHOST-LOOP CONTROL(red)] rowsA=${rowsA.length} rowsB=${rowsB.length} vacated=${vacated.length} ` +
				`fullWidthSpaceWrites(B)=${spacesB} eraseOnlyVacate=${/\r\x1b\[2K/.test(bytesB)}`,
		);

		// The control FAILS the invariant this loop enforces for the fixed surfaces:
		expect(rowsB).not.toHaveLength(rowsA.length); // height collapses (5 entries → 2 rows)
		expect(rowsB.length).toBeLessThan(rowsA.length);
		expect(rowsB.filter(isBlankRow)).toHaveLength(0); // pad rows rendered as ZERO rows
		// …and the vacated rows reach Warp as erase-only writes: no cells overwritten.
		expect(bytesB).toContain("\x1b[2K");
		expect(bytesB).toMatch(/\r\x1b\[2K/);
		expect(spacesB).toBe(0);
		expect(vacated.length).toBeGreaterThan(0);
	});

	it("DOCUMENTED residual seam: removing the widget key is itself a shrink (erase-only vacate)", () => {
		const loop = createLoop();
		const ctx = { sessionManager: { sessionId: "ghost-loop-clear" }, ui: { setWidget: loop.setWidget } };
		startDelegationWidget(ctx, { id: "d1", label: "Coder: fix footer ghost", specialist: "coder" });
		const rowsA = loop.rows();
		loop.paint();

		// pi's documented clear (`delegation-widget.test.ts` asserts this contract).
		clearDelegationWidgets(ctx);
		const bytesB = loop.paint();
		const rowsB = loop.rows();
		const spacesB = fullWidthSpaceWrites(bytesB, footerWidth());
		console.log(
			`[GHOST-LOOP clear] rowsA=${rowsA.length} rowsB=${rowsB.length} ` +
				`fullWidthSpaceWrites(B)=${spacesB} eraseOnlyVacate=${/\r\x1b\[2K/.test(bytesB)}`,
		);

		// Recorded, not hidden: a paint that lands AFTER the key removal is
		// erase-only at the pi-tui level and cannot be fixed from the extension
		// without either keeping 9 forever-blank rows or deferring the removal
		// past one paint window (a timer). See the controller's comment.
		expect(rowsB).toHaveLength(0);
		expect(spacesB).toBe(0);
	});
});
