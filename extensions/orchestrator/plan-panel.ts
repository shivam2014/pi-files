import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { truncateLabel } from "../token-saver.ts";
import { styledSymbol, formatDuration as thFormatDuration, partialStrikethrough, HOLD_FRAMES, REVEAL_FRAMES, TOTAL_STRIKE_FRAMES } from "./orchestrator-theme.ts";
import type { PlanStep, StepKind, SessionContext, LoopUntilConfig, LoopUntilState, LoopIteration, LoopUntilStepInput } from "./types.ts";
import type { ActivityFeedState, Step, Substep } from "./types.ts";
import { renderActivityFeed } from "./activity-feed.ts";
import { SPINNER_INTERVAL_MS, resetSpinner } from "./spinner-state.ts";

import { debugLog } from "./debug.ts";
import { getSessionMode } from "./orchestrator-config";

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
 * This module exports a `resolvePlanPanel(ctx)` function and 23 proxy
 * functions that forward to a PlanPanel instance.  Every proxy requires a
 * `ctx` argument with a `sessionManager.sessionId`.  The PlanPanel instance
 * is looked up in a module-scoped `Map<string, PlanPanel>` keyed by sessionId.
 *
 * Six "lifecycle boundary" proxies use `_resolveOrCreate(ctx)` which creates
 * a new PlanPanel when none exists for the session:
 *   setupPlanPanel, clearPlanPanel, completePlanStep, finalizePlanStep,
 *   clearPlanIfComplete, errorPlanStep
 *
 * The remaining 17 proxies use `resolvePlanPanel(ctx)` for map lookup only
 * and silently no-op when no matching session is found.
 *
 * ## Lifecycle
 * PlanPanel instances live in a module-scoped `Map<string, PlanPanel>`
 * keyed by `sessionId`. They are created by `_resolveOrCreate(ctx)` and
 * cleaned up via `_removeSession(sessionId)` when a session ends.
 */

const MAX_TIMELINE_FRAMES = 500;
const WIDGET_KEY = "orchestrator-status";
const BUDGET = 9;

