import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { truncateLabel } from "../token-saver.ts";
import { formatDuration } from "./ui-utils.ts";
import type { PlanStep } from "./types.ts";
import type { ActivityFeedState, Step, Substep } from "./types.ts";
import { renderActivityFeed } from "./activity-feed.ts";
import { SPINNER_INTERVAL_MS, resetSpinner } from "./spinner-state.ts";

import { debugLog } from "./debug.ts";

export interface TimelineEntry {
	t: number;
	event: string;
	render: string;
	state: Record<string, unknown> | null;
	feedState?: Record<string, unknown> | null;
	feedRender?: string;
}

/**
 * PlanPanel — per-session plan state and timeline rendering.
 *
 * ## Instance resolution
 * This module exports 23 proxy functions that forward to a PlanPanel instance.
 * Two resolution strategies:
 *
 *   **Map lookup (6 functions)** — Functions that receive `ctx` resolve the
 *   PlanPanel instance by `ctx.sessionManager.sessionId`. These are the
 *   lifecycle boundary functions: setupPlanPanel, clearPlanPanel,
 *   completePlanStep, finalizePlanStep, clearPlanIfComplete, errorPlanStep.
 *
 *   **_currentInstance (17 functions)** — Functions without `ctx` use a
 *   module-scoped `_currentInstance` pointer. These are only safe to call
 *   after `setupPlanPanel` has set the pointer for the current session.
 *   In concurrent multi-session scenarios, these may target the wrong
 *   session's panel. See also: VISION.md, ADR-0003.
 *
 * ## Lifecycle
 * PlanPanel instances live in a module-scoped `Map<string, PlanPanel>`
 * keyed by `sessionId`. They are created by `_resolveOrCreate(ctx)` and
 * should be cleaned up via `_removeSession(sessionId)` when a session ends.
 */

const MAX_TIMELINE_FRAMES = 500;
const WIDGET_KEY = "orchestrator-status";
const BUDGET = 9;

export class PlanPanel {
	private _cwd: string;
	private _timeline: TimelineEntry[] = [];
	private _timelineStart: number = Date.now();
	private _sessionId: string | null = null;
	private _activeDelegations: number = 0;
	private planState: { goal: string; steps: PlanStep[]; startTime: number; sessionId: string } | null = null;
	private _setWidget: ((key: string, content: string[] | undefined) => void) | null = null;
	private _lastWidgetContent: string[] | null = null;
	private _planTimer: ReturnType<typeof setInterval> | null = null;
	private _spinnerTimer: ReturnType<typeof setInterval> | null = null;
	private _cleared: boolean = false;

	constructor(ctx?: { cwd?: string }) {
		this._cwd = ctx?.cwd ?? process.cwd();
	}

	incrementDelegationCount(): void { this._activeDelegations++; }
	decrementDelegationCount(): void { this._activeDelegations = Math.max(0, this._activeDelegations - 1); }

