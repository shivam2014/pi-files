/**
 * Plan panel — Orchestration Plan status widget (Layer 1).
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 1: Orchestration Plan
 *
 * Uses ctx.ui.setWidget() for compact display — flat text, no box borders.
 * Widget sits above editor, doesn't consume chat scroll space.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { truncateLabel } from "../token-saver.ts";
import { formatDuration } from "./ui-utils.ts";
import type { PlanStep } from "./types.ts";
import type { ActivityFeedState, Step, Substep } from "./types.ts";
import { renderActivityFeed } from "./activity-feed.ts";
import { SPINNER_FRAMES, getSpinnerIndex, resetSpinner, advanceSpinner } from "./spinner-state.ts";

// ============================================================================
// Timeline types and buffer (Layer 3)
// ============================================================================

export interface TimelineEntry {
    t: number;
    event: string;
    render: string;
    state: Record<string, unknown> | null;
    feedState?: Record<string, unknown> | null;
    feedRender?: string;
}

const _timeline: TimelineEntry[] = [];
const _timelineStart = Date.now();
let _sessionId: string | null = null;
const MAX_TIMELINE_FRAMES = 500;

// ============================================================================
// Constants
// ============================================================================

/** Widget key used for setWidget calls */
const WIDGET_KEY = "orchestrator-status";

/** Delegation counter — prevents clearPlanPanel() from wiping state mid-delegation */
let _activeDelegations = 0;

export function incrementDelegationCount(): void { _activeDelegations++; }
export function decrementDelegationCount(): void { _activeDelegations = Math.max(0, _activeDelegations - 1); }

/** Widget hard-cap: 9 lines of content */
const BUDGET = 9;

let planState: {
	goal: string;
	steps: PlanStep[];
	startTime: number;
	sessionId: string;
} | null = null;

function savePlanState(): void {
	if (!planState) return;
	try {
		const dir = join(process.cwd(), '.pi');
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'orchestrator-plan.json'), JSON.stringify({
			goal: planState.goal,
			steps: planState.steps.map(s => ({ label: s.label, completed: s.completed, errored: s.errored })),
			startTime: planState.startTime,
		}, null, 2));
	} catch {}
}

function loadPlanState(): typeof planState {
	try {
		const statePath = join(process.cwd(), '.pi', 'orchestrator-plan.json');
		if (!existsSync(statePath)) return null;
		const saved = JSON.parse(readFileSync(statePath, 'utf8'));
		if (!saved?.goal || !saved?.steps) return null;
		return {
			goal: saved.goal,
			steps: saved.steps.map((s: any) => ({ ...s, active: false })),
			startTime: saved.startTime || Date.now(),
		sessionId: _sessionId ?? saved.sessionId ?? "unknown",
		};
	} catch { return null; }
}

// Global registry survives jiti hot reload — prevents orphaned timer closures
const __T = "__orchestrator_plan_timers__";
function _reg(): { planTimer: ReturnType<typeof setInterval> | null; spinnerTimer: ReturnType<typeof setInterval> | null } {
	return ((globalThis as any)[__T] ??= { planTimer: null, spinnerTimer: null });
}

/** Stored reference to ctx.ui.setWidget for timer-based updates */
let _setWidget: ((key: string, content: string[] | undefined) => void) | null = null;

/** Cache of last widget content — skip redundant setWidget calls */
let _lastWidgetContent: string[] | null = null;

// ============================================================================
// Widget content generation
// ============================================================================

