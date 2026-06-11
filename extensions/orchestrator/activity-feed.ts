/**
 * Activity feed — subagent tool blocks in chat history (Layer 2).
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 2: Subagent Tool Blocks
 *
 * Contains:
 * - Feed state machine (step/substep lifecycle)
 * - Text parsing for ## Goal / ## Steps format
 * - Rendering with box-drawing, progress dots, spinner animation
 * - Output compression (ANSI strip, blank collapse)
 */

import { shortenLabel } from "../token-saver.ts";
import type { OrchestratorActivity, OrchestratorStep, ActivityFeedState, Step, Substep } from "./types.ts";
import { formatDuration } from "./ui-utils.ts";

// ============================================================================
// Constants
// ============================================================================

const BOX_INNER_WIDTH = 52;
const MAX_FEED_STEPS = 6;
const MAX_FEED_SUBSTEPS = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spinnerIndex = 0;

// ============================================================================
// Orchestrator Activity — Layer 1 (plan panel steps)
// ============================================================================

export function createOrchestratorActivity(): OrchestratorActivity {
	return {
		steps: [],
		currentStep: -1,
		startTime: Date.now(),
	};
}

export function addOrchestratorStep(activity: OrchestratorActivity, label: string): void {
	const cleanLabel = shortenLabel(label);
	if (activity.steps.some((s) => s.label === cleanLabel)) return;
	activity.steps.push({
		label: cleanLabel,
		completed: false,
		startTime: Date.now(),
	});
	if (activity.currentStep === -1) activity.currentStep = 0;
}

export function completeOrchestratorStep(activity: OrchestratorActivity): void {
	if (activity.currentStep < 0 || activity.currentStep >= activity.steps.length) return;
	activity.steps[activity.currentStep].completed = true;
	activity.steps[activity.currentStep].endTime = Date.now();
	activity.currentStep++;
}

/**
 * Render the orchestrator activity (Layer 1 — plan panel steps).
 * Shows task-level progress across multiple specialist runs.
 */
function renderOrchestratorActivity(activity: OrchestratorActivity, goal?: string): string {
	const lines: string[] = [];
	const total = activity.steps.length;
	const completed = activity.steps.filter((s) => s.completed).length;

	if (goal) {
		const truncated = goal.length > BOX_INNER_WIDTH - 2
			? goal.slice(0, BOX_INNER_WIDTH - 5) + "..."
			: goal;
		lines.push(`◆ ${truncated}`);
	}

	const dots = activity.steps.filter((s) => s.completed).map(() => "●").join("");
	lines.push(`${dots} [${completed}/${total}]`);

	for (let i = 0; i < total; i++) {
		const step = activity.steps[i];
		const isCurrent = i === activity.currentStep;

		if (step.completed) {
			const duration = step.startTime && step.endTime
				? formatDuration(step.endTime - step.startTime)
				: "";
			lines.push(`✓ ${step.label}${duration ? ` (${duration})` : ""}`);
		} else if (isCurrent) {
			lines.push(`${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${step.label}...`);
		} else {
			lines.push(`○ ${step.label}`);
		}
	}

	return lines.join("\n");
}

/**
 * Render combined orchestrator + subagent progress.
 * Used when orchestrator activity is available (plan panel mode).
 */
export function renderCombinedProgress(
	orchestratorActivity: OrchestratorActivity,
	specialistName: string,
	feedState: ActivityFeedState,
	goal?: string,
): string {
	const lines: string[] = [];
	const total = orchestratorActivity.steps.length;
	const completed = orchestratorActivity.steps.filter((s) => s.completed).length;

	if (goal) {
		const truncated = goal.length > BOX_INNER_WIDTH - 2
			? goal.slice(0, BOX_INNER_WIDTH - 5) + "..."
			: goal;
		lines.push(`◆ ${truncated}`);
	}

	const dots = orchestratorActivity.steps.filter((s) => s.completed).map(() => "●").join("");
	lines.push(`${dots} [${completed}/${total}]`);

	for (let i = 0; i < total; i++) {
		const step = orchestratorActivity.steps[i];
		const isCurrent = i === orchestratorActivity.currentStep;
		const isPending = !step.completed && !isCurrent;

		if (step.completed) {
			const duration = step.startTime && step.endTime
				? formatDuration(step.endTime - step.startTime)
				: "";
			lines.push(`✓ ${step.label}${duration ? ` (${duration})` : ""}`);
		} else if (isCurrent) {
			lines.push(`→ ${step.label}... [${specialistName}]`);
			if (feedState.steps.length > 0 && feedState.currentStep >= 0 && feedState.currentStep < feedState.steps.length) {
				const currentFeedStep = feedState.steps[feedState.currentStep];
				const visibleSubs = currentFeedStep.substeps.slice(-MAX_FEED_SUBSTEPS);
				const hiddenCount = currentFeedStep.substeps.length - visibleSubs.length;
				if (hiddenCount > 0) {
					lines.push(`  ... +${hiddenCount} more`);
				}
				for (const sub of visibleSubs) {
					lines.push(sub.completed
						? `  ✓ ${sub.label}`
						: `  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${sub.label}...`);
				}
			} else {
				lines.push(`  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} Starting...`);
			}
		} else if (isPending) {
			lines.push(`○ ${step.label}`);
		}
	}

	return lines.join("\n");
}

