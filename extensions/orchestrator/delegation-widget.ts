/**
 * delegation-widget.ts — pure, dependency-free state + rendering for stacked
 * per-delegation status widgets.
 *
 * Design goals (each covered by delegation-widget.test.ts):
 * - delegation-ID-keyed state: every widget is addressed by a stable
 *   delegation id that survives retries.
 * - stable start ordering: a monotonic startOrder is assigned once on first
 *   start; retries and completions never reorder entries.
 * - terminal-event suppression: complete/error/abort after a widget already
 *   reached a terminal status are no-ops.
 * - idempotent teardown: remove()/clearAll() are safe to call repeatedly.
 * - separate per-widget collapsed state: each widget owns its own collapse
 *   flag; toggling one never affects another.
 * - pure safe rendering: renderDelegationWidgets() never mutates its inputs
 *   and returns identical output for identical input. The widget list gets
 *   its OWN bounded budget — it does not consume the activity-feed fixed
 *   line budget used by the aggregate plan renderer.
 *
 * This module intentionally has zero imports — it must stay pure and safe to
 * import from any layer (controller registry, plan panel, tests).
 */

export type DelegationWidgetStatus = "running" | "completed" | "errored" | "aborted";

export interface DelegationWidgetState {
	/** Stable delegation id (survives retries). */
	id: string;
	/** Human-readable label, e.g. "Coder: fix auth middleware". */
	label: string;
	/** Specialist name (lowercase), e.g. "coder". Empty when unknown. */
	specialist: string;
	/** Monotonic start sequence — assigned once on first start, never reassigned. */
	startOrder: number;
	/** Epoch ms of the first start (or latest retry start). */
	startedAt: number;
	status: DelegationWidgetStatus;
	/** Per-widget collapse flag — independent for each widget. */
	collapsed: boolean;
	/** Retry attempt counter — increments when a terminal widget restarts. */
	attempt: number;
	/** Epoch ms when a terminal status was reached (undefined while running). */
	endedAt?: number;
	/** Error/abort detail, shown in the expanded view. */
	errorMessage?: string;
	/** Optional detail lines, shown only in the expanded view. */
	detail?: string[];
}

export interface DelegationWidgetStartEvent {
	id: string;
	label: string;
	specialist?: string;
	startedAt?: number;
}

export interface DelegationWidgetRenderOptions {
	/** Separate bounded handling — cap on total rendered lines (default 10). */
	maxLines?: number;
}

const TERMINAL: ReadonlySet<DelegationWidgetStatus> = new Set(["completed", "errored", "aborted"]);

export function isTerminal(status: DelegationWidgetStatus): boolean {
	return TERMINAL.has(status);
}

export interface DelegationWidgetStore {
	start(event: DelegationWidgetStartEvent): DelegationWidgetState;
	/** Replace the running widget's detail lines. No-op after terminal status. */
	progress(id: string, detail?: string | string[]): DelegationWidgetState | undefined;
	complete(id: string): DelegationWidgetState | undefined;
	error(id: string, message?: string): DelegationWidgetState | undefined;
	abort(id: string, message?: string): DelegationWidgetState | undefined;
	toggleCollapsed(id: string): DelegationWidgetState | undefined;
	remove(id: string): boolean;
	get(id: string): DelegationWidgetState | undefined;
	list(): DelegationWidgetState[];
	count(): number;
	clearAll(): void;
}

