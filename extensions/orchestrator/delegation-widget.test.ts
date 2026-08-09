/**
 * delegation-widget.test.ts — focused tests for the stacked per-delegation
 * widget store + pure renderer, plus controller/panel lifecycle integration.
 *
 * Covered areas (ticket #1):
 * - delegation-ID isolation: every widget is addressed by a stable id that
 *   survives retries; different ids never touch each other.
 * - stable start ordering: monotonic startOrder assigned once; retries and
 *   completions never reorder entries.
 * - terminal-event suppression: complete/error/abort after a terminal status
 *   are no-ops; progress after terminal is no-op.
 * - retry behavior: attempt++ on the SAME slot, collapse preference kept,
 *   endedAt/errorMessage cleared.
 * - per-widget collapse: each widget owns its own collapse flag.
 * - rendering budget: the widget list gets its OWN bounded budget
 *   (default 10), running widgets first, pure output (no input mutation).
 * - integration: controller lifecycle functions push rendered lines through
 *   plan-panel under a SEPARATE widget key (aggregate path untouched).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
	createDelegationWidgetStore,
	renderDelegationWidgets,
	isTerminal,
	type DelegationWidgetState,
	type DelegationWidgetStore,
} from "./delegation-widget.ts";
import {
	startDelegationWidget,
	progressDelegationWidget,
	completeDelegationWidget,
	removeDelegationWidget,
	listDelegationWidgets,
	countDelegationWidgets,
	clearDelegationWidgets,
} from "./delegate-controller.ts";
import { setupPlanPanel, clearPlanPanel } from "./plan-panel.ts";

// ── helpers ──────────────────────────────────────────────────────────────

function makeStore(): DelegationWidgetStore {
	return createDelegationWidgetStore();
}

/** Build a plain widget state for pure renderer tests (no store needed). */
function state(
	partial: Partial<Omit<DelegationWidgetState, "id" | "startOrder">> & { id: string; startOrder: number },
): DelegationWidgetState {
	return {
		id: partial.id,
		label: partial.label ?? `label-${partial.id}`,
		specialist: partial.specialist ?? "",
		startOrder: partial.startOrder,
		startedAt: partial.startedAt ?? 1000,
		status: partial.status ?? "running",
		collapsed: partial.collapsed ?? false,
		attempt: partial.attempt ?? 1,
		endedAt: partial.endedAt,
		errorMessage: partial.errorMessage,
		detail: partial.detail,
	};
}

const DELEGATION_KEY = "orchestrator-delegations";
const WIDGET_KEY = "orchestrator-status";

// ── ID isolation ─────────────────────────────────────────────────────────

describe("ID isolation", () => {
	it("different ids create distinct widgets", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.start({ id: "b", label: "B" });
		expect(store.count()).toBe(2);
		expect(store.get("a")?.label).toBe("A");
		expect(store.get("b")?.label).toBe("B");
	});

	it("completing one widget never touches another", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.start({ id: "b", label: "B" });
		store.complete("a");
		expect(store.get("a")?.status).toBe("completed");
		expect(store.get("b")?.status).toBe("running");
		expect(store.get("b")?.detail).toBeUndefined();
	});

	it("same id twice keeps one widget (double start updates label only)", () => {
		const store = makeStore();
		const first = store.start({ id: "a", label: "A" });
		const second = store.start({ id: "a", label: "A2" });
		expect(store.count()).toBe(1);
		expect(second).toBe(first);
		expect(second.label).toBe("A2");
		expect(second.attempt).toBe(1);
	});
});

// ── Stable ordering ──────────────────────────────────────────────────────

describe("stable ordering", () => {
	it("list() orders by startOrder asc", () => {
		const store = makeStore();
		store.start({ id: "first", label: "F" });
		store.start({ id: "second", label: "S" });
		store.start({ id: "third", label: "T" });
		expect(store.list().map((w) => w.id)).toEqual(["first", "second", "third"]);
	});

	it("completions never reorder entries", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.start({ id: "b", label: "B" });
		store.complete("b");
		store.complete("a");
		expect(store.list().map((w) => w.id)).toEqual(["a", "b"]);
	});

	it("retry keeps the original slot and startOrder", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.start({ id: "b", label: "B" });
		const bOrder = store.get("b")!.startOrder;
		store.complete("b");
		store.start({ id: "b", label: "B again" });
		expect(store.get("b")!.startOrder).toBe(bOrder);
		expect(store.list().map((w) => w.id)).toEqual(["a", "b"]);
	});

	it("startOrder is monotonic across a fresh store", () => {
		const store = makeStore();
		store.start({ id: "x", label: "X" });
		store.start({ id: "y", label: "Y" });
		expect(store.get("x")!.startOrder).toBeLessThan(store.get("y")!.startOrder);
	});

	it("list() returns a fresh array — caller mutation of the array is safe", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		const l1 = store.list();
		expect(l1).not.toBe(store.list());
		l1.length = 0;
		expect(store.count()).toBe(1);
	});
});

