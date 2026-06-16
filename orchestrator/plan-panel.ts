/**
 * Plan panel — Orchestration Plan status widget (Layer 1).
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 1: Orchestration Plan
 *
 * Uses ctx.ui.setWidget() for compact display — flat text, no box borders.
 * Widget sits above editor, doesn't consume chat scroll space.
 */

import { writeFileSync } from "node:fs";
import { shortenLabel } from "../token-saver.ts";
import { formatDuration } from "./ui-utils.ts";
import type { PlanStep } from "./types.ts";
import { SPINNER_FRAMES, getSpinnerIndex, resetSpinner, advanceSpinner } from "./spinner-state.ts";

// ============================================================================
// Constants
// ============================================================================

/** Widget key used for setWidget calls */
const WIDGET_KEY = "orchestrator-status";

/** Delegation counter — prevents clearPlanPanel() from wiping state mid-delegation */
let _activeDelegations = 0;

export function incrementDelegationCount(): void { _activeDelegations++; }
export function decrementDelegationCount(): void { _activeDelegations = Math.max(0, _activeDelegations - 1); }

let planState: {
	goal: string;
	steps: PlanStep[];
	startTime: number;
} | null = null;

function savePlanState(): void {
	if (!planState) return;
	try {
		const fs = require('fs');
		const path = require('path');
		const dir = path.join(process.cwd(), '.pi');
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'orchestrator-plan.json'), JSON.stringify({
			goal: planState.goal,
			steps: planState.steps.map(s => ({ label: s.label, completed: s.completed, errored: s.errored })),
			startTime: planState.startTime,
		}, null, 2));
	} catch {}
}

