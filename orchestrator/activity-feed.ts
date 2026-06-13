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
const MAX_FEED_SUBSTEPS = 8;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export let _spinnerIndex = 0;

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
		lines.push(`◆ ${goal}`);
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
	_spinnerIndex++;

	if (feedState.errored) {
		const msg = feedState.errorMessage ?? "Unknown error";
		const retryCount = (feedState as any).retryCount;
		if (retryCount) {
			const reason = (feedState as any).retryReason || msg;
			return `⠇ Retry ${retryCount}/3: ${reason}`;
		}
		return `✗ Step failed: ${msg}`;
	}

	const lines: string[] = [];
	const total = orchestratorActivity.steps.length;
	const completed = orchestratorActivity.steps.filter((s) => s.completed).length;

	if (goal) {
		lines.push(`◆ ${goal}`);
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
				// Note: outputPreview intentionally omitted from chat feed for compactness;
				// it's shown in the plan panel via renderSubstepLines instead.
				for (const sub of visibleSubs) {
					if (sub.completed) {
						const label = sub.label.startsWith("Reading ") ? "Read " + sub.label.slice(8) : sub.label;
						const dur = sub.startTime && sub.endTime
							? " (" + formatDuration(sub.endTime - sub.startTime) + ")"
							: "";
						lines.push(`  ✓ ${label}${dur}`);
					} else {
						lines.push(`  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${sub.label}`);
					}
				}
			} else {
				const fallbackLabel = feedState.steps[feedState.steps.length - 1]?.label || "";
				lines.push(`  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${fallbackLabel || "Working..."}`);
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
const MAX_RAW_TEXT = 10_000;

export function parseTextForFeed(state: ActivityFeedState, text: string): void {
	state.rawText += text;
	if (state.rawText.length > MAX_RAW_TEXT) {
		const excess = state.rawText.length - MAX_RAW_TEXT;
		const firstNewline = state.rawText.indexOf("\n", excess);
		state.rawText = firstNewline >= 0 ? state.rawText.slice(firstNewline + 1) : state.rawText.slice(excess);
	}
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
	if (state.steps.length >= MAX_FEED_STEPS) {
		// Remove oldest completed step, shift indices
		state.steps.shift();
		if (state.currentStep > 0) state.currentStep--;
	}
	state.steps.push({ label, completed: false, substeps: [], startTime: Date.now() });
	if (state.currentStep === -1) state.currentStep = 0;
}

export function addSubstep(state: ActivityFeedState, label: string): void {
	// If current step is completed, create a new step for fresh substeps
	if (state.currentStep >= 0 && state.currentStep < state.steps.length && state.steps[state.currentStep].completed) {
		addStep(state, label);
		return;
	}
	if (state.currentStep < 0 || state.steps.length === 0) {
		if (state.steps.length === 0) {
			const stepLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
			state.steps.push({ label: stepLabel, completed: false, substeps: [], startTime: Date.now() });
			state.currentStep = 0;
		}
	}
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	const step = state.steps[state.currentStep];
	if (step.substeps.some((s) => s.label === label)) return;
	if (step.substeps.length >= MAX_FEED_SUBSTEPS) {
		step.substeps.shift();
	}
	step.substeps.push({ label, completed: false, startTime: Date.now() });
}

export function completeLastSubstep(state: ActivityFeedState, outputPreview?: string): void {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	const step = state.steps[state.currentStep];
	if (step.substeps.length > 0) {
		const sub = step.substeps[step.substeps.length - 1];
		sub.completed = true;
		sub.endTime = Date.now();
		if (outputPreview) {
			sub.outputPreview = outputPreview;
		}
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
	// Don't clamp — let currentStep == steps.length so next addSubstep creates a new step
}

export function markFeedError(state: ActivityFeedState, message: string): void {
	state.errored = true;
	state.errorMessage = message;
	// Force-complete all steps and substeps with end times
	const now = Date.now();
	for (const step of state.steps) {
		step.completed = true;
		if (!step.endTime) step.endTime = now;
		for (const sub of step.substeps) {
			sub.completed = true;
			if (!sub.endTime) sub.endTime = now;
		}
	}
	if (state.currentStep >= 0 && state.currentStep < state.steps.length) {
		state.currentStep = state.steps.length;
	}
}

/**
 * Reset feed error for retry and increment retry count.
 * Clears errored flag and errorMessage, resets timestamps, and sets retry info.
 * Returns the retry count for display.
 */
export function retryFeedStep(state: ActivityFeedState, reason?: string): number {
	state.errored = false;
	state.errorMessage = undefined;
	const retryCount = ((state as any).retryCount || 0) + 1;
	(state as any).retryCount = retryCount;
	(state as any).retryReason = reason || state.errorMessage || "Unknown error";
	// Reset step timestamps for retry
	const now = Date.now();
	for (const step of state.steps) {
		step.completed = false;
		step.endTime = undefined;
		step.startTime = now;
		for (const sub of step.substeps) {
			sub.completed = false;
			sub.endTime = undefined;
			sub.startTime = now;
		}
	}
	state.currentStep = 0;
	return retryCount;
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
			const edits = input?.edits;
			return `Editing ${normalizePath(input?.path)}${Array.isArray(edits) ? ` (${edits.length} changes)` : ""}`;
		case "write":
			const content = input?.content || "";
			return `Writing ${normalizePath(input?.path)} (${(typeof content === "string" ? content.length : 0)} chars)`;
		case "ls":
			return `Listing ${normalizePath(input?.path)}`;
		case "lint":
			return `Linting ${normalizePath(input?.path || "files")}`;
		case "typecheck":
			return `Type checking...`;
		case "web_search":
			const query = input?.query || "";
			return `Search web: "${(typeof query === "string" ? query : "").slice(0, 80)}"`;
		case "fetch_content":
			const url = input?.url || "";
			return `Fetch URL: ${(typeof url === "string" ? url : "").slice(0, 80)}`;
		default:
			return `Calling ${toolName}...`;
	}
}

/**
 * Render substep lines for plan panel display.
 * Returns indented lines with status icons (✓ for completed, ▶ for active)
 * and optional output preview appended to completed substeps.
 */
export function renderSubstepLines(substeps: Substep[], maxLines: number = 5): string[] {
	const visible = substeps.slice(-maxLines);
	const hidden = substeps.length - visible.length;
	const lines: string[] = [];
	if (hidden > 0) {
		lines.push(`    … +${hidden} more`);
	}
	for (const sub of visible) {
		if (sub.completed) {
			const label = sub.label.startsWith("Reading ") ? "Read " + sub.label.slice(8) : sub.label;
			const dur = sub.startTime && sub.endTime
				? " (" + formatDuration(sub.endTime - sub.startTime) + ")"
				: "";
			lines.push(`    ✓ ${label}${dur}`);
		} else {
			lines.push(`    ▶ ${sub.label}`);
		}
	}
	return lines;
}

export function renderActivityFeed(name: string, state: ActivityFeedState): string {
	_spinnerIndex++;

	if (state.errored) {
		const msg = state.errorMessage ?? "Unknown error";
		const retryCount = (state as any).retryCount;
		if (retryCount) {
			const reason = (state as any).retryReason || msg;
			return `⠇ Retry ${retryCount}/3: ${reason}`;
		}
		return `✗ Step failed: ${msg}`;
	}

	const lines: string[] = [];

	if (state.goal && state.steps.length === 0) {
		lines.push(`◆ ${state.goal}`);
	}
	if (state.steps.length === 0) {
		lines.push(`  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} Working...`);
	}

	const total = state.steps.length;
	const completed = state.steps.filter((s) => s.completed).length;

	if (state.goal && state.steps.length > 0) {
		const boxWidth = Math.max(state.goal.length + 4, 30);
		const padding = boxWidth - 4;
		const truncated = state.goal.length > padding ? state.goal.slice(0, padding - 3) + "..." : state.goal;
		const pad = padding - truncated.length;
		lines.push(`┌─ Task ${("─").repeat(Math.max(0, boxWidth - 9))}┐`);
		lines.push(`│ ${truncated}${(" ").repeat(pad)} │`);
		lines.push(`└${("─").repeat(Math.max(0, boxWidth - 2))}┘`);
	}

	if (total > 0) {
		const dots = state.steps.filter((s) => s.completed).map(() => "●").join("");
		lines.push(`${dots} [${completed}/${total}]`);
	}

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
			// Note: outputPreview intentionally omitted from chat feed for compactness;
			// it's shown in the plan panel via renderSubstepLines instead.
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