// ── Terminal-event suppression ───────────────────────────────────────────

describe("terminal-event suppression", () => {
	it("complete → error/abort/progress are no-ops", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.progress("a", "working");
		store.complete("a");
		const completed = store.get("a")!;
		store.error("a", "late failure");
		store.abort("a", "late abort");
		store.progress("a", "late progress");
		expect(store.get("a")).toBe(completed);
		expect(completed.status).toBe("completed");
		expect(completed.errorMessage).toBeUndefined();
		expect(completed.detail).toEqual(["working"]);
	});

	it("error → complete/abort are no-ops; status stays errored", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.error("a", "boom");
		store.complete("a");
		store.abort("a", "canceled");
		expect(store.get("a")!.status).toBe("errored");
		expect(store.get("a")!.errorMessage).toBe("boom");
	});

	it("abort → complete/error are no-ops", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.abort("a", "canceled");
		store.complete("a");
		store.error("a", "nope");
		expect(store.get("a")!.status).toBe("aborted");
		expect(store.get("a")!.errorMessage).toBe("canceled");
	});

	it("lifecycle calls on unknown ids return undefined without throwing", () => {
		const store = makeStore();
		expect(store.complete("missing")).toBeUndefined();
		expect(store.error("missing", "x")).toBeUndefined();
		expect(store.abort("missing", "x")).toBeUndefined();
		expect(store.progress("missing", "x")).toBeUndefined();
		expect(store.toggleCollapsed("missing")).toBeUndefined();
		expect(store.remove("missing")).toBe(false);
	});

	it("progress with an empty array clears detail", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.progress("a", ["line"]);
		store.progress("a", []);
		expect(store.get("a")!.detail).toBeUndefined();
	});
});

// ── Retry behavior ───────────────────────────────────────────────────────

describe("retry behavior", () => {
	it("restarting a completed widget: running again, attempt++, same slot, collapse kept", () => {
		const store = makeStore();
		const first = store.start({ id: "a", label: "A", startedAt: 111 });
		store.complete("a");
		first.collapsed = true;
		const retry = store.start({ id: "a", label: "A retry", startedAt: 222 });
		expect(retry).toBe(first); // same widget object — stable slot
		expect(retry.status).toBe("running");
		expect(retry.attempt).toBe(2);
		expect(retry.startOrder).toBe(first.startOrder);
		expect(retry.collapsed).toBe(true);
		expect(retry.endedAt).toBeUndefined();
		expect(retry.errorMessage).toBeUndefined();
		expect(retry.startedAt).toBe(222);
	});

	it("restarting an errored widget clears the error message", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.error("a", "boom");
		const retry = store.start({ id: "a", label: "A" });
		expect(retry.status).toBe("running");
		expect(retry.errorMessage).toBeUndefined();
		expect(retry.attempt).toBe(2);
	});

	it("double start while running does NOT increment attempt", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		const again = store.start({ id: "a", label: "A2" });
		expect(again.status).toBe("running");
		expect(again.attempt).toBe(1);
		expect(again.label).toBe("A2");
	});
});

// ── Per-widget collapse ──────────────────────────────────────────────────

describe("per-widget collapse", () => {
	it("toggling one widget never affects another", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.start({ id: "b", label: "B" });
		store.toggleCollapsed("a");
		expect(store.get("a")!.collapsed).toBe(true);
		expect(store.get("b")!.collapsed).toBe(false);
		store.toggleCollapsed("a");
		expect(store.get("a")!.collapsed).toBe(false);
		expect(store.get("b")!.collapsed).toBe(false);
	});

	it("collapse survives retry", () => {
		const store = makeStore();
		store.start({ id: "a", label: "A" });
		store.toggleCollapsed("a");
		store.complete("a");
		store.start({ id: "a", label: "A again" });
		expect(store.get("a")!.collapsed).toBe(true);
	});
});

