import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { truncateLabel } from "../token-saver.ts";
import { formatDuration } from "./ui-utils.ts";
import type { PlanStep } from "./types.ts";
import type { ActivityFeedState, Step, Substep } from "./types.ts";
import { renderActivityFeed } from "./activity-feed.ts";
import { advanceSpinner, resetSpinner } from "./spinner-state.ts";

export interface TimelineEntry {
	t: number;
	event: string;
	render: string;
	state: Record<string, unknown> | null;
	feedState?: Record<string, unknown> | null;
	feedRender?: string;
}

const MAX_TIMELINE_FRAMES = 500;
const WIDGET_KEY = "orchestrator-status";
const BUDGET = 9;
const TIMER_KEY = "__orchestrator_plan_timers__";

export class PlanPanel {
	private _timeline: TimelineEntry[] = [];
	private _timelineStart: number = Date.now();
	private _sessionId: string | null = null;
	private _activeDelegations: number = 0;
	private planState: { goal: string; steps: PlanStep[]; startTime: number; sessionId: string } | null = null;
	private _setWidget: ((key: string, content: string[] | undefined) => void) | null = null;
	private _lastWidgetContent: string[] | null = null;

	incrementDelegationCount(): void { this._activeDelegations++; }
	decrementDelegationCount(): void { this._activeDelegations = Math.max(0, this._activeDelegations - 1); }

	private _reg(): { planTimer: ReturnType<typeof setInterval> | null; spinnerTimer: ReturnType<typeof setInterval> | null } {
		return ((globalThis as any)[TIMER_KEY] ??= { planTimer: null, spinnerTimer: null });
	}

	private savePlanState(): void {
		if (!this.planState) return;
		try {
			const dir = join(process.cwd(), '.pi');
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
			const statePath = join(process.cwd(), '.pi', 'orchestrator-plan.json');
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
				}
			}
			return { label: truncateLabel(ps.label, 120), completed: ps.completed, startTime: ps.startTime, endTime: ps.endTime, substeps };
		});
		return { goal: state.goal, steps, currentStep: state.steps.findIndex(s => s.active), rawText: "", planParsed: false };
	}

	private trimToBudget(lines: string[], budget: number): string[] {
		if (lines.length <= budget) return lines;
		const keepIndices = new Set<number>([0]);
		if (lines.length > 1) keepIndices.add(1);
		let activeIdx = -1;
		for (let i = 2; i < lines.length; i++) { if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(lines[i].trimStart())) { activeIdx = i; break; } }
		if (activeIdx >= 0) { for (let i = activeIdx; i < lines.length; i++) keepIndices.add(i); }
		const result: string[] = [];
		let remaining = budget - (lines.length - (activeIdx >= 0 ? activeIdx : lines.length));
		if (activeIdx >= 0) {
			for (let i = 0; i < activeIdx && remaining > 0; i++) { result.push(lines[i]); remaining--; }
			for (let i = activeIdx; i < lines.length; i++) result.push(lines[i]);
		} else { for (let i = lines.length - budget; i < lines.length; i++) result.push(lines[i]); }
		return result.slice(-budget);
	}

	private renderPlanLines(): string[] {
		if (!this.planState) return [];
		return this.trimToBudget(renderActivityFeed("", this.toFeedState(this.planState)).split("\n"), BUDGET);
	}

	private _renderWidget(): void {
		if (!this._setWidget) return;
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
		const r = this._reg();
		const self = this;
		r.spinnerTimer = setInterval(() => {
			if (self._reg().spinnerTimer !== r.spinnerTimer) { clearInterval(r.spinnerTimer!); return; }
			if (self.planState) { advanceSpinner(); self._renderWidget(); } else { self.stopPlanTimer(); }
		}, 80);
		r.planTimer = setInterval(() => {
			if (self._reg().planTimer !== r.planTimer) { clearInterval(r.planTimer!); return; }
			if (self.planState) { self._renderWidget(); } else { self.stopPlanTimer(); }
		}, 1000);
	}

	private stopPlanTimer(): void {
		const r = this._reg();
		if (r.planTimer !== null) { clearInterval(r.planTimer); r.planTimer = null; }
		if (r.spinnerTimer !== null) { clearInterval(r.spinnerTimer); r.spinnerTimer = null; }
	}

	inspectPlanState(): Record<string, unknown> | null {
		if (!this.planState) return null;
		const steps = this.planState.steps.map((s, i) => ({
			index: i, label: s.label,
			state: s.completed ? "completed" : s.errored ? "errored" : s.active ? "active" : "pending",
			substepCount: (s as any).detailLines?.length ?? 0, detail: s.detail ?? null,
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
		this.dumpTimelineToDisk();
		this._sessionId = null;
		this.stopPlanTimer();
		this.planState = null;
		this._lastWidgetContent = null;
		if (this._setWidget) this._setWidget(WIDGET_KEY, undefined);
		this._setWidget = null;
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
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.active);
		if (idx >= 0) {
			const step = this.planState.steps[idx];
			if (step.detailLines?.length) (step as any).substepLines = step.detailLines.slice(-3);
			step.completed = true; step.errored = false; step.active = false; step.detail = undefined; step.detailLines = undefined; step.endTime = Date.now();
		}
		this._renderWidget(); this.savePlanState(); this.recordTimelineFrame("step_complete");
	}

	clearPlanIfComplete(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		if (!this.planState || !this.planState.steps.every(s => s.completed)) return;
		this.clearPlanPanel(ctx);
	}

	errorPlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }, aborted?: boolean): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.active);
		if (idx >= 0) {
			this.planState.steps[idx].errored = !aborted;
			this.planState.steps[idx].active = false;
			this.planState.steps[idx].detail = undefined;
			this.planState.steps[idx].endTime = Date.now();
		}
		this._renderWidget(); this.savePlanState(); this.recordTimelineFrame(aborted ? "step_aborted" : "step_error");
	}

	retryPlanStep(): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.errored);
		if (idx >= 0) {
			this.planState.steps[idx].errored = false;
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
			console.error("[timeline] " + this._timeline.length + " frames -> " + path);
		} catch (e) { console.error("[timeline] failed to write: " + e); }
	}
}