function toFeedState(planState: { goal: string; steps: PlanStep[]; startTime: number }): ActivityFeedState {
	const steps: Step[] = planState.steps.map(ps => {
		let substeps: Substep[] = [];

		if (ps.completed && ps.detailLines?.length) {
			// Completed step: only show report findings
			for (const line of ps.detailLines) {
				const reportMatch = line.match(/^    ✓ Report: (.+)$/i);
				if (reportMatch) {
					substeps.push({ label: `Report: ${reportMatch[1].trim()}`, completed: true });
				}
			}
		}

		if (ps.active && ps.detailLines?.length) {
			for (const line of ps.detailLines) {
				// Report findings show as completed substeps
				const reportMatch = line.match(/^    ✓ Report: (.+)$/i);
				if (reportMatch) {
					substeps.push({ label: `Report: ${reportMatch[1].trim()}`, completed: true });
					continue;
				}
				// Other completed tool calls
				const doneMatch = line.match(/^    ✓ (.+)$/);
				if (doneMatch) {
					substeps.push({ label: doneMatch[1].trim(), completed: true });
					continue;
				}
				// Current active tool call (first spinner line)
				const spinnerMatch = line.match(/^    [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (.+)$/);
				if (spinnerMatch) {
					if (!substeps.find(s => !s.completed)) {
						substeps.push({ label: spinnerMatch[1].trim(), completed: false });
					}
				}
			}
		}

		return {
			label: truncateLabel(ps.label, 120),
			completed: ps.completed,
			startTime: ps.startTime,
			endTime: ps.endTime,
			substeps,
		};
	});
	return {
		goal: planState.goal,
		steps,
		currentStep: planState.steps.findIndex(s => s.active),
		rawText: "",
		planParsed: false,
	};
}

function trimToBudget(lines: string[], budget: number): string[] {
	if (lines.length <= budget) return lines;

	// Always keep: goal line (◆), progress dots (●○○), and active step (has spinner)
	// Trim oldest completed step headers from top
	const keepIndices = new Set<number>();

	// Goal line is always line 0
	keepIndices.add(0);
	// Progress dots is always line 1
	if (lines.length > 1) keepIndices.add(1);

	// Find active step (has a spinner character)
	let activeIdx = -1;
	for (let i = 2; i < lines.length; i++) {
		const trimmed = lines[i].trimStart();
		if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(trimmed)) {
			activeIdx = i;
			break;
		}
	}

	// Always keep active step and everything after it
	if (activeIdx >= 0) {
		for (let i = activeIdx; i < lines.length; i++) {
			keepIndices.add(i);
		}
	}

	// We have keepIndices + everything before activeIdx that fits budget
	// Strategy: trim oldest rows from top before activeIdx
	const result: string[] = [];
	let remaining = budget - (lines.length - (activeIdx >= 0 ? activeIdx : lines.length));

	if (activeIdx >= 0) {
		// Keep goal, dots, then whatever fits before active step
		for (let i = 0; i < activeIdx && remaining > 0; i++) {
			result.push(lines[i]);
			remaining--;
		}
		// Then add active step and everything after it
		for (let i = activeIdx; i < lines.length; i++) {
			result.push(lines[i]);
		}
	} else {
		// No active step found — just trim from top
		for (let i = lines.length - budget; i < lines.length; i++) {
			result.push(lines[i]);
		}
	}

	return result.slice(-budget);
}

/**
 * Render plan panel as a compact string array (no box borders).
 * Each element is one line of the widget.
 */
function renderPlanLines(): string[] {
	if (!planState) return [];
	const feed = toFeedState(planState);
	const full = renderActivityFeed("", feed).split("\n");
	return trimToBudget(full, BUDGET);
}

/**
 * Push content to widget, skipping if identical to last push.
 * This prevents unnecessary TUI re-layouts when nothing meaningful changed
 * (e.g. only the spinner frame or elapsed second changed).
 */
function _renderWidget(): void {
	if (!_setWidget) return;
	const lines = renderPlanLines();
	// Compare with cache — skip if nothing changed
	if (_lastWidgetContent && _lastWidgetContent.length === lines.length) {
		let same = true;
		for (let i = 0; i < lines.length; i++) {
			if (_lastWidgetContent[i] !== lines[i]) { same = false; break; }
		}
		if (same) return;
	}
	_lastWidgetContent = lines;
	_setWidget(WIDGET_KEY, lines);
}

// ============================================================================
// Timer management
// ============================================================================

function startPlanTimer(): void {
	stopPlanTimer();
	const r = _reg();

	// Fast spinner timer — smooth animation at 80ms
	r.spinnerTimer = setInterval(() => {
		// Self-check: if this interval ID doesn't match the registry,
		// we're a stale interval from an old module — kill self.
		if (_reg().spinnerTimer !== r.spinnerTimer) {
			clearInterval(r.spinnerTimer!);
			return;
		}
		if (planState) {
			advanceSpinner();
			_renderWidget();
		} else {
			stopPlanTimer();
		}
	}, 80);

	// Slow elapsed timer — update display once per second
	r.planTimer = setInterval(() => {
		// Self-check: if this interval ID doesn't match the registry,
		// we're a stale interval from an old module — kill self.
		if (_reg().planTimer !== r.planTimer) {
			clearInterval(r.planTimer!);
			return;
		}
		if (planState) {
			_renderWidget();
		} else {
			stopPlanTimer();
		}
	}, 1000);
}

