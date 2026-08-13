/**
 * delegation-widget-controller.ts — per-session facade over the pure
 * delegation-widget store + renderer. Wires stacked per-delegation widgets to
 * a SEPARATE widget key ("orchestrator-delegations") so the aggregate plan
 * panel ("orchestrator-status") is never disturbed.
 *
 * This module is a leaf: it imports only the pure delegation-widget.ts. That
 * lets plan-panel.ts clear delegation widgets on teardown without introducing
 * an import cycle through delegate-controller → delegate-pipeline → plan-panel.
 */
import {
	createDelegationWidgetStore,
	renderDelegationWidgets,
	type DelegationWidgetState,
	type DelegationWidgetStore,
	type DelegationWidgetStartEvent,
} from "./delegation-widget.ts";

/** Separate widget key so stacked delegations never touch the plan panel. */
export const DELEGATION_KEY = "orchestrator-delegations";

const _stores = new Map<string, DelegationWidgetStore>();

function _extractSessionId(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	if (!("sessionManager" in ctx)) return undefined;
	const sm = (ctx as { sessionManager?: unknown }).sessionManager;
	if (!sm || typeof sm !== "object" || !("sessionId" in sm)) return undefined;
	const id = (sm as { sessionId?: string }).sessionId;
	return typeof id === "string" ? id : undefined;
}

function _resolveStore(ctx: unknown): DelegationWidgetStore | undefined {
	const id = _extractSessionId(ctx);
	return id ? _stores.get(id) : undefined;
}

/** Push the current widget list (or clear the key) to the ui widget slot. */
function _push(ctx: unknown): void {
	const id = _extractSessionId(ctx);
	const ui = (ctx as { ui?: { setWidget?: (key: string, content: string[] | undefined) => void } } | undefined)?.ui;
	if (!id || !ui?.setWidget) return;
	const store = _stores.get(id);
	if (!store || store.count() === 0) {
		ui.setWidget(DELEGATION_KEY, undefined);
		return;
	}
	ui.setWidget(DELEGATION_KEY, renderDelegationWidgets(store.list()));
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
	_push(ctx);
}
