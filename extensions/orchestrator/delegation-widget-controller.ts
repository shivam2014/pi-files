/**
 * delegation-widget-controller.ts — per-session facade over the pure
 * delegation-widget store + renderer. Wires stacked per-delegation widgets to
 * a SEPARATE widget key ("orchestrator-delegations") so the aggregate plan
 * panel ("orchestrator-status") is never disturbed.
 *
 * This module is a leaf: it imports only the pure delegation-widget.ts plus the
 * footer boundary helpers (footer-widget.ts / footer-text.ts, neither of which
 * imports orchestrator state). That lets plan-panel.ts clear delegation widgets
 * on teardown without introducing an import cycle through
 * delegate-controller → delegate-pipeline → plan-panel.
 *
 * FOOTER BOUNDARY (Warp ghost, verified by footer-ghost-loop.test.ts): this
 * surface is installed through the COMPONENT-FACTORY form of `setWidget`, never
 * the `string[]` form. The array form wraps each row in pi-tui's `Text`, which
 * early-returns ZERO rows for whitespace-only text, so the surface height
 * followed its content (9 rows → 2 rows). pi-tui repaints only changed rows and
 * vacates the missing ones with an erase-only write (`"\r\x1b[2K"`) — no spaces
 * are ever written into those cells. Warp does not invalidate cells on
 * erase-only writes, so the previous glyphs stayed on screen: the stale footer
 * text the user sees. The factory path adds the component directly, so
 * `render(width)`'s output IS the frame and the row count stays constant.
 */
import {
	createDelegationWidgetStore,
	renderDelegationWidgets,
	type DelegationWidgetState,
	type DelegationWidgetStore,
	type DelegationWidgetStartEvent,
} from "./delegation-widget.ts";
import { footerWidth, toFooterLines } from "./footer-text.ts";
import { createFooterWidget, FOOTER_PANEL_ROWS, type FooterWidgetComponent } from "./footer-widget.ts";

/** Separate widget key so stacked delegations never touch the plan panel. */
export const DELEGATION_KEY = "orchestrator-delegations";

/**
 * Rows the delegation surface always occupies — the same constant height as the
 * plan panel. A constant row count is the whole fix: a surface that shrinks
 * leaves erase-only vacated rows, and Warp keeps their old glyphs.
 */
const DELEGATION_ROWS = FOOTER_PANEL_ROWS;

const _stores = new Map<string, DelegationWidgetStore>();
/** One constant-height component per session (created lazily on first push). */
const _widgets = new Map<string, FooterWidgetComponent>();

function _extractSessionId(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	if (!("sessionManager" in ctx)) return undefined;
	const sm = (ctx as { sessionManager?: unknown }).sessionManager;
	if (!sm || typeof sm !== "object" || !("sessionId" in sm)) return undefined;
	const id = (sm as { sessionId?: string }).sessionId;
	return typeof id === "string" ? id : undefined;
}

/** The factory form of pi's `setWidget`: a component, or `undefined` to clear. */
type SetWidgetFn = (
	key: string,
	content: string[] | ((tui: unknown, theme: unknown) => FooterWidgetComponent) | undefined,
) => void;

function _resolveStore(ctx: unknown): DelegationWidgetStore | undefined {
	const id = _extractSessionId(ctx);
	return id ? _stores.get(id) : undefined;
}

/**
 * Content rows for a session's delegation surface. `renderDelegationWidgets`
 * stays the pure content provider; `toFooterLines` sanitises its output for the
 * footer boundary: control-stripped, width-truncated and padded to EXACTLY
 * DELEGATION_ROWS rows with full-width space rows for the tail — never rows that
 * render as zero rows.
 */
function _contentRows(id: string): string[] {
	const store = _stores.get(id);
	const lines = store ? renderDelegationWidgets(store.list()) : [];
	return toFooterLines(lines.join("\n"), {
		maxLines: DELEGATION_ROWS,
		width: footerWidth(),
		keepSgr: true,
	});
}

/** Lazily create the session's constant-height footer component. */
function _widgetFor(id: string): FooterWidgetComponent {
	const existing = _widgets.get(id);
	if (existing) return existing;
	const widget = createFooterWidget(() => _contentRows(id), () => footerWidth(), DELEGATION_ROWS);
	_widgets.set(id, widget);
	return widget;
}

/** Push the current widget list (or clear the key) to the ui widget slot. */
function _push(ctx: unknown): void {
	const id = _extractSessionId(ctx);
	const ui = (ctx as { ui?: { setWidget?: SetWidgetFn } } | undefined)?.ui;
	if (!id || !ui?.setWidget) return;
	const store = _stores.get(id);
	if (!store || store.count() === 0) {
		// pi's documented clear semantics, kept as-is (delegation-widget.test.ts
		// asserts the key is set to `undefined`). NOTE: removing the widget is ITSELF
		// a surface shrink and pi-tui clears the vacated rows erase-only — recorded by
		// footer-ghost-loop.test.ts ("DOCUMENTED residual seam"). It cannot be closed
		// from here without either keeping 9 forever-blank rows or deferring the
		// removal past one paint window (a timer); both cost more than the artifact,
		// which at this point is a teardown repaint rather than a content change.
		ui.setWidget(DELEGATION_KEY, undefined);
		return;
	}
	// COMPONENT-FACTORY form: constant row count, so the surface never shrinks
	// while content changes and no vacated row is ever cleared erase-only.
	const widget = _widgetFor(id);
	widget.invalidate();
	ui.setWidget(DELEGATION_KEY, () => widget);
}

export function startDelegationWidget(
	ctx: unknown,
	event: DelegationWidgetStartEvent,
): DelegationWidgetState | undefined {
	const id = _extractSessionId(ctx);
	if (!id) return undefined;
	let store = _stores.get(id);
	if (!store) {
		store = createDelegationWidgetStore();
		_stores.set(id, store);
	}
	const state = store.start(event);
	_push(ctx);
	return state;
}

export function progressDelegationWidget(
	ctx: unknown,
	id: string,
	detail?: string | string[],
): DelegationWidgetState | undefined {
	const store = _resolveStore(ctx);
	if (!store) return undefined;
	const state = store.progress(id, detail);
	_push(ctx);
	return state;
}

export function completeDelegationWidget(ctx: unknown, id: string): DelegationWidgetState | undefined {
	const store = _resolveStore(ctx);
	if (!store) return undefined;
	const state = store.complete(id);
	_push(ctx);
	return state;
}

export function removeDelegationWidget(ctx: unknown, id: string): boolean {
	const store = _resolveStore(ctx);
	if (!store) return false;
	const removed = store.remove(id);
	_push(ctx);
	return removed;
}

export function listDelegationWidgets(ctx: unknown): DelegationWidgetState[] {
	const store = _resolveStore(ctx);
	return store ? store.list() : [];
}

export function countDelegationWidgets(ctx: unknown): number {
	const store = _resolveStore(ctx);
	return store ? store.count() : 0;
}

export function clearDelegationWidgets(ctx: unknown): void {
	const id = _extractSessionId(ctx);
	const store = id ? _stores.get(id) : undefined;
	if (store) store.clearAll();
	if (id) {
		// Drop the session's component too: it owns no timers, but keeping it after
		// teardown would leak one instance per session.
		_widgets.get(id)?.dispose();
		_widgets.delete(id);
	}
	_push(ctx);
}