// ============================================================================
// Activity Feed State — Layer 2 (subagent tool blocks)
// ============================================================================

export function createActivityFeed(): ActivityFeedState {
	return {
		goal: "",
		steps: [],
		currentStep: -1,
		rawText: "",
	};
}

function extractStepLabel(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return null;

	const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
	if (bulletMatch) return bulletMatch[1].trim();

	const numMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
	if (numMatch) return numMatch[1].trim();

	return null;
}

function isSectionHeader(line: string): boolean {
	return /^#{1,3}\s+/.test(line.trim());
}

function isValidStepLabel(label: string): boolean {
	if (label.length < 3) return false;
	if (label.startsWith("`/") || label.startsWith("/") || label.startsWith("\\")) return false;
	if (label.startsWith("`")) return false;
	const garbageWords = ["But", "And", "Or", "The", "For", "All", "Not", "Can", "Will", "Then", "Else", "When", "Also", "Now", "Just", "Only"];
	if (garbageWords.includes(label) && label.length < 5) return false;
	return true;
}

/**
 * Parse subagent text output to extract goal and steps.
 * Called on each text_delta to update the feed incrementally.
 */
export function parseTextForFeed(state: ActivityFeedState, text: string): void {
	state.rawText += text;
	const lines = state.rawText.split("\n");
	const completeLines = lines.slice(0, -1);

	let inGoalSection = false;
	let inStepsSection = false;
	const existingStepLabels = new Set(state.steps.map((s) => s.label));

	for (const line of completeLines) {
		const trimmed = line.trim();
		if (!trimmed) {
			inGoalSection = false;
			inStepsSection = false;
			continue;
		}

		if (trimmed.match(/^##\s+Goal/i)) {
			inGoalSection = true;
			inStepsSection = false;
			continue;
		}
		if (trimmed.match(/^##\s+Steps/i)) {
			inStepsSection = true;
			inGoalSection = false;
			continue;
		}
		if (isSectionHeader(trimmed)) {
			inGoalSection = false;
			inStepsSection = false;
			continue;
		}

		if (inGoalSection && state.goal === "") {
			state.goal = trimmed;
			continue;
		}

		if (inStepsSection) {
			const label = extractStepLabel(trimmed);
			if (label && !existingStepLabels.has(label)) {
				addStep(state, label);
				existingStepLabels.add(label);
			}
			continue;
		}

		const label = extractStepLabel(trimmed);
		if (label && state.goal && !existingStepLabels.has(label)) {
			if (isValidStepLabel(label)) {
				addStep(state, label);
				existingStepLabels.add(label);
			}
			continue;
		}

		if (state.goal === "" && !trimmed.startsWith("#")) {
			state.goal = trimmed;
		}
	}
}

export function addStep(state: ActivityFeedState, label: string): void {
	if (label === "Working...") return;

	for (let i = 0; i < state.steps.length; i++) {
		const existing = state.steps[i];
		if (label.startsWith(existing.label) && label.length > existing.label.length
			&& existing.substeps.length === 0 && !existing.completed) {
			state.steps[i] = { label, completed: false, substeps: [], startTime: existing.startTime };
			return;
		}
	}

	if (state.steps.some((s) => s.label === label)) return;
	if (state.steps.length >= MAX_FEED_STEPS) return;
	state.steps.push({ label, completed: false, substeps: [], startTime: Date.now() });
	if (state.currentStep === -1) state.currentStep = 0;
}

export function addSubstep(state: ActivityFeedState, label: string): void {
	if (state.currentStep < 0 || state.steps.length === 0) {
		const implicitLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
		state.steps.push({ label: implicitLabel, completed: false, substeps: [], startTime: Date.now() });
		state.currentStep = 0;
	}
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	const step = state.steps[state.currentStep];
	if (step.substeps.some((s) => s.label === label)) return;
	if (step.substeps.length >= MAX_FEED_SUBSTEPS) {
		step.substeps.shift();
	}
	step.substeps.push({ label, completed: false, startTime: Date.now() });
}

export function completeLastSubstep(state: ActivityFeedState): void {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	const step = state.steps[state.currentStep];
	if (step.substeps.length > 0) {
		const sub = step.substeps[step.substeps.length - 1];
		sub.completed = true;
		sub.endTime = Date.now();
	}
}

export function completeCurrentStep(state: ActivityFeedState): void {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	for (const sub of state.steps[state.currentStep].substeps) {
		sub.completed = true;
		if (!sub.endTime) sub.endTime = Date.now();
	}
	state.steps[state.currentStep].completed = true;
	state.steps[state.currentStep].endTime = Date.now();
	state.currentStep++;
}

export function toolCallToSubstep(toolName: string, input: any): string {
	const normalizePath = (p: string | undefined) => {
		if (!p) return "file";
		if (p.length > 50) {
			const parts = p.replace(/\/$/, "").split("/");
			return parts[parts.length - 1];
		}
		return p;
	};
	switch (toolName) {
		case "read":
			return `Reading ${normalizePath(input?.path || input?.file_path)}`;
		case "bash":
			return `Running: ${(input?.command || "...").slice(0, 40)}`;
		case "grep":
			return `Searching: ${input?.pattern || "..."}`;
		case "find":
			return `Finding: ${input?.pattern || "..."}`;
		case "edit":
			return `Editing ${normalizePath(input?.path)}`;
		case "write":
			return `Writing ${normalizePath(input?.path)}`;
		default:
			return `Using ${toolName}`;
	}
}

/**
 * Render the subagent activity feed (Layer 2 — tool blocks in chat history).
 * NEVER collapses. During: spinner on current. After: all ✓ with durations.
 */
export function renderActivityFeed(name: string, state: ActivityFeedState): string {
	const lines: string[] = [];

	if (state.steps.length === 0) {
		const substepCount = state.steps.reduce((sum, s) => sum + s.substeps.length, 0);
		if (substepCount > 0) {
			for (const s of state.steps) {
				for (const sub of s.substeps) {
					lines.push(sub.completed
						? `  ✓ ${sub.label}`
						: `  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${sub.label}...`);
				}
			}
			return lines.join("\n");
		}
		lines.push(`  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} Starting...`);
		return lines.join("\n");
	}

	const total = state.steps.length;
	const completed = state.steps.filter((s) => s.completed).length;

	if (state.goal) {
		const boxWidth = Math.max(state.goal.length + 4, 30);
		const padding = boxWidth - 4;
		const truncated = state.goal.length > padding ? state.goal.slice(0, padding - 3) + "..." : state.goal;
		const pad = padding - truncated.length;
		lines.push(`┌─ Task ${("─").repeat(Math.max(0, boxWidth - 9))}┐`);
		lines.push(`│ ${truncated}${(" ").repeat(pad)} │`);
		lines.push(`└${("─").repeat(Math.max(0, boxWidth - 2))}┘`);
	}

	const dots = state.steps.filter((s) => s.completed).map(() => "●").join("");
	lines.push(`${dots} [${completed}/${total}]`);

	for (let i = 0; i < total; i++) {
		const step = state.steps[i];
		const isCurrent = i === state.currentStep;

		if (step.completed) {
			const duration = step.startTime && step.endTime
				? formatDuration(step.endTime - step.startTime)
				: "";
			lines.push(`✓ ${step.label}${duration ? ` (${duration})` : ""}`);
		} else if (isCurrent) {
			lines.push(`${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${step.label}...`);
			const visibleSubs = step.substeps.slice(-MAX_FEED_SUBSTEPS);
			const hiddenCount = step.substeps.length - visibleSubs.length;
			if (hiddenCount > 0) {
				lines.push(`  ... +${hiddenCount} more`);
			}
			for (const sub of visibleSubs) {
				if (sub.completed) {
					const subDuration = sub.startTime && sub.endTime
						? formatDuration(sub.endTime - sub.startTime)
						: "";
					lines.push(`  ✓ ${sub.label}${subDuration ? ` (${subDuration})` : ""}`);
				} else {
					lines.push(`  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${sub.label}...`);
				}
			}
		} else {
			lines.push(`○ ${step.label}`);
		}
	}

	return lines.join("\n");
}

// ============================================================================
// Compression — applied to ALL subagent output before returning to main agent
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function compressOutput(output: string): string {
	let result = output;
	result = result.replace(ANSI_RE, "");
	result = result.replace(/\n{3,}/g, "\n\n");
	result = result.trim();
	return result;
}