	private savePlanState(): void {
		if (!this.planState) return;
		try {
			const dir = join(this._cwd, '.pi');
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'orchestrator-plan.json'), JSON.stringify({
				goal: this.planState.goal,
				steps: this.planState.steps.map(s => ({ label: s.label, completed: s.completed, errored: s.errored })),
				startTime: this.planState.startTime,
			}, null, 2));
		} catch { /* silent */ }
	}

	private loadPlanState(): typeof this.planState {
		try {
			const statePath = join(this._cwd, '.pi', 'orchestrator-plan.json');
			if (!existsSync(statePath)) return null;
			const saved = JSON.parse(readFileSync(statePath, 'utf8'));
			if (!saved?.goal || !saved?.steps) return null;
			return { goal: saved.goal, steps: saved.steps.map((s: any) => ({ ...s, active: false })), startTime: saved.startTime || Date.now(), sessionId: this._sessionId ?? saved.sessionId ?? "unknown" };
		} catch { return null; }
	}

	summarizeGoal(goal: string): string {
		let cleaned = goal.replace(/https?:\/\/[^\s]+/g, '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '').trim();
		const firstLine = cleaned.split('\n')[0]?.trim() || cleaned;
		return firstLine.length <= 120 ? firstLine : firstLine.slice(0, 117) + '...';
	}

	generatePlanFromPrompt(_prompt: string): string[] { return ["Planning..."]; }

	private toFeedState(state: { goal: string; steps: PlanStep[]; startTime: number }): ActivityFeedState {
		const steps: Step[] = state.steps.map(ps => {
			const substeps: Substep[] = [];
			if (ps.completed && ps.detailLines?.length) {
				for (const line of ps.detailLines) {
					const m = line.match(/^    ✓ Report: (.+)$/i);
					if (m) substeps.push({ label: `Report: ${m[1].trim()}`, completed: true });
				}
			}
			if (ps.active && ps.detailLines?.length) {
				for (const line of ps.detailLines) {
					const rm = line.match(/^    ✓ Report: (.+)$/i);
					if (rm) { substeps.push({ label: `Report: ${rm[1].trim()}`, completed: true }); continue; }
					const dm = line.match(/^    ✓ (.+)$/);
					if (dm) { substeps.push({ label: dm[1].trim(), completed: true }); continue; }
					const sm = line.match(/^    [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (.+)$/);
					if (sm && !substeps.find(s => !s.completed)) substeps.push({ label: sm[1].trim(), completed: false });
					const om = line.match(/^    ○ (.+)$/);
					if (om) substeps.push({ label: om[1].trim(), completed: false });
				}
			}
			if (!ps.completed && !ps.active && ps.detailLines?.length) {
				for (const line of ps.detailLines) {
					const sm = line.match(/^    [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (.+)$/);
					if (sm && !substeps.find(s => !s.completed)) substeps.push({ label: sm[1].trim(), completed: false });
				}
			}
			return { label: truncateLabel(ps.label, 120), completed: ps.completed, startTime: ps.startTime, endTime: ps.endTime, substeps };
		});
		const erroredStep = state.steps.find(s => s.errored);
		return {
			goal: state.goal,
			steps,
			currentStep: state.steps.findIndex(s => s.active),
			rawText: "",
			planParsed: false,
			errored: !!erroredStep,
			errorMessage: erroredStep?.errorMessage,
		};
	}

	private trimToBudget(lines: string[], budget: number): string[] {
		if (lines.length <= budget) return lines;
		const essentialCount = Math.min(2, lines.length);
		const essential = lines.slice(0, essentialCount);
		const remainingBudget = budget - essential.length;
		if (remainingBudget <= 0) return essential.slice(0, budget);
		const rest = lines.slice(essentialCount);
		let activeIdx = -1;
		for (let i = 0; i < rest.length; i++) {
			if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(rest[i].trimStart())) { activeIdx = i; break; }
		}
		if (activeIdx >= 0) {
			const before = rest.slice(0, activeIdx);
			const fromActive = rest.slice(activeIdx);
			const keepFromActive = Math.min(fromActive.length, remainingBudget);
			const keepBefore = Math.min(before.length, remainingBudget - keepFromActive);
			const trimmedBefore = before.slice(before.length - keepBefore);
			return [...essential, ...trimmedBefore, ...fromActive.slice(0, keepFromActive)];
		}
		return [...essential, ...rest.slice(rest.length - remainingBudget)];
	}

	private renderPlanLines(): string[] {
		if (!this.planState) return [];
		return this.trimToBudget(renderActivityFeed("", this.toFeedState(this.planState)).split("\n"), BUDGET);
	}

	private _renderWidget(): void {
		if (!this._setWidget || this._cleared) return;
		const lines = this.renderPlanLines();
		if (this._lastWidgetContent && this._lastWidgetContent.length === lines.length) {
			let same = true;
			for (let i = 0; i < lines.length; i++) { if (this._lastWidgetContent[i] !== lines[i]) { same = false; break; } }
			if (same) return;
		}
		this._lastWidgetContent = lines;
		this._setWidget(WIDGET_KEY, lines);
	}

	private startPlanTimer(): void {
		this.stopPlanTimer();
		const self = this;
		this._spinnerTimer = setInterval(() => {
			if (self._spinnerTimer === null) return;
			if (self.planState) { self._renderWidget(); } else { self.stopPlanTimer(); }
		}, SPINNER_INTERVAL_MS);
		this._planTimer = setInterval(() => {
			if (self._planTimer === null) return;
			if (self.planState) { self._renderWidget(); } else { self.stopPlanTimer(); }
		}, 1000);
	}

	private stopPlanTimer(): void {
		if (this._planTimer !== null) { clearInterval(this._planTimer); this._planTimer = null; }
		if (this._spinnerTimer !== null) { clearInterval(this._spinnerTimer); this._spinnerTimer = null; }
	}

	/**
	 * Stop all active timers for this session.
	 * Does NOT reset plan state or widget content — use clearPlanPanel() for full teardown.
	 */
	public reset(): void {
		this.stopPlanTimer();
	}

	inspectPlanState(): Record<string, unknown> | null {
		if (!this.planState) return null;
		const steps = this.planState.steps.map((s, i) => ({
			index: i, label: s.label,
			state: s.completed ? "completed" : s.errored ? "errored" : s.active ? "active" : "pending",
			substepCount: (s as any).detailLines?.length ?? 0, detail: s.detail ?? null,
			startTime: s.startTime ?? null,
		}));
		return { goal: this.planState.goal, steps, completedCount: this.planState.steps.filter(s => s.completed).length, totalCount: this.planState.steps.length, activeDelegations: this._activeDelegations, elapsedMs: Date.now() - this.planState.startTime };
	}

	snapshotPlanRender(): string { return this._lastWidgetContent?.join("\n") ?? ""; }

	recordTimelineFrame(event: string, feedState?: Record<string, unknown> | null, feedRender?: string): void {
		const entry = { t: Date.now() - this._timelineStart, event, render: this.snapshotPlanRender(), state: this.inspectPlanState(), ...(feedState !== undefined ? { feedState } : {}), ...(feedRender !== undefined ? { feedRender } : {}) };
		const last = this._timeline[this._timeline.length - 1];
		if (last && last.event === entry.event) {
			const stripTime = (s: Record<string, unknown> | null) => { if (!s) return null; const { elapsedMs: _, ...rest } = s as any; return rest; };
			if (JSON.stringify(stripTime(last.state)) === JSON.stringify(stripTime(entry.state)) && JSON.stringify(last.feedState ?? null) === JSON.stringify(entry.feedState ?? null)) return;
		}
		if (this._timeline.length >= MAX_TIMELINE_FRAMES) this._timeline.shift();
		this._timeline.push(entry);
	}

	getTimeline(): TimelineEntry[] { return [...this._timeline]; }

	getTimelineDiff(): { first: TimelineEntry | null; last: TimelineEntry | null; count: number } {
		return { first: this._timeline[0] ?? null, last: this._timeline[this._timeline.length - 1] ?? null, count: this._timeline.length };
	}

	hasActivePlan(): boolean { return this.planState !== null; }

	setupPlanPanel(goal: string, stepLabels: string[], ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		this._cleared = false;
		const sameGoal = this.planState?.goal === goal;
		if (!sameGoal) { this._sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); this._activeDelegations = 0; }
		const oldSteps = sameGoal ? (this.planState?.steps || []) : [];
		const prevStart = this.planState?.startTime;
		this.planState = {
			goal, sessionId: this._sessionId!,
			steps: stepLabels.map((label, i) => {
				const old = oldSteps.find(s => s.label === label);
				const wasCompleted = old?.completed === true;
				return { label, completed: wasCompleted, errored: false, active: !wasCompleted && i === 0, startTime: wasCompleted ? old.startTime : (!wasCompleted && i === 0 ? Date.now() : undefined), endTime: wasCompleted ? old.endTime : undefined };
			}),
			startTime: sameGoal && prevStart ? prevStart : Date.now(),
		};
		this._setWidget = ctx.ui.setWidget.bind(ctx.ui);
		this._lastWidgetContent = null;
		this.startPlanTimer();
		this._renderWidget();
		this.savePlanState();
	}

	clearPlanPanel(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		if (this._activeDelegations > 0 && this.planState?.sessionId === this._sessionId) return;
		const sessionId = this._sessionId;
		this._cleared = true;
		this._setWidget = null;
		this.dumpTimelineToDisk();
		this._sessionId = null;
		this.stopPlanTimer();
		this.planState = null;
		this._lastWidgetContent = null;
		if (sessionId) _removeSession(sessionId);
	}

	pushPlanStep(label: string): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const activeIdx = this.planState.steps.findIndex((s) => s.active);
		if (activeIdx >= 0 && !this.planState.steps[activeIdx].completed) {
			this.planState.steps[activeIdx].completed = true;
			this.planState.steps[activeIdx].active = false;
		}
		this.planState.steps.push({ label, completed: false, errored: false, active: true });
		this.planState.steps[this.planState.steps.length - 1].startTime = Date.now();
		resetSpinner();
		this._renderWidget();
	}

	startDelegationStep(label: string): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const activeIdx = this.planState.steps.findIndex((s) => s.active);
		if (activeIdx >= 0 && !this.planState.steps[activeIdx].completed) {
			this.planState.steps[activeIdx].label = label;
			this.planState.steps[activeIdx].active = true;
			if (!this.planState.steps[activeIdx].startTime) this.planState.steps[activeIdx].startTime = Date.now();
			resetSpinner();
			this._renderWidget();
			this.recordTimelineFrame("delegation_start");
			return;
		}
		const pendingIdx = this.planState.steps.findIndex((s) => !s.completed && !s.active && !s.errored);
		if (pendingIdx >= 0) {
			this.planState.steps[pendingIdx].label = label;
			this.planState.steps[pendingIdx].active = true;
			this.planState.steps[pendingIdx].startTime = Date.now();
			resetSpinner();
			this._renderWidget();
			this.recordTimelineFrame("delegation_start");
			return;
		}
		this.pushPlanStep(label);
		this._renderWidget();
		this.recordTimelineFrame("delegation_start");
	}

	updatePlanStepDetail(detail: string | string[]): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.active);
		if (idx >= 0) {
			if (Array.isArray(detail)) { this.planState.steps[idx].detailLines = detail.length > 0 ? detail : undefined; this.planState.steps[idx].detail = undefined; }
			else { this.planState.steps[idx].detail = detail || undefined; this.planState.steps[idx].detailLines = undefined; }
			this._renderWidget();
		}
	}

	completePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.active);
		if (idx >= 0) {
			const step = this.planState.steps[idx];
			if (step.detailLines?.length) (step as any).substepLines = step.detailLines.slice(-3);
			step.completed = true; step.errored = false; step.active = false; step.detail = undefined; step.detailLines = undefined; step.endTime = Date.now();
		}
		this._renderWidget(); this.savePlanState(); this.recordTimelineFrame("step_complete");
	}

	finalizePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		return this.completePlanStep(ctx);
	}

	clearPlanIfComplete(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId || !this.planState.steps.every(s => s.completed)) return;
		// Keep plan alive — do NOT call clearPlanPanel(). Just stop timer and re-render.
		this.stopPlanTimer();
		this.dumpTimelineToDisk();
		this._renderWidget();
	}

	errorPlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }, aborted?: boolean, errorMessage?: string): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.active);
		if (idx >= 0) {
			this.planState.steps[idx].errored = true;
			this.planState.steps[idx].errorMessage = errorMessage;
			this.planState.steps[idx].active = false;
			this.planState.steps[idx].detail = undefined;
			this.planState.steps[idx].endTime = Date.now();
		}
		this._renderWidget(); this.savePlanState(); this.recordTimelineFrame(aborted ? "step_aborted" : "step_error");
	}

	addSteps(newSteps: string[]): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		for (const label of newSteps) {
			if (!this.planState.steps.some(s => s.label === label)) {
				this.planState.steps.push({
					label,
					completed: false,
					errored: false,
					active: false,
					startTime: Date.now(),
				});
			}
		}
		this._renderWidget();
		this.savePlanState();
	}

	retryPlanStep(): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.errored);
		if (idx >= 0) {
			this.planState.steps[idx].errored = false;
			this.planState.steps[idx].errorMessage = undefined;
			this.planState.steps[idx].completed = false;
			this.planState.steps[idx].active = true;
			this.planState.steps[idx].detail = undefined;
			this.planState.steps[idx].detailLines = undefined;
			this.planState.steps[idx].startTime = Date.now();
			this.planState.steps[idx].endTime = undefined;
		}
		this._renderWidget();
	}

	renderPlanStatusText(): string {
		if (!this.planState) return "";
		const { goal, steps, startTime } = this.planState;
		const elapsed = Date.now() - startTime;
		const total = steps.length;
		const completed = steps.filter((s) => s.completed).length;
		const dots = steps.map((s) => (s.errored ? "✗" : s.completed ? "●" : "○")).join("");
		return `⚡ ${truncateLabel(goal, 120)} ${dots} [${completed}/${total}] ${formatDuration(elapsed)}`;
	}

	dumpTimelineToDisk(): void {
		if (this._timeline.length === 0) return;
		const id = this._sessionId ?? "unknown";
		const path = "/tmp/orchestrator-timeline-" + id + ".json";
		try {
			writeFileSync(path, JSON.stringify({ sessionId: id, recordedAt: Date.now(), totalFrames: this._timeline.length, events: this.getTimeline(), diff: this.getTimelineDiff() }, null, 2), "utf-8");
			debugLog("[timeline] " + this._timeline.length + " frames -> " + path);
		} catch (e) { debugLog("[timeline] failed to write: " + e); }
	}
}