// ── Pure renderer ────────────────────────────────────────────────────────

describe("renderDelegationWidgets", () => {
	it("renders one line per collapsed widget", () => {
		const store = makeStore();
		store.start({ id: "a", label: "Alpha" });
		store.start({ id: "b", label: "Beta" });
		expect(renderDelegationWidgets(store.list())).toEqual(["  ⟳ Alpha", "  ⟳ Beta"]);
	});

	it("expanded widget shows detail then error lines", () => {
		const store = makeStore();
		store.start({ id: "a", label: "Alpha" });
		store.progress("a", ["step 1", "step 2"]);
		store.error("a", "boom");
		expect(renderDelegationWidgets(store.list())).toEqual([
			"  ✗ Alpha",
			"      step 1",
			"      step 2",
			"      boom",
		]);
	});

	it("collapsed widget hides detail", () => {
		const store = makeStore();
		store.start({ id: "a", label: "Alpha" });
		store.progress("a", ["hidden"]);
		store.toggleCollapsed("a");
		expect(renderDelegationWidgets(store.list())).toEqual(["  ⟳ Alpha"]);
	});

	it("attempt tag renders on retries", () => {
		const store = makeStore();
		store.start({ id: "a", label: "Alpha" });
		store.complete("a");
		store.start({ id: "a", label: "Alpha" });
		expect(renderDelegationWidgets(store.list())).toEqual(["  ⟳ Alpha (attempt 2)"]);
	});

	it("running widgets sort before completed regardless of startOrder", () => {
		const states = [
			state({ id: "old-done", label: "Old done", startOrder: 0, status: "completed" }),
			state({ id: "new-run", label: "New run", startOrder: 1, status: "running" }),
			state({ id: "mid-done", label: "Mid done", startOrder: 2, status: "completed" }),
		];
		const lines = renderDelegationWidgets(states);
		expect(lines[0]).toContain("New run");
		expect(lines[1]).toContain("Old done");
		expect(lines[2]).toContain("Mid done");
	});

	it("applies its own bounded budget and reports hidden count", () => {
		const store = makeStore();
		for (let i = 0; i < 6; i++) store.start({ id: `w${i}`, label: `W${i}` });
		const lines = renderDelegationWidgets(store.list(), { maxLines: 4 });
		expect(lines).toHaveLength(4);
		expect(lines.slice(0, 3)).toEqual(["  ⟳ W0", "  ⟳ W1", "  ⟳ W2"]);
		expect(lines[3]).toBe("  … 3 more");
	});

	it("default budget is 10", () => {
		const store = makeStore();
		for (let i = 0; i < 14; i++) store.start({ id: `w${i}`, label: `W${i}` });
		const lines = renderDelegationWidgets(store.list());
		expect(lines).toHaveLength(10);
		expect(lines[9]).toBe("  … 5 more");
	});

	it("returns [] for empty states or non-positive budgets", () => {
		expect(renderDelegationWidgets([])).toEqual([]);
		const one = [state({ id: "a", label: "A", startOrder: 0 })];
		expect(renderDelegationWidgets(one, { maxLines: 0 })).toEqual([]);
		expect(renderDelegationWidgets(one, { maxLines: -1 })).toEqual([]);
	});

	it("never mutates its input", () => {
		const store = makeStore();
		store.start({ id: "a", label: "Alpha" });
		store.progress("a", "detail");
		store.complete("a");
		const before = JSON.stringify(store.list());
		renderDelegationWidgets(store.list(), { maxLines: 1 });
		expect(JSON.stringify(store.list())).toBe(before);
	});

	it("identical input → identical output", () => {
		const states = [
			state({ id: "a", label: "A", startOrder: 0, status: "running", detail: ["d1"] }),
			state({ id: "b", label: "B", startOrder: 1, status: "completed" }),
		];
		expect(renderDelegationWidgets(states)).toEqual(renderDelegationWidgets(states));
	});
});

// ── isTerminal ───────────────────────────────────────────────────────────

describe("isTerminal", () => {
	it("classifies statuses", () => {
		expect(isTerminal("running")).toBe(false);
		expect(isTerminal("completed")).toBe(true);
		expect(isTerminal("errored")).toBe(true);
		expect(isTerminal("aborted")).toBe(true);
	});
});