function loadPlanState(): typeof planState {
	try {
		const fs = require('fs');
		const path = require('path');
		const statePath = path.join(process.cwd(), '.pi', 'orchestrator-plan.json');
		if (!fs.existsSync(statePath)) return null;
		const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
		if (!saved?.goal || !saved?.steps) return null;
		return {
			goal: saved.goal,
			steps: saved.steps.map((s: any) => ({ ...s, active: false })),
			startTime: saved.startTime || Date.now(),
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

/**
 * Render a single plan step row into the lines array.
 * When detailLines are present (substep history), shows step header with → icon
 * followed by indented substep lines with status icons.
 */
function _renderPlanRow(lines: string[], r: { icon: string; label: string; detail?: string; detailLines?: string[] }): void {
	if (r.detailLines && r.detailLines.length > 0) {
		// Active step uses →, completed step keeps ✓
		const headerIcon = (r.icon === "✓") ? "✓" : "→";
		lines.push(`  ${headerIcon} ${r.label}`);
		for (const dl of r.detailLines) {
			lines.push(dl);
		}
	} else {
		const suffix = r.detail ? ` — ${r.detail}` : "";
		lines.push(`  ${r.icon} ${r.label}${suffix}`);
	}
}

/**
 * Render plan panel as a compact string array (no box borders).
 * Each element is one line of the widget.
 */
function renderPlanLines(): string[] {
	if (!planState) return [];
	const { goal, steps, startTime } = planState;
	const elapsed = Date.now() - startTime;
	const elapsedStr = formatDuration(elapsed).padStart(6);
	const total = steps.length;
	const completedCount = steps.filter((s) => s.completed).length;
	const erroredCount = steps.filter((s) => s.errored).length;
	const goalTrunc = goal;

	// Progress count — only show when steps exist
	const prog = total > 0
		? (erroredCount > 0
			? `● ${completedCount}/${total} ✗${erroredCount}`
			: `● ${completedCount}/${total}`)
		: '';
	const lines: string[] = [`Plan: ◆ ${goalTrunc}${prog ? `  ${prog}  ` : '  '}${elapsedStr}`];

	const BUDGET = 9; // widget hard-caps at 10 lines, header uses 1

	// Build display rows in CHRONOLOGICAL order — each step in its original position
	const frames = SPINNER_FRAMES;
	const idx = getSpinnerIndex() % frames.length;
	const rows: { icon: string; label: string; detail?: string; detailLines?: string[] }[] = [];
	for (const s of steps) {
		if (s.errored) rows.push({ icon: "✗", label: s.label });
		else if (s.completed) {
			const dur = (s as any).startTime && (s as any).endTime
				? " (" + formatDuration((s as any).endTime - (s as any).startTime) + ")"
				: "";
			rows.push({
				icon: "✓",
				label: s.label + dur,
				detailLines: (s as any).substepLines,
			});
		}
		else if (s.active) rows.push({
			icon: frames[idx],
			label: s.label,
			detail: s.detailLines?.length ? undefined : s.detail,
			detailLines: s.detailLines,
		});
		else rows.push({ icon: "○", label: s.label });
	}

	// Calculate display lines per row (1 for header + N for detail lines)
	const lineCounts = rows.map((r) => 1 + (r.detailLines?.length ?? 0));
	const totalDisplayLines = lineCounts.reduce((a, b) => a + b, 0);

	if (totalDisplayLines <= BUDGET) {
		// All fit — render everything
		for (const r of rows) {
			_renderPlanRow(lines, r);
		}
	} else {
		// Trim oldest rows from the top to fit within budget
		let budget = BUDGET;
		const kept: typeof rows = [];
		// Build from the bottom (newest) upward
		for (let i = rows.length - 1; i >= 0; i--) {
			const needed = lineCounts[i];
			if (needed <= budget) {
				kept.unshift(rows[i]);
				budget -= needed;
			} else if (budget >= 1) {
				// Partial substep retention: keep last 3 substeps + … +N more
				if (rows[i].detailLines && rows[i].detailLines.length > 0 && budget >= 2) {
					const totalSubs = rows[i].detailLines!.length;
					const canFit = Math.min(totalSubs, budget - 1); // -1 for header
					const keptSubs = rows[i].detailLines!.slice(-canFit);
					const droppedSubs = totalSubs - canFit;
					const truncatedLines: string[] = [];
					if (droppedSubs > 0) {
						truncatedLines.push(`    … +${droppedSubs} more`);
					}
					for (const line of keptSubs) {
						truncatedLines.push(line);
					}
					kept.unshift({ icon: rows[i].icon, label: rows[i].label, detailLines: truncatedLines });
					budget = 0;
				} else {
					// Can fit at least the header line — drop detailLines
					kept.unshift({ icon: rows[i].icon, label: rows[i].label });
					budget = 0;
				}
			}
		}
		const hidden = rows.length - kept.length;
		if (hidden > 0) lines.push(`  … +${hidden} more`);
		for (const r of kept) {
			_renderPlanRow(lines, r);
		}
	}

	return lines;
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
    const maxLen = 80;
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

export function hasActivePlan(): boolean {
	return planState !== null;
}

export function clearPlanPanel(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (_activeDelegations > 0) return;
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
	if (!planState) return;

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
	(newStep as any).startTime = Date.now();

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
	if (!planState) return;

	// Case 1: Active step exists and isn't completed — relabel it
	const activeIdx = planState.steps.findIndex((s) => s.active);
	if (activeIdx >= 0 && !planState.steps[activeIdx].completed) {
		planState.steps[activeIdx].label = label;
		planState.steps[activeIdx].active = true;
		// Set startTime if not already set (e.g. relabel from pre-planned)
		if (!(planState.steps[activeIdx] as any).startTime) {
			(planState.steps[activeIdx] as any).startTime = Date.now();
		}
		resetSpinner();
		_renderWidget();
		return;
	}

	// Case 2: Find the first pending step and activate it
	const pendingIdx = planState.steps.findIndex(
		(s) => !s.completed && !s.active && !s.errored,
	);
	if (pendingIdx >= 0) {
		planState.steps[pendingIdx].label = label;
		planState.steps[pendingIdx].active = true;
		(planState.steps[pendingIdx] as any).startTime = Date.now();
		resetSpinner();
		_renderWidget();
		return;
	}

	// Case 3: No pre-planned steps left — append dynamically
	pushPlanStep(label);
}

/**
 * Update the detail text for the currently active plan step.
 * Shown after an em-dash separator in the widget (e.g. "⠋ Scout: auth — Reading extension.ts").
 * Pass empty string to clear the detail.
 */
export function updatePlanStepDetail(detail: string | string[]): void {
	if (!planState) return;
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
	_sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	// Preserve completion state from existing in-memory plan — only if same goal
	const sameGoal = planState?.goal === goal;
	const oldSteps = sameGoal ? (planState?.steps || []) : [];
	const previousStartTime = planState?.startTime;

	planState = {
		goal,
		steps: stepLabels.map((label, i) => {
			const old = oldSteps.find(s => s.label === label);
			const wasCompleted = old?.completed === true;
			return {
				label,
				completed: wasCompleted,
				errored: false,
				active: !wasCompleted && i === 0,
				startTime: wasCompleted ? (old as any).startTime : (!wasCompleted && i === 0 ? Date.now() : undefined),
				endTime: wasCompleted ? (old as any).endTime : undefined,
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
	if (!planState) return;
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
		(step as any).endTime = Date.now();
	}
	// Don't auto-activate next step — let startDelegationStep consume it
	// when the next delegation actually begins. This avoids showing a
	// spinner on a step that the agent may never run.
	_renderWidget();
	savePlanState();
}

export function errorPlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if ( idx >= 0) {
		planState.steps[idx].errored = true;
		planState.steps[idx].active = false;
		planState.steps[idx].detail = undefined;
		(planState.steps[idx] as any).endTime = Date.now();
	}
	_renderWidget();
	savePlanState();
}

/**
 * Reset a failed plan step for retry.
 * Clears errored flag and resets timestamps so the step can run again.
 */
export function retryPlanStep(): void {
	if (!planState) return;
	const idx = planState.steps.findIndex((s) => s.errored);
	if (idx >= 0) {
		planState.steps[idx].errored = false;
		planState.steps[idx].completed = false;
		planState.steps[idx].active = true;
		planState.steps[idx].detail = undefined;
		planState.steps[idx].detailLines = undefined;
		(planState.steps[idx] as any).startTime = Date.now();
		(planState.steps[idx] as any).endTime = undefined;
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
	return `⚡ ${shortenLabel(goal)} ${dots} [${completed}/${total}] ${formatDuration(elapsed)}`;
}
// ============================================================================
// Timeline — ordered frame history for orchestrator debug view
// ============================================================================

const MAX_TIMELINE_FRAMES = 200;

export interface TimelineEntry {
	t: number;
	event: string;
	render: string;
	state: Record<string, unknown> | null;
	feedState?: Record<string, unknown> | null;
	feedRender?: string;
}

const _timeline: TimelineEntry[] = [];
let _timelineStart = Date.now();
let _sessionId: string | null = null;

/** Snapshot current plan render lines as single string. */
function snapshotPlanRender(): string {
	return renderPlanLines().join("\n");
}

/** Snapshot current plan state as JSON-safe record. */
function inspectPlanState(): Record<string, unknown> | null {
	if (!planState) return null;
	return {
		goal: planState.goal,
		steps: planState.steps.map(s => ({
			label: s.label,
			completed: s.completed,
			active: s.active,
			errored: s.errored,
		})),
		startTime: planState.startTime,
	};
}

/**
 * Record a frame in the shared timeline.
 * Called by subagent-runner to push feed state snapshots alongside plan state.
 */
export function recordTimelineFrame(
	event: string,
	feedState?: Record<string, unknown> | null,
	feedRender?: string,
): void {
	if (_timeline.length >= MAX_TIMELINE_FRAMES) _timeline.shift();
	_timeline.push({
		t: Date.now() - _timelineStart,
		event,
		render: snapshotPlanRender(),
		state: inspectPlanState(),
		...(feedState !== undefined ? { feedState } : {}),
		...(feedRender !== undefined ? { feedRender } : {}),
	});
}



/** Return all recorded timeline entries. */
export function getTimeline(): TimelineEntry[] {
	return _timeline;
}

/** Return first and last timeline entries for diff inspection. */
export function getTimelineDiff(): { first: TimelineEntry | null; last: TimelineEntry | null; count: number } {
	return {
		first: _timeline.length > 0 ? _timeline[0] : null,
		last: _timeline.length > 0 ? _timeline[_timeline.length - 1] : null,
		count: _timeline.length,
	};
}

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