function stopPlanTimer(): void {
	const r = _reg();
	if (r.planTimer !== null) {
		clearInterval(r.planTimer);
		r.planTimer = null;
	}
	if (r.spinnerTimer !== null) {
		clearInterval(r.spinnerTimer);
		r.spinnerTimer = null;
	}
}

// ============================================================================
// Goal summarization — better plan titles from user prompts
// ============================================================================

export function summarizeGoal(goal: string): string {
    let cleaned = goal.replace(/https?:\/\/[^\s]+/g, '');
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
    cleaned = cleaned.replace(/`[^`]+`/g, '');
    cleaned = cleaned.trim();
    const firstLine = cleaned.split('\n')[0]?.trim() || cleaned;
    const maxLen = 120;
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.slice(0, maxLen - 3) + '...';
}

// ============================================================================
// Plan generation — create initial steps from user prompt
// ============================================================================

/**
 * Generate initial plan steps from the user's prompt.
 * Start with just "Planning" — real steps added dynamically by orchestrator
 * via startDelegationStep() as delegations arrive.
 */
export function generatePlanFromPrompt(prompt: string): string[] {
	// Start with just "Planning..." — real steps added dynamically by orchestrator
	return ["Planning..."];
}

// ============================================================================
// Public API
// ============================================================================

// ============================================================================
// Layer 1: State Inspector
// ============================================================================

export function inspectPlanState(): Record<string, unknown> | null {
    if (!planState) return null;
    const steps = planState.steps.map((s, i) => ({
        index: i,
        label: s.label,
        state: s.completed ? "completed" : s.errored ? "errored" : s.active ? "active" : "pending",
        substepCount: (s as any).detailLines?.length ?? 0,
        detail: s.detail ?? null,
    }));
    return {
        goal: planState.goal,
        steps,
        completedCount: planState.steps.filter(s => s.completed).length,
        totalCount: planState.steps.length,
        activeDelegations: _activeDelegations,
        elapsedMs: Date.now() - planState.startTime,
    };
}

// ============================================================================
// Layer 2: Render Snapshot
// ============================================================================

export function snapshotPlanRender(): string {
    if (!_lastWidgetContent) return "";
    return _lastWidgetContent.join("\n");
}

// ============================================================================
// Layer 3: Timeline Recorder
// ============================================================================

export function recordTimelineFrame(
    event: string,
    feedState?: Record<string, unknown> | null,
    feedRender?: string,
): void {
    const entry = {
        t: Date.now() - _timelineStart,
        event,
        render: snapshotPlanRender(),
        state: inspectPlanState(),
        ...(feedState !== undefined ? { feedState } : {}),
        ...(feedRender !== undefined ? { feedRender } : {}),
    };

    // Dedup: skip if last frame has same event + identical logical state
    const last = _timeline[_timeline.length - 1];
    if (last && last.event === entry.event) {
        // Compare state ignoring time-variant fields (elapsedMs, t)
        const stripTime = (s: Record<string, unknown> | null) => {
            if (!s) return null;
            const { elapsedMs, ...rest } = s as any;
            // Also strip the substep detail which changes per-tool
            return rest;
        };
        const stateSame = JSON.stringify(stripTime(last.state)) === JSON.stringify(stripTime(entry.state));
        const feedSame = JSON.stringify(last.feedState ?? null) === JSON.stringify(entry.feedState ?? null);
        if (stateSame && feedSame) return;
    }

    if (_timeline.length >= MAX_TIMELINE_FRAMES) _timeline.shift();
    _timeline.push(entry);
}

export function getTimeline(): TimelineEntry[] {
	return [..._timeline];
}

export function getTimelineDiff(): { first: TimelineEntry | null; last: TimelineEntry | null; count: number } {
	return {
		first: _timeline.length > 0 ? _timeline[0] : null,
		last: _timeline.length > 0 ? _timeline[_timeline.length - 1] : null,
		count: _timeline.length,
	};
}

export function hasActivePlan(): boolean {
	return planState !== null;
}

export function clearPlanPanel(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (_activeDelegations > 0 && planState?.sessionId === _sessionId) return;
	dumpTimelineToDisk();
	_sessionId = null;
	stopPlanTimer();
	planState = null;
	_lastWidgetContent = null;
	if (_setWidget) {
		_setWidget(WIDGET_KEY, undefined);
	}
	_setWidget = null;
}

/**
 * Push a new step onto the active plan and make it the current step.
 * Marks the previously active step as completed if it wasn't already.
 * This allows the widget to show multi-step progress across sequential delegations.
 */
export function pushPlanStep(label: string): void {
	if (!planState || planState.sessionId !== _sessionId) return;

	// Mark current active step as completed if it exists and isn't already done
	const activeIdx = planState.steps.findIndex((s) => s.active);
	if (activeIdx >= 0 && !planState.steps[activeIdx].completed) {
		planState.steps[activeIdx].completed = true;
		planState.steps[activeIdx].active = false;
	}

	planState.steps.push({
		label,
		completed: false,
		errored: false,
		active: true,
	});

	// Set startTime on the new step
	const newStep = planState.steps[planState.steps.length - 1];
	newStep.startTime = Date.now();

	resetSpinner();
	_renderWidget();
}

/**
 * Activate a step for a delegation, consuming pre-planned steps in order.
 *
 * - If a pre-planned step is already active and not yet completed, re-label it
 *   with the actual delegation info (e.g. "Investigate" → "Scout: investigate auth").
 * - If the current step was completed and more pre-planned steps remain, activate
 *   the next pending step and re-label it.
 * - If all pre-planned steps are consumed, append a new step dynamically.
 *
 * This gives the user a full picture: what was done (✓), what's running (⠋),
 * and what's coming next (○).
 */
export function startDelegationStep(label: string): void {
	if (!planState || planState.sessionId !== _sessionId) return;

	// Case 1: Active step exists and isn't completed — relabel it
	const activeIdx = planState.steps.findIndex((s) => s.active);
	if (activeIdx >= 0 && !planState.steps[activeIdx].completed) {
		planState.steps[activeIdx].label = label;
		planState.steps[activeIdx].active = true;
		// Set startTime if not already set (e.g. relabel from pre-planned)
		if (!planState.steps[activeIdx].startTime) {
			planState.steps[activeIdx].startTime = Date.now();
		}
		resetSpinner();
		_renderWidget();
		recordTimelineFrame("delegation_start");
		return;
	}

	// Case 2: Find the first pending step and activate it
	const pendingIdx = planState.steps.findIndex(
		(s) => !s.completed && !s.active && !s.errored,
	);
	if (pendingIdx >= 0) {
		planState.steps[pendingIdx].label = label;
		planState.steps[pendingIdx].active = true;
		planState.steps[pendingIdx].startTime = Date.now();
		resetSpinner();
		_renderWidget();
		recordTimelineFrame("delegation_start");
		return;
	}

	// Case 3: No pre-planned steps left — append dynamically
	pushPlanStep(label);
	resetSpinner();
	_renderWidget();
	recordTimelineFrame("delegation_start");
}

/**
 * Update the detail text for the currently active plan step.
 * Shown after an em-dash separator in the widget (e.g. "⠋ Scout: auth — Reading extension.ts").
 * Pass empty string to clear the detail.
 */
export function updatePlanStepDetail(detail: string | string[]): void {
	if (!planState || planState.sessionId !== _sessionId) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if (idx >= 0) {
		if (Array.isArray(detail)) {
			planState.steps[idx].detailLines = detail.length > 0 ? detail : undefined;
			planState.steps[idx].detail = undefined;
		} else {
			planState.steps[idx].detail = detail || undefined;
			planState.steps[idx].detailLines = undefined;
		}
		_renderWidget();
	}
}

export function setupPlanPanel(
	goal: string,
	stepLabels: string[],
	ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } },
): void {
	// Preserve completion state from existing in-memory plan — only if same goal
	const sameGoal = planState?.goal === goal;
	if (!sameGoal) {
		_sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		_activeDelegations = 0;
	}
	const oldSteps = sameGoal ? (planState?.steps || []) : [];
	const previousStartTime = planState?.startTime;

	planState = {
		goal,
		sessionId: _sessionId!,
		steps: stepLabels.map((label, i) => {
			const old = oldSteps.find(s => s.label === label);
			const wasCompleted = old?.completed === true;
			return {
				label,
				completed: wasCompleted,
				errored: false,
				active: !wasCompleted && i === 0,
				startTime: wasCompleted ? old.startTime : (!wasCompleted && i === 0 ? Date.now() : undefined),
				endTime: wasCompleted ? old.endTime : undefined,
			};
		}),
		startTime: sameGoal && previousStartTime ? previousStartTime : Date.now(),
	};

	_setWidget = ctx.ui.setWidget.bind(ctx.ui);
	_lastWidgetContent = null;
	startPlanTimer();
	_renderWidget();
	savePlanState();
}

export function completePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState || planState.sessionId !== _sessionId) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if (idx >= 0) {
		// Save substep history before clearing — show collapsed under completed step
		const step = planState.steps[idx];
		if (step.detailLines && step.detailLines.length > 0) {
			// Cap to 3 substeps for completed display (save budget for active step)
			(step as any).substepLines = step.detailLines.slice(-3);
		}
		step.completed = true;
		step.errored = false;
		step.active = false;
		step.detail = undefined;
		step.detailLines = undefined;
		step.endTime = Date.now();
	}
	// Don't auto-activate next step — let startDelegationStep consume it
	// when the next delegation actually begins. This avoids showing a
	// spinner on a step that the agent may never run.
	_renderWidget();
	savePlanState();
	recordTimelineFrame("step_complete");
}

/**
 * Mark current step complete and re-render the widget.
 * Does NOT auto-clear — call clearPlanIfComplete separately after delegation count drops.
 */
export function finalizePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState || planState.sessionId !== _sessionId) return;
	
	const idx = planState.steps.findIndex((s) => s.active);
	if (idx >= 0) {
		const step = planState.steps[idx];
		if (step.detailLines && step.detailLines.length > 0) {
			(step as any).substepLines = step.detailLines.slice(-3);
		}
		step.completed = true;
		step.errored = false;
		step.active = false;
		step.detail = undefined;
		step.detailLines = undefined;
		step.endTime = Date.now();
	}
	
	_renderWidget();
	savePlanState();
	recordTimelineFrame("step_complete");
}

/**
 * Check if the plan is fully complete and clear the widget if so.
 * Call this AFTER decrementDelegationCount() so _activeDelegations is 0.
 */
export function clearPlanIfComplete(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState) return;
	if (!planState.steps.every(s => s.completed)) return; // Not all done yet
	clearPlanPanel(ctx);
}

export function errorPlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }, aborted?: boolean): void {
	if (!planState || planState.sessionId !== _sessionId) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if ( idx >= 0) {
		planState.steps[idx].errored = !aborted;  // don't mark errored if user aborted
		planState.steps[idx].active = false;
		planState.steps[idx].detail = undefined;
		planState.steps[idx].endTime = Date.now();
	}
	_renderWidget();
	savePlanState();
	recordTimelineFrame(aborted ? "step_aborted" : "step_error");
}

/**
 * Reset a failed plan step for retry.
 * Clears errored flag and resets timestamps so the step can run again.
 */
export function retryPlanStep(): void {
	if (!planState || planState.sessionId !== _sessionId) return;
	const idx = planState.steps.findIndex((s) => s.errored);
	if (idx >= 0) {
		planState.steps[idx].errored = false;
		planState.steps[idx].completed = false;
		planState.steps[idx].active = true;
		planState.steps[idx].detail = undefined;
		planState.steps[idx].detailLines = undefined;
		planState.steps[idx].startTime = Date.now();
		planState.steps[idx].endTime = undefined;
	}
	_renderWidget();
}

export function renderPlanStatusText(): string {
	if (!planState) return "";
	const { goal, steps, startTime } = planState;
	const elapsed = Date.now() - startTime;
	const total = steps.length;
	const completed = steps.filter((s) => s.completed).length;
	const dots = steps.filter((s) => s.completed || s.errored).map((s) => (s.errored ? "✗" : "●")).join("");
	return `⚡ ${truncateLabel(goal, 120)} ${dots} [${completed}/${total}] ${formatDuration(elapsed)}`;
}

// ============================================================================
// Timeline dump to disk
// ============================================================================

/**
 * Dump timeline to disk as JSON when a plan session completes.
 * Writes to /tmp/orchestrator-timeline-<sessionId>.json
 */
export function dumpTimelineToDisk(): void {
	if (_timeline.length === 0) return;
	const id = _sessionId ?? "unknown";
	const path = "/tmp/orchestrator-timeline-" + id + ".json";
	try {
		const data = JSON.stringify({
			sessionId: id,
			recordedAt: Date.now(),
			totalFrames: _timeline.length,
			events: getTimeline(),
			diff: getTimelineDiff(),
		}, null, 2);
		writeFileSync(path, data, "utf-8");
		console.error("[timeline] " + _timeline.length + " frames -> " + path);
	} catch (e) {
		console.error("[timeline] failed to write: " + e);
	}
}
