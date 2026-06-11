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

let planTimer: ReturnType<typeof setInterval> | null = null;
let _spinnerTimer: ReturnType<typeof setInterval> | null = null;

/** Stored reference to ctx.ui.setWidget for timer-based updates */
let _setWidget: ((key: string, content: string[] | undefined) => void) | null = null;

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
	const elapsedStr = formatDuration(elapsed);

	const total = steps.length;
	const completed = steps.filter((s) => s.completed).length;
	const errored = steps.filter((s) => s.errored).length;

	// Progress dots
	const dots = steps
		.filter((s) => s.completed || s.errored)
		.map((s) => (s.errored ? "✗" : "●"))
		.join("");

	// Goal line
	const goalTrunc = goal.length > 60 ? goal.slice(0, 57) + "..." : goal;
	const progressStr = errored > 0
		? `${dots} [${completed}/${total}] ✗${errored}`
		: `${dots} [${completed}/${total}]`;

	// Find active step label
	const activeStep = steps.find((s) => s.active);
	const activeLabel = activeStep
		? `${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${activeStep.label}`
		: "";

	const lines: string[] = [`Plan: ◆ ${goalTrunc}  ${progressStr}  ${elapsedStr}`];

	// Show active step on second line
	if (activeLabel) {
		lines.push(`  ${activeLabel}`);
	}

	return lines;
}

// ============================================================================
// Timer management
// ============================================================================

function startPlanTimer(): void {
	stopPlanTimer();
	planTimer = setInterval(() => {
		if (planState) {
			updatePlanDisplay();
		} else {
			stopPlanTimer();
		}
	}, 1000);
	_spinnerTimer = setInterval(() => {
		if (planState) {
			_spinnerIndex++;
			const lines = renderPlanLines();
			if (_setWidget) {
				_setWidget(WIDGET_KEY, lines);
			}
		}
	}, 100);
}

function stopPlanTimer(): void {
	if (planTimer !== null) {
		clearInterval(planTimer);
		planTimer = null;
	}
	if (_spinnerTimer !== null) {
		clearInterval(_spinnerTimer);
		_spinnerTimer = null;
	}
}

function updatePlanDisplay(): void {
	_spinnerIndex++;
	const lines = renderPlanLines();
	if (_setWidget) {
		_setWidget(WIDGET_KEY, lines);
	}
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
	if (_setWidget) {
		_setWidget(WIDGET_KEY, undefined);
	}
	_setWidget = null;
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

	startPlanTimer();
	updatePlanDisplay();
}

export function completePlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if (idx >= 0) {
		planState.steps[idx].completed = true;
		planState.steps[idx].errored = false;
		planState.steps[idx].active = false;
	}
	const next = idx + 1;
	if (next < planState.steps.length) {
		planState.steps[next].active = true;
	}
	updatePlanDisplay();
}

export function errorPlanStep(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
	if (!planState) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if (idx >= 0) {
		planState.steps[idx].errored = true;
		planState.steps[idx].active = false;
	}
	updatePlanDisplay();
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
