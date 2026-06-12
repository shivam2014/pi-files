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
import type { PlanStep } from "./types.ts";

// ============================================================================
// Constants
// ============================================================================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spinnerIndex = 0;

/** Widget key used for setWidget calls */
const WIDGET_KEY = "orchestrator-status";

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
		lines.push(`  → ${r.label}`);
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
	const rows: { icon: string; label: string; detail?: string; detailLines?: string[] }[] = [];
	for (const s of steps) {
		if (s.errored) rows.push({ icon: "✗", label: s.label });
		else if (s.completed) rows.push({ icon: "✓", label: s.label });
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
				// Can fit at least the header line — drop detailLines
				kept.unshift({ icon: rows[i].icon, label: rows[i].label });
				budget = 0;
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
			_spinnerIndex++;
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

export function summarizeGoal(prompt: string): string {
	// Extract verb + object, drop noise
	const p = prompt.trim();

	// Common action patterns
	const actionPatterns = [
		/(?:create|add|build|implement|fix|update|refactor|improve|optimize|check|investigate|analyze|find|search|debug|test|review|document|explain|set up|configure)\s+(.+)/i,
		/(?:how (?:do I|to|can I))\s+(.+)/i,
		/(?:what|which|where|when|who)\s+(?:is|are|does|do|was|were)\s+(.+)/i,
	];

	for (const pattern of actionPatterns) {
		const match = p.match(pattern);
		if (match) {
			// Clean up the matched part
			let goal = match[0].trim();
			// Remove file paths and technical noise
			goal = goal.replace(/(?:in|at|from|to|for|into)\s+[\w/.~-]+/g, '').trim();
			goal = goal.replace(/\s+/g, ' ');
			// Capitalize first letter
			goal = goal.charAt(0).toUpperCase() + goal.slice(1);
			// Truncate if too long
			if (goal.length > 50) goal = goal.slice(0, 47) + '...';
			return goal;
		}
	}

	// Fallback: use shortenLabel
	return shortenLabel(p);
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
	// Try to restore previous session state
	const restored = loadPlanState();
	if (restored && restored.goal === goal) {
		planState = restored;
		_setWidget = ctx.ui.setWidget.bind(ctx.ui);
		_lastWidgetContent = null;
		startPlanTimer();
		_renderWidget();
		return;
	}

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
		planState.steps[idx].detail = undefined;
		planState.steps[idx].detailLines = undefined;
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
	}
	_renderWidget();
	savePlanState();
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