export const _instances = new Map<string, PlanPanel>();
let _currentInstance: PlanPanel | null = null;

function _removeSession(sessionId: string): void {
	const panel = _instances.get(sessionId);
	if (panel) {
		panel.reset();
		_instances.delete(sessionId);
	}
	if (_currentInstance === panel) {
		_currentInstance = null;
	}
}

function _extractSessionId(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	if (!('sessionManager' in ctx)) return undefined;
	const sm = (ctx as { sessionManager?: unknown }).sessionManager;
	if (!sm || typeof sm !== 'object' || !('sessionId' in sm)) return undefined;
	const id = (sm as { sessionId?: string }).sessionId;
	return typeof id === 'string' ? id : undefined;
}

export function _resolveCtx(ctx: unknown): PlanPanel | null {
	const sessionId = _extractSessionId(ctx);
	if (sessionId) {
		return _instances.get(sessionId) ?? null;
	}
	return _currentInstance;
}

function _resolveOrCreate(ctx: unknown): PlanPanel {
	const sessionId = _extractSessionId(ctx);
	let panel: PlanPanel;
	if (sessionId && _instances.has(sessionId)) {
		panel = _instances.get(sessionId)!;
		// Guard: ensure old timers are stopped when reusing a session
		panel.reset();
	} else if (sessionId) {
		panel = new PlanPanel(ctx as { cwd?: string });
		_instances.set(sessionId, panel);
	} else {
		// No sessionId — use or create a default instance
		panel = _currentInstance ?? new PlanPanel(ctx as { cwd?: string });
	}
	_currentInstance = panel;
	return panel;
}