const _instance = new PlanPanel();
export const incrementDelegationCount = () => _instance.incrementDelegationCount();
export const decrementDelegationCount = () => _instance.decrementDelegationCount();
export const summarizeGoal = (g: string) => _instance.summarizeGoal(g);
export const generatePlanFromPrompt = (p: string) => _instance.generatePlanFromPrompt(p);
export const inspectPlanState = () => _instance.inspectPlanState();
export const snapshotPlanRender = () => _instance.snapshotPlanRender();
export const recordTimelineFrame = (e: string, f?: Record<string, unknown> | null, r?: string) => _instance.recordTimelineFrame(e, f, r);
export const getTimeline = () => _instance.getTimeline();
export const getTimelineDiff = () => _instance.getTimelineDiff();
export const hasActivePlan = () => _instance.hasActivePlan();
export const clearPlanPanel = (c: { ui: { setWidget: (k: string, v: string[] | undefined) => void } }) => _instance.clearPlanPanel(c);
export const pushPlanStep = (l: string) => _instance.pushPlanStep(l);
export const startDelegationStep = (l: string) => _instance.startDelegationStep(l);
export const updatePlanStepDetail = (d: string | string[]) => _instance.updatePlanStepDetail(d);
export const setupPlanPanel = (g: string, s: string[], c: { ui: { setWidget: (k: string, v: string[] | undefined) => void } }) => _instance.setupPlanPanel(g, s, c);
export const completePlanStep = (c: { ui: { setWidget: (k: string, v: string[] | undefined) => void } }) => _instance.completePlanStep(c);
export const finalizePlanStep = (c: { ui: { setWidget: (k: string, v: string[] | undefined) => void } }) => _instance.finalizePlanStep(c);
export const clearPlanIfComplete = (c: { ui: { setWidget: (k: string, v: string[] | undefined) => void } }) => _instance.clearPlanIfComplete(c);
export const errorPlanStep = (c: { ui: { setWidget: (k: string, v: string[] | undefined) => void } }, a?: boolean) => _instance.errorPlanStep(c, a);
export const retryPlanStep = () => _instance.retryPlanStep();
export const renderPlanStatusText = () => _instance.renderPlanStatusText();
export const dumpTimelineToDisk = () => _instance.dumpTimelineToDisk();