// ── Controller/panel lifecycle integration ───────────────────────────────
// Uses the REAL plan-panel (setupPlanPanel/clearPlanPanel) and the REAL
// controller lifecycle functions. Assertions verify the widget lines land on
// the SEPARATE "orchestrator-delegations" key while the aggregate plan stays
// on "orchestrator-status".

describe("controller/panel lifecycle integration", () => {
	const sessionIds: string[] = [];

	function makeCtx() {
		const sessionId = `it-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		sessionIds.push(sessionId);
		const calls: { key: string; content: string[] | undefined }[] = [];
		const ctx = {
			cwd: `/tmp/orchestrator-delegation-it-${sessionId}`,
			sessionManager: { sessionId },
			ui: { setWidget: (key: string, content: string[] | undefined) => calls.push({ key, content }) },
		};
		return { ctx, calls };
	}

	afterEach(() => {
		// Stop plan timers + drop panel instances for every session created here.
		for (const id of sessionIds) {
			clearPlanPanel({ cwd: "/tmp", sessionManager: { sessionId: id }, ui: { setWidget: () => {} } });
		}
		sessionIds.length = 0;
	});

	it("start → progress → complete pushes stacked lines under the SEPARATE delegation key", () => {
		const { ctx, calls } = makeCtx();
		setupPlanPanel("Integration goal", ["step one"], ctx);

		startDelegationWidget(ctx, { id: "d1", label: "Coder: fix auth", specialist: "coder" });
		progressDelegationWidget(ctx, "d1", "reading files");

		let last = [...calls].reverse().find((c) => c.key === DELEGATION_KEY);
		expect(last).toBeDefined();
		expect(last!.content!.join("\n")).toContain("⟳ Coder: fix auth");
		expect(last!.content!.join("\n")).toContain("reading files");

		// Aggregate plan path untouched — still renders under its own key.
		expect(calls.some((c) => c.key === WIDGET_KEY)).toBe(true);

		completeDelegationWidget(ctx, "d1");
		last = [...calls].reverse().find((c) => c.key === DELEGATION_KEY);
		expect(last!.content!.join("\n")).toContain("✓ Coder: fix auth");
	});

	it("remove and clear hide the widget (undefined content); remove is idempotent", () => {
		const { ctx, calls } = makeCtx();
		setupPlanPanel("Goal", ["step"], ctx);
		startDelegationWidget(ctx, { id: "d1", label: "Writer: docs", specialist: "writer" });
		expect(removeDelegationWidget(ctx, "d1")).toBe(true);
		let last = [...calls].reverse().find((c) => c.key === DELEGATION_KEY);
		expect(last!.content).toBeUndefined();
		expect(removeDelegationWidget(ctx, "d1")).toBe(false);

		startDelegationWidget(ctx, { id: "d2", label: "Scout: find", specialist: "scout" });
		clearDelegationWidgets(ctx);
		last = [...calls].reverse().find((c) => c.key === DELEGATION_KEY);
		expect(last!.content).toBeUndefined();
		expect(countDelegationWidgets(ctx)).toBe(0);
	});

	it("widgets are isolated per session", () => {
		const a = makeCtx();
		const b = makeCtx();
		setupPlanPanel("Goal A", ["s"], a.ctx);
		setupPlanPanel("Goal B", ["s"], b.ctx);
		startDelegationWidget(a.ctx, { id: "d1", label: "Coder: x", specialist: "coder" });
		expect(listDelegationWidgets(a.ctx)).toHaveLength(1);
		expect(listDelegationWidgets(b.ctx)).toHaveLength(0);
		expect(countDelegationWidgets(b.ctx)).toBe(0);
	});

	it("clearPlanPanel hides the delegation widget; later controller pushes no-op safely", () => {
		const { ctx, calls } = makeCtx();
		setupPlanPanel("Goal", ["step"], ctx);
		startDelegationWidget(ctx, { id: "d1", label: "Coder: x", specialist: "coder" });
		clearPlanPanel(ctx);
		expect([...calls].reverse().find((c) => c.key === DELEGATION_KEY)!.content).toBeUndefined();
		// Panel gone → controller keeps working, push is skipped, no throw.
		expect(() => startDelegationWidget(ctx, { id: "d2", label: "Writer: y", specialist: "writer" })).not.toThrow();
		clearDelegationWidgets(ctx); // tidy controller store
		expect(countDelegationWidgets(ctx)).toBe(0);
	});
});