export function createDelegationWidgetStore(): DelegationWidgetStore {
	const _widgets = new Map<string, DelegationWidgetState>();
	// Monotonic, never reset — even across clearAll(), order values stay unique.
	let _nextOrder = 0;

	function start(event: DelegationWidgetStartEvent): DelegationWidgetState {
		const startedAt = event.startedAt ?? Date.now();
		const existing = _widgets.get(event.id);
		if (existing) {
			if (isTerminal(existing.status)) {
				// Retry: same id, same startOrder, new attempt. Collapse preference preserved.
				existing.status = "running";
				existing.attempt += 1;
				existing.startedAt = startedAt;
				existing.endedAt = undefined;
				existing.errorMessage = undefined;
				existing.label = event.label;
				if (event.specialist) existing.specialist = event.specialist;
				return existing;
			}
			// Double start while running: update label, keep order/attempt/startedAt.
			existing.label = event.label;
			if (event.specialist) existing.specialist = event.specialist;
			return existing;
		}
		const widget: DelegationWidgetState = {
			id: event.id,
			label: event.label,
			specialist: event.specialist ?? "",
			startOrder: _nextOrder++,
			startedAt,
			status: "running",
			collapsed: false,
			attempt: 1,
		};
		_widgets.set(event.id, widget);
		return widget;
	}

	function progress(id: string, detail?: string | string[]): DelegationWidgetState | undefined {
		const w = _widgets.get(id);
		if (!w || isTerminal(w.status)) return w; // terminal-event suppression
		if (detail === undefined) return w;
		const lines = Array.isArray(detail) ? detail : [detail];
		w.detail = lines.length > 0 ? lines : undefined;
		return w;
	}

	function complete(id: string): DelegationWidgetState | undefined {
		const w = _widgets.get(id);
		if (!w || isTerminal(w.status)) return w; // terminal-event suppression
		w.status = "completed";
		w.endedAt = Date.now();
		return w;
	}

	function error(id: string, message?: string): DelegationWidgetState | undefined {
		const w = _widgets.get(id);
		if (!w || isTerminal(w.status)) return w;
		w.status = "errored";
		w.endedAt = Date.now();
		w.errorMessage = message;
		return w;
	}

	function abort(id: string, message?: string): DelegationWidgetState | undefined {
		const w = _widgets.get(id);
		if (!w || isTerminal(w.status)) return w;
		w.status = "aborted";
		w.endedAt = Date.now();
		w.errorMessage = message;
		return w;
	}

	function toggleCollapsed(id: string): DelegationWidgetState | undefined {
		const w = _widgets.get(id);
		if (!w) return undefined;
		w.collapsed = !w.collapsed;
		return w;
	}

	function remove(id: string): boolean {
		// Idempotent teardown: second remove returns false, never throws.
		return _widgets.delete(id);
	}

	function get(id: string): DelegationWidgetState | undefined {
		return _widgets.get(id);
	}

	/** Stable start ordering: by startOrder asc, id as deterministic tiebreak. */
	function list(): DelegationWidgetState[] {
		return [..._widgets.values()].sort((a, b) =>
			a.startOrder !== b.startOrder
				? a.startOrder - b.startOrder
				: a.id < b.id
					? -1
					: a.id > b.id
						? 1
						: 0,
		);
	}

	function count(): number {
		return _widgets.size;
	}

	function clearAll(): void {
		_widgets.clear();
	}

	return { start, progress, complete, error, abort, toggleCollapsed, remove, get, list, count, clearAll };
}

const STATUS_ICON: Record<DelegationWidgetStatus, string> = {
	running: "⟳",
	completed: "✓",
	errored: "✗",
	aborted: "⊘",
};

/** Render one widget's lines: expanded shows detail, collapsed shows one line. */
function _renderWidgetLines(w: DelegationWidgetState): string[] {
	const attemptTag = w.attempt > 1 ? ` (attempt ${w.attempt})` : "";
	const head = `  ${STATUS_ICON[w.status]} ${w.label}${attemptTag}`;
	if (w.collapsed) return [head];
	const lines = [head];
	if (w.detail && w.detail.length > 0) {
		for (const d of w.detail) lines.push(`      ${d}`);
	}
	if (w.status === "errored" || w.status === "aborted") {
		if (w.errorMessage) lines.push(`      ${w.errorMessage}`);
	}
	return lines;
}

/**
 * Pure safe renderer: sorts a COPY of the input, never mutates state, and
 * returns identical output for identical input.
 *
 * Separate bounded handling: truncates by its own maxLines budget (default
 * 10) — it does NOT use any activity-feed fixed-line budget. Running widgets
 * are prioritized so active work is never hidden behind completed entries.
 */
export function renderDelegationWidgets(
	states: readonly DelegationWidgetState[],
	options?: DelegationWidgetRenderOptions,
): string[] {
	const maxLines = options?.maxLines ?? 10;
	if (maxLines < 1 || states.length === 0) return [];

	// Stable ordering: running first (priority), then startOrder, then id.
	const ordered = [...states].sort((a, b) => {
		const aRun = a.status === "running" ? 0 : 1;
		const bRun = b.status === "running" ? 0 : 1;
		if (aRun !== bRun) return aRun - bRun;
		if (a.startOrder !== b.startOrder) return a.startOrder - b.startOrder;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	const allLines: string[] = [];
	for (const w of ordered) allLines.push(..._renderWidgetLines(w));

	if (allLines.length <= maxLines) return allLines;
	const hidden = allLines.length - maxLines + 1;
	return [...allLines.slice(0, maxLines - 1), `  … ${hidden} more`];
}
