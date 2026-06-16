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
import { SPINNER_FRAMES, advanceSpinner, getSpinnerIndex, resetSpinner } from "./spinner-state.ts";

// ============================================================================
// Constants
// ============================================================================

const BOX_INNER_WIDTH = 52;
const MAX_FEED_STEPS = 6;
const MAX_FEED_SUBSTEPS = 8;

// ============================================================================
// Orchestrator Activity — Layer 1 (plan panel steps)
// ============================================================================

export function createOrchestratorActivity(initialLabel?: string): OrchestratorActivity {
	const steps: OrchestratorStep[] = initialLabel
		? [{ label: shortenLabel(initialLabel), completed: false, startTime: Date.now() }]
		: [];
	return {
		steps,
		currentStep: initialLabel ? 0 : -1,
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
			lines.push(`${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} ${step.label}...`);
		} else {
			lines.push(`○ ${step.label}`);
		}
	}

	return lines.join("\n");
}

/**
 * Render combined orchestrator + subagent progress in canonical format.
 * Mirrors renderActivityFeed rendering rules per SPEC-UI.md.
 */
export function renderCombinedProgress(
	specialistName: string,
	feedState: ActivityFeedState,
	goal?: string,
): string {
	advanceSpinner();

	if (feedState.errored) {
		const msg = feedState.errorMessage ?? "Unknown error";
		const retryCount = (feedState as any).retryCount;
		if (retryCount) {
			const reason = (feedState as any).retryReason || msg;
			return `⠇ Retry ${retryCount}/3: ${reason}`;
		}
		// Render step tree with errored step showing ✗ instead of early return
		const errorLines: string[] = [];
		const total = feedState.steps.length;
		const completed = feedState.steps.filter((s) => s.completed).length;

		// Goal line — prefer explicit goal param, then feed goal
		const displayGoal = goal || feedState.goal;
		if (displayGoal) {
			errorLines.push(`◆ ${displayGoal}`);
		}

		if (total > 0) {
			// Progress dots row: ● for completed, ✗ for errored step, ○ for pending
			let dots = "";
			for (let i = 0; i < total; i++) {
				if (feedState.steps[i].completed) {
					dots += "●";
				} else if (i === feedState.currentStep) {
					dots += "✗";
				} else {
					dots += "○";
				}
			}
			errorLines.push(`${dots} ${completed}/${total}`);

			// Render each step
			for (let i = 0; i < total; i++) {
				const step = feedState.steps[i];
				const isErrored = i === feedState.currentStep;
				const isPending = !step.completed && !isErrored;

				if (step.completed) {
					const duration = step.startTime && step.endTime
						? formatDuration(step.endTime - step.startTime)
						: "";
					errorLines.push(`  ✓ Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`);
					for (const sub of step.substeps) {
						if (sub.isReport) {
							errorLines.push(`    ✓ Report: ${sub.label}`);
						} else {
							errorLines.push(`    ✓ ${sub.label}`);
						}
					}
				} else if (isErrored) {
					const duration = step.startTime
						? formatDuration(Date.now() - step.startTime)
						: "";
					errorLines.push(`  ✗ Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`);
					// Completed substeps shown with ✓, active substep shown with ✗, pending not shown
					let foundActive = false;
					for (const sub of step.substeps) {
						if (sub.completed) {
							if (sub.isReport) {
								errorLines.push(`    ✓ Report: ${sub.label}`);
							} else {
								errorLines.push(`    ✓ ${sub.label}`);
							}
						} else if (!foundActive) {
							foundActive = true;
							errorLines.push(`    ✗ ${sub.label}`);
						} // else: pending substeps after active one — not shown
					}
				} else if (isPending) {
					errorLines.push(`  ○ Step ${i + 1}: ${step.label}`);
				}
			}
		} else {
			// No steps yet — just show error message
			errorLines.push(`  ✗ ${msg}`);
		}

		return errorLines.join("\n");
	}

	const lines: string[] = [];
	const total = feedState.steps.length;
	const completed = feedState.steps.filter((s) => s.completed).length;
	const spinnerIdx = getSpinnerIndex();
	const spinner = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];

	// Goal line — prefer explicit goal param, then feed goal
	const displayGoal = goal || feedState.goal;
	if (displayGoal) {
		lines.push(`◆ ${displayGoal}`);
	}

	if (total === 0) {
		lines.push(`  ${spinner} Working...`);
		return lines.join("\n");
	}

	// Progress dots row: ●○○ N/M
	{
		let dots = "";
		for (let i = 0; i < total; i++) {
			if (feedState.steps[i].completed) {
				dots += "●";
			} else if (i === feedState.currentStep) {
				dots += (spinnerIdx % 2 === 0) ? "○" : "●";
			} else {
				dots += "○";
			}
		}
		lines.push(`${dots} ${completed}/${total}`);
	}

	// Render each step from feed state (parsed Step N: labels)
	for (let i = 0; i < total; i++) {
		const step = feedState.steps[i];
		const isCurrent = i === feedState.currentStep;
		const isPending = !step.completed && !isCurrent;

		if (step.completed) {
			const duration = step.startTime && step.endTime
				? formatDuration(step.endTime - step.startTime)
				: "";
			lines.push(`  ✓ Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`);
			for (const sub of step.substeps) {
				if (sub.isReport) {
					lines.push(`    ✓ Report: ${sub.label}`);
				} else {
					lines.push(`    ✓ ${sub.label}`);
				}
			}
		} else if (isCurrent) {
			lines.push(`  ${spinner} Step ${i + 1}: ${step.label}`);
			let foundActive = false;
			for (const sub of step.substeps) {
				if (sub.completed) {
					if (sub.isReport) {
						lines.push(`    ✓ Report: ${sub.label}`);
					} else {
						lines.push(`    ✓ ${sub.label}`);
					}
				} else if (!foundActive) {
					foundActive = true;
					lines.push(`    ${spinner} ${sub.label}`);
					if (sub.toolDetail) {
						lines.push(`        ${spinner} ${sub.toolDetail}`);
					}
				} else {
					lines.push(`    ○ ${sub.label}`);
				}
			}
		} else if (isPending) {
			lines.push(`  ○ Step ${i + 1}: ${step.label}`);
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

/**
 * Parse subagent text output to extract goal and steps.
 * Handles canonical Step N: format and indented - bullet substeps.
 * Called on each text_delta to update the feed incrementally.
 */
const MAX_RAW_TEXT = 10_000;

export function parseTextForFeed(state: ActivityFeedState, text: string): ActivityFeedState {
	let rawText = state.rawText + text;
	if (rawText.length > MAX_RAW_TEXT) {
		const excess = rawText.length - MAX_RAW_TEXT;
		const firstNewline = rawText.indexOf("\n", excess);
		rawText = firstNewline >= 0 ? rawText.slice(firstNewline + 1) : rawText.slice(excess);
	}

	const lines = rawText.split("\n");
	const completeLines = lines.slice(0, -1);

	let currentState: ActivityFeedState = { ...state, rawText };
	let inGoalSection = false;
	let inStepsSection = false;
	const existingStepLabels = new Set(currentState.steps.map((s) => s.label));

	for (const line of completeLines) {
		const trimmed = line.trim();
		if (!trimmed) {
			inGoalSection = false;
			inStepsSection = false;
			continue;
		}

		// Detect ## Goal section
		if (trimmed.match(/^##\s+Goal/i)) {
			inGoalSection = true;
			inStepsSection = false;
			continue;
		}

		// Detect ## Steps section
		if (trimmed.match(/^##\s+Steps/i)) {
			inStepsSection = true;
			inGoalSection = false;
			continue;
		}

		// Any other ## header exits both
		if (trimmed.match(/^#{1,3}\s+/)) {
			inGoalSection = false;
			inStepsSection = false;
			continue;
		}

		// Goal text (line after ## Goal)
		if (inGoalSection && currentState.goal === "") {
			currentState = { ...currentState, goal: trimmed };
			continue;
		}

		// Steps section parsing
		if (inStepsSection) {
			// Canonical: Step N: <label>
			const stepMatch = trimmed.match(/^Step\s+(\d+):\s*(.+)/i);
			if (stepMatch) {
				resetSpinner();
				const stepLabel = stepMatch[2].trim();
				if (stepLabel && !existingStepLabels.has(stepLabel)) {
					currentState = addStep(currentState, stepLabel);
					existingStepLabels.add(stepLabel);
				}
				continue;
			}

			// Indented bullet: substep of current step
			const indentMatch = line.match(/^(\s{2,})[-*]\s+(.+)/);
			if (indentMatch && currentState.currentStep >= 0 &&
					currentState.currentStep < currentState.steps.length) {
				const bulletText = indentMatch[2].trim();
				const isReport = /^Report:\s*(.+)/i.exec(bulletText);
				const substepLabel = isReport ? isReport[1].trim() : bulletText;
				const step = currentState.steps[currentState.currentStep];

				if (!step.substeps.some((s) => s.label === substepLabel)) {
					// Report bullets are completed findings; regular bullets are pending actions
					const newSubstep: Substep = {
						label: substepLabel,
						completed: !!isReport,
						isReport: !!isReport,
						startTime: Date.now(),
						endTime: isReport ? Date.now() : undefined,
					};
					const newSubsteps = [...step.substeps, newSubstep];
					const newSteps = currentState.steps.map((s, i) =>
						i === currentState.currentStep ? { ...s, substeps: newSubsteps } : s
					);
					currentState = { ...currentState, steps: newSteps };
				}
				continue;
			}

			// Backward compat: non-indented - bullet treated as step label
			const legacyBullet = trimmed.match(/^[-*]\s+(.+)/);
			if (legacyBullet) {
				const label = legacyBullet[1].trim();
				if (!label.match(/^Report:/i) && !existingStepLabels.has(label)) {
					currentState = addStep(currentState, label);
					existingStepLabels.add(label);
				}
				continue;
			}

			// Backward compat: numbered "1. <label>" or "1) <label>"
			const numMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
			if (numMatch) {
				const label = numMatch[1].trim();
				if (!existingStepLabels.has(label)) {
					currentState = addStep(currentState, label);
					existingStepLabels.add(label);
				}
				continue;
			}

			continue;
		}

		// Fallback: first non-header line before any section is the goal
		if (currentState.goal === "" && !trimmed.startsWith("#")) {
			currentState = { ...currentState, goal: trimmed };
		}
	}

	return currentState;
}

export function addStep(state: ActivityFeedState, label: string): ActivityFeedState {
	if (label === "Working...") return state;

	for (let i = 0; i < state.steps.length; i++) {
		const existing = state.steps[i];
		if (label.startsWith(existing.label) && label.length > existing.label.length
			&& existing.substeps.length === 0 && !existing.completed) {
			const newSteps = state.steps.map((s, idx) => idx === i ? { label, completed: false, substeps: [], startTime: existing.startTime } : s);
			return { ...state, steps: newSteps };
		}
	}

	if (state.steps.some((s) => s.label === label)) return state;

	let steps = state.steps;
	let currentStep = state.currentStep;
	if (state.steps.length >= MAX_FEED_STEPS) {
		steps = state.steps.slice(1);
		if (currentStep > 0) currentStep--;
	}
	steps = [...steps, { label, completed: false, substeps: [], startTime: Date.now() }];
	if (currentStep === -1) currentStep = 0;
	return { ...state, steps, currentStep };
}

export function addSubstep(state: ActivityFeedState, label: string): ActivityFeedState {
	let { steps, currentStep } = state;

	if (currentStep >= 0 && currentStep < steps.length && steps[currentStep].completed) {
		return addStep(state, label);
	}
	if (currentStep < 0 || steps.length === 0) {
		if (steps.length === 0) {
			const stepLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
			return {
				...state,
				steps: [{ label: stepLabel, completed: false, substeps: [{ label, completed: false, startTime: Date.now() }], startTime: Date.now() }],
				currentStep: 0,
			};
		}
	}
	if (currentStep < 0 || currentStep >= steps.length) {
		return addStep(state, label);
	}

	const step = steps[currentStep];
	if (step.substeps.some((s) => s.label === label)) return state;

	let newSubsteps = step.substeps;
	if (step.substeps.length >= MAX_FEED_SUBSTEPS) {
		newSubsteps = step.substeps.slice(1);
	}
	newSubsteps = [...newSubsteps, { label, completed: false, startTime: Date.now() }];

	const newSteps = steps.map((s, i) => i === currentStep ? { ...s, substeps: newSubsteps } : s);
	return { ...state, steps: newSteps };
}

/**
 * Complete the active (first uncompleted) substep of the current step.
 * In the new model, substeps are parsed upfront in order; the first uncompleted is the active one.
 */
export function completeLastSubstep(state: ActivityFeedState, outputPreview?: string): ActivityFeedState {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return state;
	const step = state.steps[state.currentStep];
	if (step.substeps.length === 0) return state;

	// Find first uncompleted substep (the active one)
	let activeIdx = -1;
	for (let i = 0; i < step.substeps.length; i++) {
		if (!step.substeps[i].completed) {
			activeIdx = i;
			break;
		}
	}
	if (activeIdx < 0) return state;

	const now = Date.now();
	const newSubsteps = step.substeps.map((sub, i) => {
		if (i !== activeIdx) return sub;
		return { ...sub, completed: true, endTime: now, ...(outputPreview ? { outputPreview } : {}) };
	});
	const newSteps = state.steps.map((s, i) => i === state.currentStep ? { ...s, substeps: newSubsteps } : s);
	return { ...state, steps: newSteps };
}

/**
 * Set tool detail on the active (first uncompleted) substep of the current step.
 * Clears any previous toolDetail. No-op if no uncompleted substep exists.
 */
export function setToolDetail(feed: ActivityFeedState, detail: string): ActivityFeedState {
	if (feed.currentStep < 0 || feed.currentStep >= feed.steps.length) return feed;
	const step = feed.steps[feed.currentStep];
	if (step.substeps.length === 0) return feed;

	// Find first uncompleted substep (the active one)
	let activeIdx = -1;
	for (let i = 0; i < step.substeps.length; i++) {
		if (!step.substeps[i].completed) {
			activeIdx = i;
			break;
		}
	}
	if (activeIdx < 0) return feed;

	const newSubsteps = step.substeps.map((sub, i) =>
		i === activeIdx ? { ...sub, toolDetail: detail } : sub
	);
	const newSteps = feed.steps.map((s, i) =>
		i === feed.currentStep ? { ...s, substeps: newSubsteps } : s
	);
	return { ...feed, steps: newSteps };
}

/**
 * Clear tool detail from the active (first uncompleted) substep.
 */
export function clearToolDetail(feed: ActivityFeedState): ActivityFeedState {
	if (feed.currentStep < 0 || feed.currentStep >= feed.steps.length) return feed;
	const step = feed.steps[feed.currentStep];
	if (step.substeps.length === 0) return feed;

	// Find first uncompleted substep (the active one)
	let activeIdx = -1;
	for (let i = 0; i < step.substeps.length; i++) {
		if (!step.substeps[i].completed) {
			activeIdx = i;
			break;
		}
	}
	if (activeIdx < 0) return feed;

	const newSubsteps = step.substeps.map((sub, i) =>
		i === activeIdx ? { ...sub, toolDetail: undefined } : sub
	);
	const newSteps = feed.steps.map((s, i) =>
		i === feed.currentStep ? { ...s, substeps: newSubsteps } : s
	);
	return { ...feed, steps: newSteps };
}

export function completeCurrentStep(state: ActivityFeedState): ActivityFeedState {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return state;
	const now = Date.now();
	const newSteps = state.steps.map((s, i) => {
		if (i !== state.currentStep) return s;
		return {
			...s,
			completed: true,
			endTime: now,
			substeps: s.substeps.map(sub => ({ ...sub, completed: true, endTime: sub.endTime || now })),
		};
	});
	return { ...state, steps: newSteps, currentStep: state.currentStep + 1 };
}

export function markFeedError(state: ActivityFeedState, message: string): ActivityFeedState {
	const now = Date.now();
	const newSteps = state.steps.map((step, i) => {
		if (i < state.currentStep) {
			// Steps before the errored step are completed
			return {
				...step,
				completed: true,
				endTime: step.endTime || now,
				substeps: step.substeps.map(sub => ({ ...sub, completed: true, endTime: sub.endTime || now })),
			};
		} else if (i === state.currentStep) {
			// The errored step: keep completed=false, mark completed substeps
			let foundActive = false;
			const newSubsteps = step.substeps.map(sub => {
				if (sub.completed) return sub;
				if (!foundActive) {
					foundActive = true;
					return sub; // active substep at time of error — render will show ✗
				}
				// Pending substeps after the active one: keep as-is (render won't show)
				return sub;
			});
			return { ...step, completed: false, substeps: newSubsteps };
		} else {
			// Steps after errored step remain pending (completed=false)
			return step;
		}
	});
	// Keep currentStep where it is — don't advance past errored step
	return { ...state, errored: true, errorMessage: message, steps: newSteps };
}

/**
 * Reset feed error for retry and increment retry count.
 * Clears errored flag and errorMessage, resets timestamps, and sets retry info.
 * Returns the retry count for display.
 */
export function retryFeedStep(state: ActivityFeedState, reason?: string): { state: ActivityFeedState; retryCount: number } {
	const retryCount = (state.retryCount || 0) + 1;
	const now = Date.now();
	const newSteps = state.steps.map(step => ({
		...step,
		completed: false,
		endTime: undefined,
		startTime: now,
		substeps: step.substeps.map(sub => ({ ...sub, completed: false, endTime: undefined, startTime: now })),
	}));
	return {
		state: {
			...state,
			errored: false,
			errorMessage: undefined,
			steps: newSteps,
			currentStep: 0,
			retryCount,
			retryReason: reason || state.errorMessage || "Unknown error",
		},
		retryCount,
	};
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
			const cmd = (input?.command || "").trim();
			const firstWord = cmd.split(/\s+/)[0] || "";
			const trivialCmds = ["cd", "pwd", "echo", "clear", "which", "type"];
			if (trivialCmds.includes(firstWord)) {
				return `${firstWord} ${cmd.slice(firstWord.length).trim().slice(0, 80)}`;
			}
			return `Running: ${cmd.slice(0, 100)}`;
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
			return `Search web: "${(typeof query === "string" ? query : "").slice(0, 200)}"`;
		case "fetch_content":
			const url = input?.url || "";
			return `Fetch URL: ${(typeof url === "string" ? url : "").slice(0, 200)}`;
		default:
			return `Calling ${toolName}...`;
	}
}

/**
 * Render substep lines for plan panel display.
 * Returns indented lines with status icons (✓ for completed, ▶ for active)
 * and optional output preview appended to completed substeps.
 */
export function renderSubstepLines(substeps: Substep[], maxLines: number = 3): string[] {
	const visible = substeps.slice(-maxLines);
	const hidden = substeps.length - visible.length;
	const lines: string[] = [];
	if (hidden > 0) {
		lines.push(`    … +${hidden} more`);
	}
	for (const sub of visible) {
		if (sub.completed) {
			if (sub.isReport) {
				lines.push(`    ✓ Report: ${sub.label}`);
			} else {
				const label = sub.label.startsWith("Reading ") ? "Read " + sub.label.slice(8) : sub.label;
				lines.push(`    ✓ ${label}`);
			}
		} else {
			const label = sub.label.startsWith("Running: ") ? sub.label.slice(9) : sub.label;
			lines.push(`    ${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} ${label}`);
		}
	}
	return lines;
}

/**
 * Render activity feed in canonical format per SPEC-UI.md.
 * Produces the exact hierarchical view with progress dots, steps, substeps, and tool detail.
 */
export function renderActivityFeed(_name: string, state: ActivityFeedState): string {
	advanceSpinner();

	if (state.errored) {
		const msg = state.errorMessage ?? "Unknown error";
		const retryCount = (state as any).retryCount;
		if (retryCount) {
			const reason = (state as any).retryReason || msg;
			return `⠇ Retry ${retryCount}/3: ${reason}`;
		}
		// Render step tree with errored step showing ✗ instead of early return
		const errorLines: string[] = [];
		const total = state.steps.length;
		const completed = state.steps.filter((s) => s.completed).length;

		// Goal line
		if (state.goal) {
			errorLines.push(`◆ ${state.goal}`);
		}

		if (total > 0) {
			// Progress dots row: ● for completed, ✗ for errored step, ○ for pending
			let dots = "";
			for (let i = 0; i < total; i++) {
				if (state.steps[i].completed) {
					dots += "●";
				} else if (i === state.currentStep) {
					dots += "✗";
				} else {
					dots += "○";
				}
			}
			errorLines.push(`${dots} ${completed}/${total}`);

			// Render each step
			for (let i = 0; i < total; i++) {
				const step = state.steps[i];
				const isErrored = i === state.currentStep;
				const isPending = !step.completed && !isErrored;

				if (step.completed) {
					const duration = step.startTime && step.endTime
						? formatDuration(step.endTime - step.startTime)
						: "";
					errorLines.push(`  ✓ Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`);
					for (const sub of step.substeps) {
						if (sub.isReport) {
							errorLines.push(`    ✓ Report: ${sub.label}`);
						} else {
							errorLines.push(`    ✓ ${sub.label}`);
						}
					}
				} else if (isErrored) {
					const duration = step.startTime
						? formatDuration(Date.now() - step.startTime)
						: "";
					errorLines.push(`  ✗ Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`);
					let foundActive = false;
					for (const sub of step.substeps) {
						if (sub.completed) {
							if (sub.isReport) {
								errorLines.push(`    ✓ Report: ${sub.label}`);
							} else {
								errorLines.push(`    ✓ ${sub.label}`);
							}
						} else if (!foundActive) {
							foundActive = true;
							errorLines.push(`    ✗ ${sub.label}`);
						} // else: pending substeps after active one — not shown
					}
				} else if (isPending) {
					errorLines.push(`  ○ Step ${i + 1}: ${step.label}`);
				}
			}
		} else {
			// No steps yet — just show error message
			errorLines.push(`  ✗ ${msg}`);
		}

		return errorLines.join("\n");
	}

	const lines: string[] = [];
	const total = state.steps.length;
	const completed = state.steps.filter((s) => s.completed).length;
	const spinnerIdx = getSpinnerIndex();
	const spinner = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];

	// Goal line
	if (state.goal) {
		lines.push(`◆ ${state.goal}`);
	}

	// No steps yet — show working indicator
	if (total === 0) {
		lines.push(`  ${spinner} Working...`);
		return lines.join("\n");
	}

	// Progress dots row: ●○○ N/M
	{
		let dots = "";
		for (let i = 0; i < total; i++) {
			if (state.steps[i].completed) {
				dots += "●";
			} else if (i === state.currentStep) {
				// Blink: even frames = ○, odd frames = ●
				dots += (spinnerIdx % 2 === 0) ? "○" : "●";
			} else {
				dots += "○";
			}
		}
		lines.push(`${dots} ${completed}/${total}`);
	}

	// Render each step
	for (let i = 0; i < total; i++) {
		const step = state.steps[i];
		const isCurrent = i === state.currentStep;
		const isPending = !step.completed && !isCurrent;

		if (step.completed) {
			// Completed step:  ✓ Step N: <label> (<duration>)
			const duration = step.startTime && step.endTime
				? formatDuration(step.endTime - step.startTime)
				: "";
			lines.push(`  ✓ Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`);
			// All substeps shown with ✓
			for (const sub of step.substeps) {
				if (sub.isReport) {
					lines.push(`    ✓ Report: ${sub.label}`);
				} else {
					lines.push(`    ✓ ${sub.label}`);
				}
			}
		} else if (isCurrent) {
			// Active step:  <spinner> Step N: <label> (no duration)
			lines.push(`  ${spinner} Step ${i + 1}: ${step.label}`);
			// Render substeps: completed first, then active, then pending
			let foundActive = false;
			for (const sub of step.substeps) {
				if (sub.completed) {
					if (sub.isReport) {
						lines.push(`    ✓ Report: ${sub.label}`);
					} else {
						lines.push(`    ✓ ${sub.label}`);
					}
				} else if (!foundActive) {
					foundActive = true;
					// Active substep
					lines.push(`    ${spinner} ${sub.label}`);
					// Tool detail (ephemeral, only for active substep)
					if (sub.toolDetail) {
						lines.push(`        ${spinner} ${sub.toolDetail}`);
					}
				} else {
					// Pending substep
					lines.push(`    ○ ${sub.label}`);
				}
			}
		} else if (isPending) {
			// Pending step:  ○ Step N: <label>
			lines.push(`  ○ Step ${i + 1}: ${step.label}`);
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


// ============================================================================
// Feed snapshot helpers — used by plan-panel timeline
// ============================================================================

/**
 * Return a JSON-safe snapshot of the activity feed state.
 * Strips runtime-only fields (rawText) to keep snapshots compact.
 */
export function inspectFeedState(state: ActivityFeedState): Record<string, unknown> | null {
	if (!state) return null;
	return {
		goal: state.goal,
		steps: state.steps.map(s => ({
			label: s.label,
			completed: s.completed,
			substeps: s.substeps.map(sub => ({
				label: sub.label,
				completed: sub.completed,
				outputPreview: sub.outputPreview,
				isReport: sub.isReport,
				toolDetail: sub.toolDetail,
			})),
		})),
		currentStep: state.currentStep,
		errored: state.errored,
		errorMessage: state.errorMessage,
	};
}

/**
 * Return the rendered activity feed string for this state.
 * Uses the specialist name "subagent" for a generic label.
 */
export function snapshotFeedRender(state: ActivityFeedState): string {
	if (!state) return "";
	return renderActivityFeed("subagent", state);
}