// Loop state is transient — not persisted to JSON
const _loopStates = new Map<string, LoopUntilState>(); // keyed by step label

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
		// Restore plan state from disk across conversation turns
		const restored = this.loadPlanState();
		if (restored) {
			this.planState = restored;
		}
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
				steps: this.planState.steps.map(s => ({ label: s.label, completed: s.completed, errored: s.errored, kind: s.kind })),
				startTime: this.planState.startTime,
				sessionId: this._sessionId,
			}, null, 2));
		} catch { /* silent */ }
	}

	private clearSavedPlanState(): void {
		try {
			const statePath = join(this._cwd, '.pi', 'orchestrator-plan.json');
			if (existsSync(statePath)) {
				writeFileSync(statePath, '{}', 'utf8');
			}
		} catch { /* silent */ }
	}

	/** Find the first pending (non-completed, non-errored, non-active) step and activate it. */
	private _activateNextPending(): void {
		if (!this.planState) return;
		const nextPending = this.planState.steps.find(s => !s.completed && !s.errored && !s.active);
		if (nextPending) {
			nextPending.active = true;
			if (!nextPending.startTime) nextPending.startTime = Date.now();
		}
	}

	private loadPlanState(): typeof this.planState {
		try {
			const statePath = join(this._cwd, '.pi', 'orchestrator-plan.json');
			if (!existsSync(statePath)) return null;
			const saved = JSON.parse(readFileSync(statePath, 'utf8'));
			if (!saved?.goal || !saved?.steps) return null;
			const steps = saved.steps.map((s: any) => ({ ...s, active: false }));
			// Infer kind for steps that lack it (backward compat with pre-#100 plans)

			for (const step of steps) {
				if (!step.kind) {
					const label = step.label.toLowerCase();
					if (label.includes('delegate') || label.includes('specialist')) {
						step.kind = 'delegation';
					} else if (label.includes('analyze') || label.includes('review') ||
						   label.includes('synthesize') || label.includes('decide') ||
						   label.includes('verify') || label.includes('research')) {
						step.kind = 'orchestrator';
					}
				}
			}
			return { goal: saved.goal, steps, startTime: saved.startTime || Date.now(), sessionId: this._sessionId ?? saved.sessionId ?? "unknown" };
		} catch { return null; }
	}

	summarizeGoal(goal: string): string {
		let cleaned = goal.replace(/https?:\/\/[^\s]+/g, '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '').trim();
		const firstLine = cleaned.split('\n')[0]?.trim() || cleaned;
		return firstLine.length <= 58 ? firstLine : firstLine.slice(0, 55) + '...';
	}

	generatePlanFromPrompt(_prompt: string): string[] { return ["Planning..."]; }

	private toFeedState(state: { goal: string; steps: PlanStep[]; startTime: number }): ActivityFeedState {
		const steps: Step[] = state.steps.map(ps => {
			// Loop step rendering — shows iteration progress
			if (ps.kind === 'loop_until' && ps.loopUntilState) {
				const loopState = ps.loopUntilState;
				const config = ps.loopUntil!;
				const progress = `[${loopState.currentIteration}/${config.maxIterations}]`;
				const mode = config.mode === 'satisficing' ? 'satisficing' : '';
				return {
					label: truncateLabel(`⟳ ${ps.label} ${progress} ${mode}`, 58),
					completed: ps.completed,
					startTime: ps.startTime,
					endTime: ps.endTime,
					substeps: loopState.iterations.slice(-3).map(i => ({
						label: `Iter ${i.index + 1}: ${i.status === 'pass' ? '✓' : i.status === 'fail' ? '✗' : '○'} ${i.summary}`,
						completed: i.status === 'pass',
					})),
				};
			}

			const substeps: Substep[] = [];
			if (ps.completed && ps.detailLines?.length) {
				for (const line of ps.detailLines) {
					if (line.startsWith("tokens:")) {
						substeps.push({ label: line, completed: false });
						continue;
					}
					const m = line.match(/^    ✓ Report: (.+)$/i);
					if (m) substeps.push({ label: `Report: ${m[1].trim()}`, completed: true });
				}
			}
			if (ps.active && ps.detailLines?.length) {
				for (const line of ps.detailLines) {
					if (line.startsWith("tokens:")) {
						substeps.push({ label: line, completed: false });
						continue;
					}
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
			return { label: truncateLabel(ps.label, 58), completed: ps.completed, startTime: ps.startTime, endTime: ps.endTime, substeps };
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

  // ── Strike animation state ──────────────────────────────────────
  private _strikeTimer: ReturnType<typeof setInterval> | null = null;
  private _strikeFrame = 0;
  private _strikeLabelText: string = "";
  private _strikeStepIdx: number = -1;

private selectCollapsedSteps(lines: string[], budget: number): string[] {
	if (lines.length <= budget) return lines;
	if (!this.planState) return lines;

	// Always preserve goal (line 0) + dots (line 1) — PAN-005 fix
	const goalLine = lines[0] ?? "";
	const dotsLine = lines[1] ?? "";
	const restLines = lines.slice(2);

	// ── Classify steps using planState data (robust vs ANSI regex) ──
	const steps = this.planState.steps;
	const completedCount = steps.filter(s => s.completed).length;
	const hasFold = completedCount > 0;

	// Map rendered lines to step groups by "Step N:" pattern
	const stepHeaderRe = /Step (\d+):/;
	const stepRanges: { start: number; end: number; stepIdx: number }[] = [];
	let currentStepIdx = -1;
	let currentStart = -1;

	for (let i = 0; i < restLines.length; i++) {
		const m = restLines[i].match(stepHeaderRe);
		if (m) {
			const stepNum = parseInt(m[1], 10) - 1;
			if (currentStepIdx >= 0) {
				stepRanges.push({ start: currentStart, end: i, stepIdx: currentStepIdx });
			}
			currentStepIdx = stepNum;
			currentStart = i;
		}
	}
	if (currentStepIdx >= 0) {
		stepRanges.push({ start: currentStart, end: restLines.length, stepIdx: currentStepIdx });
	}

	// Separate into active, pending, completed (using planState, not regex)
	const activeRanges: typeof stepRanges = [];
	const pendingRanges: typeof stepRanges = [];

	for (const range of stepRanges) {
		const step = steps[range.stepIdx];
		if (!step || step.completed) continue;
		if (step.active) {
			activeRanges.push(range);
		} else {
			pendingRanges.push(range);
		}
	}

	const totalOpen = activeRanges.length + pendingRanges.length;

	// ── Budget: goal(1) + dots(1) + fold(0/1) + steps + summary(0/1) ──
	const baseOverhead = 2 + (hasFold ? 1 : 0);
	let stepBudget = budget - baseOverhead - 1; // reserve 1 for potential summary
	if (stepBudget < 1) stepBudget = 1;

	// ── OMP selection policy: active first, then fill with pending ──
	const selectedRanges: typeof stepRanges = [];
	for (const range of activeRanges) {
		if (selectedRanges.length >= stepBudget) break;
		selectedRanges.push(range);
	}
	for (const range of pendingRanges) {
		if (selectedRanges.length >= stepBudget) break;
		selectedRanges.push(range);
	}

	// If all open steps fit, try adding one more (reserved slot freed)
	if (selectedRanges.length < totalOpen && selectedRanges.length < stepBudget + 1) {
		// hidden > 0 — summary needed, slot already reserved
	} else if (selectedRanges.length === totalOpen && selectedRanges.length < budget - baseOverhead) {
		// All open fit and room to spare — nothing more to add
	}

	const hiddenCount = totalOpen - selectedRanges.length;

	// ── Build output ──
	const result: string[] = [goalLine, dotsLine];
	if (hasFold) {
		result.push(`  ✓ ${completedCount} completed`);
	}

	// Include preamble (non-step lines between dots and first step, e.g. token line)
	const firstStepLine = stepRanges.length > 0 ? stepRanges[0].start : restLines.length;
	result.push(...restLines.slice(0, firstStepLine));

	// Selected step groups in original order
	selectedRanges.sort((a, b) => a.start - b.start);
	for (const range of selectedRanges) {
		result.push(...restLines.slice(range.start, range.end));
	}

	if (hiddenCount > 0) {
		result.push(`  … ${hiddenCount} more`);
	}

	return result;
}

	private renderPlanLines(): string[] {
		if (!this.planState) return [];
		return this.selectCollapsedSteps(renderActivityFeed("", this.toFeedState(this.planState)).split("\n"), BUDGET);
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

  /**
   * Start strikethrough reveal animation for a completed step.
   * One animation at a time — new completion replaces previous.
   * Uses 65ms setInterval, owns the timer lifecycle.
   */
  private _startStrikeAnimation(label: string, stepIdx: number): void {
    if (this._strikeTimer) {
      clearInterval(this._strikeTimer);
      this._strikeTimer = null;
    }
    this._strikeFrame = 0;
    this._strikeLabelText = label;
    this._strikeStepIdx = stepIdx;

    this._strikeTimer = setInterval(() => {
      this._strikeFrame++;
      if (this._strikeFrame > TOTAL_STRIKE_FRAMES) {
        if (this._strikeTimer) { clearInterval(this._strikeTimer); this._strikeTimer = null; }
        this._strikeStepIdx = -1;
        this._strikeLabelText = "";
        this._renderWidget();
        return;
      }
      this._renderWidget();
    }, 65);
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

	getPlanState(): { goal: string; steps: PlanStep[] } | null {
		return this.planState;
	}

	setupPlanPanel(goal: string, stepLabels: string[], ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		this._cleared = false;
		const mode = getSessionMode(ctx);
		const modePrefix = mode === "parallel" ? "⚡" : "🔄";
		const goalWithMode = `${modePrefix} ${goal}`;
		const sameGoal = this.planState?.goal === goalWithMode;
		if (!sameGoal) { this._sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); this._activeDelegations = 0; }
		const oldSteps = sameGoal ? (this.planState?.steps || []) : [];
		const prevStart = this.planState?.startTime;
		this.planState = {
			goal: goalWithMode, sessionId: this._sessionId!,
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
			this.planState.steps[activeIdx].active = true;
			this.planState.steps[activeIdx].kind = 'delegation';
			if (!this.planState.steps[activeIdx].startTime) this.planState.steps[activeIdx].startTime = Date.now();
			resetSpinner();
			this._renderWidget();
			this.recordTimelineFrame("delegation_start");
			return;
		}
		const pendingIdx = this.planState.steps.findIndex((s) => !s.completed && !s.active && !s.errored);
		if (pendingIdx >= 0) {
			this.planState.steps[pendingIdx].active = true;
			this.planState.steps[pendingIdx].kind = 'delegation';
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

	public advanceStep(): { status: 'completed'; label: string } | { status: 'skipped'; reason: string } | { status: 'error'; error: string } {
		if (!this.planState || this.planState.sessionId !== this._sessionId) {
			return { status: 'error', error: 'No active plan' };
		}
		const activeStep = this.planState.steps.find(s => s.active);
		if (!activeStep) {
			// Idempotent: if all steps are completed/errored, return success
			if (this.planState.steps.length > 0 && this.planState.steps.every(s => s.completed || s.errored)) {
				const lastCompleted = [...this.planState.steps].reverse().find(s => s.completed);
				return { status: 'completed', label: lastCompleted?.label ?? '' };
			}
			return { status: 'error', error: 'no active step' };
		}
		if (activeStep.kind === 'delegation') {
			return { status: 'skipped', reason: 'managed by delegate pipeline' };
		}
		activeStep.active = false;
		activeStep.completed = true;
		activeStep.endTime = Date.now();
		if (activeStep.detailLines?.length) (activeStep as any).substepLines = [...(activeStep.detailLines || [])];
		activeStep.detailLines = undefined;
		this._startStrikeAnimation(activeStep.label, this.planState.steps.indexOf(activeStep));
		this._activateNextPending();
		this._renderWidget();
		this.savePlanState();
		this.recordTimelineFrame("step_complete");
		return { status: 'completed', label: activeStep.label };
	}

	/** Public wrapper for the private _activateNextPending. */
	public activateNextPending(): void {
		this._activateNextPending();
	}

	completePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;
		const idx = this.planState.steps.findIndex((s) => s.active);
		if (idx >= 0) {
			const step = this.planState.steps[idx];
			if (step.detailLines?.length) (step as any).substepLines = step.detailLines.slice(-3);
			step.completed = true; step.errored = false; step.active = false; step.detail = undefined; step.detailLines = undefined; step.endTime = Date.now();
			this._activateNextPending();
		}
		this._renderWidget(); this.savePlanState(); this.recordTimelineFrame("step_complete");
	}

	finalizePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		return this.completePlanStep(ctx);
	}

	clearPlanIfComplete(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return;

		// Check if any step is an active loop — don't stop timers while loop iterates
		const hasActiveLoop = this.planState.steps.some(
			s => s.kind === 'loop_until' && !s.completed && s.loopUntilState?.status === 'running'
		);
		if (hasActiveLoop) {
			// Loop is still iterating — keep timers alive
			return;
		}

		if (!this.planState.steps.every(s => s.completed)) return;
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

	/**
	 * Validate loaded plan state against a session ID.
	 * If loaded state is from a different session, clears both in-memory and on-disk state.
	 */	public validateSessionForRestore(sessionId: string): void {
		if (this.planState && this.planState.sessionId !== sessionId) {
			this.planState = null;
			this.clearSavedPlanState();
		}
	}

	/**
	 * Insert steps into the plan. Supports two modes:
	 * - `after`: label-based insertion (find by label, insert after)
	 * - `index`: direct array insertion at that position (0 = beginning, steps.length = end)
	 * Exactly one of `after` or `index` must be provided.
	 */
	insertSteps(labels: string[], opts: { after?: string; index?: number }): { inserted: number; error?: string } {
		if (!this.planState || this.planState.sessionId !== this._sessionId) {
			return { inserted: 0, error: 'No active plan' };
		}
		if (opts.after && opts.index !== undefined) {
			return { inserted: 0, error: 'Cannot specify both "after" and "index" — use one or the other' };
		}
		if (!opts.after && opts.index === undefined) {
			return { inserted: 0, error: 'Must specify either "after" (label) or "index" (position)' };
		}

		let spliceIdx: number;
		if (opts.after !== undefined) {
			const afterIdx = this.planState.steps.findIndex(s => s.label === opts.after);
			if (afterIdx < 0) {
				return { inserted: 0, error: `Step '${opts.after}' not found in plan.` };
			}
			spliceIdx = afterIdx + 1;
		} else {
			// index-based: 0 = beginning, steps.length = end
			if (opts.index! < 0 || opts.index! > this.planState.steps.length) {
				return { inserted: 0, error: `Index ${opts.index} out of bounds [0–${this.planState.steps.length}]` };
			}
			spliceIdx = opts.index!;
		}

		let inserted = 0;
		for (const label of labels) {
			if (this.planState.steps.some(s => s.label === label)) continue;
			const newStep: PlanStep = {
				label,
				completed: false,
				errored: false,
				active: false,
				startTime: Date.now(),
			};
			this.planState.steps.splice(spliceIdx + inserted, 0, newStep);
			inserted++;
		}
		this._renderWidget();
		this.savePlanState();
		return { inserted };
	}

	addSteps(newSteps: string[]): { added: number; error?: string } {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return { added: 0, error: 'No active plan' };
		let count = 0;
		for (const label of newSteps) {
			if (!this.planState.steps.some(s => s.label === label)) {
				this.planState.steps.push({
					label,
					completed: false,
					errored: false,
					active: false,
					startTime: Date.now(),
				});
				count++;
			}
		}
		this._renderWidget();
		this.savePlanState();
		return { added: count };
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
		const dots = steps.map((s) => (s.errored ? styledSymbol("status.error") : s.completed ? styledSymbol("status.done") : styledSymbol("status.pending"))).join("");
		return `${styledSymbol("icon.plug")} ${truncateLabel(goal, 58)} ${dots} [${completed}/${total}] ${thFormatDuration(elapsed)}`;
	}

	modifyStep(index: number, label: string, kind?: StepKind): { success: boolean; error?: string } {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return { success: false, error: 'No active plan' };
		const idx = index - 1; // 1-based external → 0-based internal
		if (idx < 0 || idx >= this.planState.steps.length) return { success: false, error: `Index ${index} out of range (1–${this.planState.steps.length})` };
		this.planState.steps[idx].label = label;
		if (kind !== undefined) this.planState.steps[idx].kind = kind;
		this._renderWidget();
		return { success: true };
	}

	removeStep(index: number): { success: boolean; error?: string } {
		if (!this.planState || this.planState.sessionId !== this._sessionId) return { success: false, error: 'No active plan' };
		const idx = index - 1; // 1-based external → 0-based internal
		if (idx < 0 || idx >= this.planState.steps.length) return { success: false, error: `Index ${index} out of range (1–${this.planState.steps.length})` };
		if (this.planState.steps[idx].active) return { success: false, error: 'Cannot remove active step' };
		this.planState.steps.splice(idx, 1);
		// After removal, if no step is active, activate the next pending step
		if (this.planState.steps.length > 0 && !this.planState.steps.some(s => s.active)) {
			this._activateNextPending();
		}
		this._renderWidget();
		this.savePlanState();
		return { success: true };
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

	// ── Loop execution methods ──────────────────────────────────────────

	/** Initialize loop state for a loop_until step. */
	initLoopState(stepLabel: string, config: LoopUntilConfig): void {
		const state: LoopUntilState = {
			currentIteration: 0,
			consecutivePasses: 0,
			rollingSummary: '',
			status: 'running',
			iterations: [],
		};
		_loopStates.set(stepLabel, state);
		// Also store on step for rendering access
		const step = this.planState?.steps.find(s => s.label === stepLabel);
		if (step) {
			step.loopUntil = config;
			step.loopUntilState = state;
		}
		this._renderWidget();
	}

	/** Run one iteration of a loop step. Returns { done, reason }. */
	async runLoopIteration(stepLabel: string): Promise<{ done: boolean; reason?: string }> {
		const step = this.planState?.steps.find(s => s.label === stepLabel);
		if (!step || step.kind !== 'loop_until' || !step.loopUntil) {
			return { done: true, reason: 'Not a loop step' };
		}

		const state = _loopStates.get(stepLabel);
		if (!state) return { done: true, reason: 'No loop state' };

		const config = step.loopUntil;
		state.currentIteration++;
		state.status = 'running';

		// Build task from template
		const task = config.iterationTemplate.task
			.replace(/\{\{iteration\.N\}\}/g, String(state.currentIteration));

		// Add rolling summary to task if available
		const fullTask = state.rollingSummary
			? `${task}\n\n## Prior Iterations\n${state.rollingSummary}`
			: task;

		// Update plan panel detail
		this.updatePlanStepDetail(`Iteration ${state.currentIteration}/${config.maxIterations}: running...`);
		this._renderWidget();

		// Check max iterations
		if (state.currentIteration >= config.maxIterations) {
			state.status = 'max-reached';
			this.updatePlanStepDetail(`Max iterations (${config.maxIterations}) reached`);
			this._renderWidget();
			return { done: true, reason: 'max-reached' };
		}

		return { done: false };
	}

	/** Evaluate loop criterion against iteration result. */
	evaluateLoopCriterion(
		result: string,
		config: LoopUntilConfig,
		state: LoopUntilState
	): { pass: boolean; scores?: Record<string, number>; feedback?: string } {
		// For objective signals: check for success markers in output
		// For model-based: will be handled by orchestrator delegation
		const hasError = result.includes('[error]') || result.includes('❌');
		const hasSuccess = result.includes('✅') || result.includes('completed');

		return {
			pass: !hasError && hasSuccess,
			feedback: hasError ? 'Error detected in output' : undefined,
		};
	}

	/** Update rolling summary with new iteration data. */
	updateRollingSummary(
		state: LoopUntilState,
		iteration: LoopIteration
	): void {
		state.iterations.push(iteration);

		// Build structured facts
		const facts = state.iterations.map(i =>
			`- Iter ${i.index + 1}: ${i.status}${i.scores ? ` (${Object.values(i.scores).join('/')})` : ''} — ${i.summary}`
		).join('\n');

		// Keep narrative for last 2 iterations only
		const recent = state.iterations.slice(-2);
		const narrative = recent.map(i =>
			`Iteration ${i.index + 1}: ${i.summary}`
		).join('\n');

		// Compose rolling summary
		if (state.iterations.length > 10) {
			// Facts only for long loops
			state.rollingSummary = `## Iteration Facts\n${facts}`;
		} else {
			state.rollingSummary = `## Iteration Facts\n${facts}\n\n## Recent Context\n${narrative}`;
		}

		// Sync back to plan step for rendering
		// (state is a reference held by the step)
		this._renderWidget();
	}

	/** Detect if loop has stalled (no improvement in recent window). */
	detectStall(state: LoopUntilState, window: number = 3): { stalled: boolean; reason?: string } {
		if (state.iterations.length < window) return { stalled: false };

		const recent = state.iterations.slice(-window);
		const allFailed = recent.every(i => i.status === 'fail' || i.status === 'error');

		if (allFailed) {
			return {
				stalled: true,
				reason: `No improvement in last ${window} iterations`,
			};
		}

		return { stalled: false };
	}

	/** Compose human-readable feedback for an iteration evaluation. */
	composeFeedback(
		config: LoopUntilConfig,
		evaluation: { pass: boolean; scores?: Record<string, number>; feedback?: string },
		state: LoopUntilState
	): string {
		const parts: string[] = [];

		if (evaluation.pass) {
			parts.push('✅ Criterion met!');
		} else {
			parts.push('❌ Criterion not met.');

			if (evaluation.feedback) {
				parts.push(`\nFeedback: ${evaluation.feedback}`);
			}

			if (evaluation.scores) {
				const passing = Object.entries(evaluation.scores).filter(([_, v]) => v >= 8);
				const failing = Object.entries(evaluation.scores).filter(([_, v]) => v < 8);

				if (passing.length > 0) {
					parts.push(`\nWhat passed: ${passing.map(([k, v]) => `${k} (${v})`).join(', ')}`);
				}
				if (failing.length > 0) {
					parts.push(`\nWhat needs work: ${failing.map(([k, v]) => `${k} (${v})`).join(', ')}`);
				}
			}
		}

		return parts.join('\n');
	}

	/** Mark loop step as completed with final status. */
	completeLoopStep(stepLabel: string, finalStatus: LoopUntilState['status']): void {
		const state = _loopStates.get(stepLabel);
		if (state) {
			state.status = finalStatus;
		}
		const step = this.planState?.steps.find(s => s.label === stepLabel);
		if (step) {
			step.completed = true;
			step.active = false;
			step.endTime = Date.now();
		}
		this._activateNextPending();
		this._renderWidget();
		this.savePlanState();
		this.recordTimelineFrame('loop_complete');
	}

	/** Get the module-level loop state map (for orchestrator access). */
	static getLoopStates(): Map<string, LoopUntilState> {
		return _loopStates;
	}
}

export const _instances = new Map<string, PlanPanel>();

export function resolvePlanPanel(ctx: unknown): PlanPanel | null {
	const sessionId = _extractSessionId(ctx);
	if (sessionId) {
		return _instances.get(sessionId) ?? null;
	}
	return null;
}

function _removeSession(sessionId: string): void {
	const panel = _instances.get(sessionId);
	if (panel) {
		panel.reset();
		_instances.delete(sessionId);
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
	return resolvePlanPanel(ctx);
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
		// Error recovery: if loaded state is from a different session, clear it
		panel.validateSessionForRestore(sessionId);
	} else {
		// No sessionId — generate synthetic key for test/standalone isolation
		const anonId = "__anon__" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		panel = new PlanPanel(ctx as { cwd?: string });
		_instances.set(anonId, panel);
	}
	return panel;
}

export const setupPlanPanel = (g: string, s: string[], c: unknown) => _resolveOrCreate(c).setupPlanPanel(g, s, c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const clearPlanPanel = (c: unknown) => resolvePlanPanel(c)?.clearPlanPanel(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const completePlanStep = (c: unknown) => resolvePlanPanel(c)?.completePlanStep(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const finalizePlanStep = (c: unknown) => resolvePlanPanel(c)?.finalizePlanStep(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const clearPlanIfComplete = (c: unknown) => resolvePlanPanel(c)?.clearPlanIfComplete(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } });
export const errorPlanStep = (c: unknown, a?: boolean, e?: string) => resolvePlanPanel(c)?.errorPlanStep(c as { ui: { setWidget: (key: string, content: string[] | undefined) => void } }, a, e);
export const incrementDelegationCount = (ctx: unknown) => resolvePlanPanel(ctx)?.incrementDelegationCount();
export const decrementDelegationCount = (ctx: unknown) => resolvePlanPanel(ctx)?.decrementDelegationCount();
export const summarizeGoal = (g: string, ctx: unknown) => resolvePlanPanel(ctx)?.summarizeGoal(g);
export const generatePlanFromPrompt = (p: string, ctx: unknown) => resolvePlanPanel(ctx)?.generatePlanFromPrompt(p);
export const inspectPlanState = (ctx: unknown) => resolvePlanPanel(ctx)?.inspectPlanState();
export const snapshotPlanRender = (ctx: unknown) => resolvePlanPanel(ctx)?.snapshotPlanRender();
export const recordTimelineFrame = (e: string, f?: Record<string, unknown> | null, r?: string, ctx?: unknown) => resolvePlanPanel(ctx)?.recordTimelineFrame(e, f, r);
export const getTimeline = (ctx: unknown) => resolvePlanPanel(ctx)?.getTimeline();
export const getTimelineDiff = (ctx: unknown) => resolvePlanPanel(ctx)?.getTimelineDiff();
export const hasActivePlan = (ctx: unknown) => resolvePlanPanel(ctx)?.hasActivePlan() ?? false;
export const getPlanState = (ctx: unknown) => resolvePlanPanel(ctx)?.getPlanState();
export const pushPlanStep = (l: string, ctx: unknown) => resolvePlanPanel(ctx)?.pushPlanStep(l);
export const startDelegationStep = (l: string, ctx: unknown) => resolvePlanPanel(ctx)?.startDelegationStep(l);
export const updatePlanStepDetail = (d: string | string[], ctx: unknown) => resolvePlanPanel(ctx)?.updatePlanStepDetail(d);
export const addSteps = (s: string[], ctx: unknown) => resolvePlanPanel(ctx)?.addSteps(s);
export const retryPlanStep = (ctx: unknown) => resolvePlanPanel(ctx)?.retryPlanStep();
export const renderPlanStatusText = (ctx: unknown) => resolvePlanPanel(ctx)?.renderPlanStatusText();
export const dumpTimelineToDisk = (ctx: unknown) => resolvePlanPanel(ctx)?.dumpTimelineToDisk();

export function insertSteps(labels: string[], opts: { after?: string; index?: number }, ctx?: unknown): { inserted: number; error?: string } {
	const panel = resolvePlanPanel(ctx);
	return panel ? panel.insertSteps(labels, opts) : { inserted: 0, error: 'No active plan' };
}

export function modifyStep(index: number, label: string, kind?: StepKind, ctx?: unknown) {
	const panel = resolvePlanPanel(ctx);
	return panel ? panel.modifyStep(index, label, kind) : { success: false, error: 'No active plan' };
}

export function removeStep(index: number, ctx?: unknown) {
	const panel = resolvePlanPanel(ctx);
	return panel ? panel.removeStep(index) : { success: false, error: 'No active plan' };
}

// ── Loop execution proxies ──────────────────────────────────────────────

export function initLoopState(stepLabel: string, config: LoopUntilConfig, ctx: unknown): void {
	resolvePlanPanel(ctx)?.initLoopState(stepLabel, config);
}

export async function runLoopIteration(stepLabel: string, ctx: unknown): Promise<{ done: boolean; reason?: string }> {
	const panel = resolvePlanPanel(ctx);
	if (!panel) return { done: true, reason: 'No active plan' };
	return panel.runLoopIteration(stepLabel);
}

export function evaluateLoopCriterion(
	result: string,
	config: LoopUntilConfig,
	state: LoopUntilState,
	_ctx?: unknown
): { pass: boolean; scores?: Record<string, number>; feedback?: string } {
	const panel = _ctx ? resolvePlanPanel(_ctx) : null;
	return panel?.evaluateLoopCriterion(result, config, state) ?? { pass: false, feedback: 'No plan panel' };
}

export function updateRollingSummary(state: LoopUntilState, iteration: LoopIteration, ctx?: unknown): void {
	const panel = ctx ? resolvePlanPanel(ctx) : null;
	panel?.updateRollingSummary(state, iteration);
}

export function detectStall(state: LoopUntilState, window?: number, _ctx?: unknown): { stalled: boolean; reason?: string } {
	const panel = _ctx ? resolvePlanPanel(_ctx) : null;
	return panel?.detectStall(state, window) ?? { stalled: false };
}

export function composeFeedback(
	config: LoopUntilConfig,
	evaluation: { pass: boolean; scores?: Record<string, number>; feedback?: string },
	state: LoopUntilState,
	_ctx?: unknown
): string {
	const panel = _ctx ? resolvePlanPanel(_ctx) : null;
	return panel?.composeFeedback(config, evaluation, state) ?? '';
}

export function completeLoopStep(stepLabel: string, finalStatus: LoopUntilState['status'], ctx: unknown): void {
	resolvePlanPanel(ctx)?.completeLoopStep(stepLabel, finalStatus);
}
