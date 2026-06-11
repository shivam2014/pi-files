/**
 * Plan panel — Orchestration Plan status widget (Layer 1).
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 1: Orchestration Plan
 *
 * Uses ctx.ui.setWidget() for compact display — flat text, no box borders.
 * Widget sits above editor, doesn't consume chat scroll space.
 */

import { shortenLabel } from "../token-saver.ts";
import { formatDuration } from "./ui-utils.ts";

// ============================================================================
// Constants
// ============================================================================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spinnerIndex = 0;

/** Widget key used for setWidget calls */
const WIDGET_KEY = "orchestrator-status";

// ============================================================================
// State
// ============================================================================

interface PlanStep {
	label: string;
	completed: boolean;
	active: boolean;
	errored?: boolean;
}

let planState: {
	goal: string;
	steps: PlanStep[];
	startTime: number;
} | null = null;

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
	const goalTrunc = goal.length > 55 ? goal.slice(0, 52) + "..." : goal;

	// Header: Plan ◆ <goal>  ● N/N  duration
	const prog = erroredCount > 0
		? `● ${completedCount}/${total} ✗${erroredCount}`
		: `● ${completedCount}/${total}`;
	const lines: string[] = [`Plan: ◆ ${goalTrunc}  ${prog}  ${elapsedStr}`];

	const BUDGET = 9; // widget hard-caps at 10 lines, header uses 1

	// Build display rows in CHRONOLOGICAL order — each step in its original position
	const frames = SPINNER_FRAMES;
	const idx = _spinnerIndex % frames.length;
	const rows: { icon: string; label: string }[] = [];
	for (const s of steps) {
		if (s.errored) rows.push({ icon: "✗", label: s.label });
		else if (s.completed) rows.push({ icon: "✓", label: s.label });
		else if (s.active) rows.push({ icon: frames[idx], label: s.label });
		else rows.push({ icon: "○", label: s.label });
	}

	// Trim oldest rows from the top if over budget (newest = bottom = most relevant)
	if (rows.length > BUDGET) {
		const kept = rows.slice(rows.length - BUDGET);
		const hidden = rows.length - kept.length;
		lines.push(`  … +${hidden} more`);
		for (const r of kept) lines.push(`  ${r.icon} ${r.label}`);
	} else {
		for (const r of rows) lines.push(`  ${r.icon} ${r.label}`);
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
	// Single timer at 1000ms: updates spinner and elapsed time once per second.
	// Content caching (_renderWidget) skips redundant pushes when nothing changed.
	r.planTimer = setInterval(() => {
		if (planState) {
			_spinnerIndex++;
			_renderWidget();
		} else {
			stopPlanTimer();
		}
	}, 1000);
	r.spinnerTimer = null; // merged into planTimer
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
// Plan generation — create initial steps from user prompt
// ============================================================================

/**
 * Generate initial plan steps from the user's prompt using keyword detection.
 * Determines what specialist work is needed (research, implement, test, review, docs).
 * Falls back to a standard investigate→implement→review workflow if nothing matches.
 */
export function generatePlanFromPrompt(prompt: string): string[] {
	const p = prompt.toLowerCase();
	const steps: string[] = [];
	const has = (words: string[]) => words.some((w) => p.includes(w));

	const needsTest = has([
		"test", "verify", "validate", "check",
	]);

	const needsDocs = has([
		"document", "doc", "readme", "explain",
		"documentation", "comment",
	]);

	// Always include the standard 3-step workflow (scout → coder → reviewer)
	// These get re-labeled with actual specialist info as delegations arrive
	steps.push("Investigate");
	steps.push("Implement");
	steps.push("Review");

	// Append extra steps for detected needs beyond the standard workflow
	if (needsTest) {
		steps.push("Test");
	}

	if (needsDocs) {
		steps.push("Document");
	}

	return steps;
}

// ============================================================================
// Public API
// ============================================================================

export function hasActivePlan(): boolean {
	return planState !== null;
}

export function clearPlanPanel(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
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

	_spinnerIndex = 0;
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
		_spinnerIndex = 0;
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
		_spinnerIndex = 0;
		_renderWidget();
		return;
	}

	// Case 3: No pre-planned steps left — append dynamically
	pushPlanStep(label);
}

export function setupPlanPanel(
	goal: string,
	stepLabels: string[],
	ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } },
): void {
	planState = {
		goal,
		steps: stepLabels.map((label, i) => ({
			label,
			completed: false,
			errored: false,
			active: i === 0,
		})),
		startTime: Date.now(),
	};

	// Store setWidget reference for timer updates
	_setWidget = ctx.ui.setWidget.bind(ctx.ui);
	_lastWidgetContent = null; // clear cache so initial render always pushes

	startPlanTimer();
	_renderWidget();
}

export function completePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if (idx >= 0) {
		planState.steps[idx].completed = true;
		planState.steps[idx].errored = false;
		planState.steps[idx].active = false;
	}
	// Don't auto-activate next step — let startDelegationStep consume it
	// when the next delegation actually begins. This avoids showing a
	// spinner on a step that the agent may never run.
	_renderWidget();
}

export function errorPlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if ( idx >= 0) {
		planState.steps[idx].errored = true;
		planState.steps[idx].active = false;
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