export const setupPlanPanel = (g: string, s: string[], c: unknown) => _resolveOrCreate(c).setupPlanPanel(g, s, c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const clearPlanPanel = (c: unknown) => _resolveCtx(c)?.clearPlanPanel(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const completePlanStep = (c: unknown) => _resolveCtx(c)?.completePlanStep(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const finalizePlanStep = (c: unknown) => _resolveCtx(c)?.finalizePlanStep(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const clearPlanIfComplete = (c: unknown) => _resolveCtx(c)?.clearPlanIfComplete(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const errorPlanStep = (c: unknown, a?: boolean, e?: string) => _resolveCtx(c)?.errorPlanStep(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } }, a, e);
export const incrementDelegationCount = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.incrementDelegationCount(); };
export const decrementDelegationCount = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.decrementDelegationCount(); };
export const summarizeGoal = (g: string, ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.summarizeGoal(g); };
export const generatePlanFromPrompt = (p: string, ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.generatePlanFromPrompt(p); };
export const inspectPlanState = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.inspectPlanState(); };
export const snapshotPlanRender = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.snapshotPlanRender(); };
export const recordTimelineFrame = (e: string, f?: Record<string, unknown> | null, r?: string, ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.recordTimelineFrame(e, f, r); };
export const getTimeline = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.getTimeline(); };
export const getTimelineDiff = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.getTimelineDiff(); };
export const hasActivePlan = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.hasActivePlan() ?? false; };
export const pushPlanStep = (l: string, ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.pushPlanStep(l); };
export const startDelegationStep = (l: string, ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.startDelegationStep(l); };
export const updatePlanStepDetail = (d: string | string[], ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.updatePlanStepDetail(d); };
export const addSteps = (s: string[], ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.addSteps(s); };
export const retryPlanStep = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.retryPlanStep(); };
export const renderPlanStatusText = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.renderPlanStatusText(); };
export const dumpTimelineToDisk = (ctx?: unknown) => { const panel = ctx ? _resolveCtx(ctx) : _currentInstance; return panel?.dumpTimelineToDisk(); };
