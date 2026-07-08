/**
 * Activity feed — subagent tool blocks in chat history (Layer 2).
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 2: Subagent Tool Blocks
 *
 * Contains:
 * - Feed state machine (step/substep lifecycle)
 * - planSteps/advanceStep tool-driven step registration
 * - Rendering with box-drawing, progress dots, spinner animation
 * - Output compression (ANSI strip, blank collapse)
 */

import type { ActivityFeedState, Step, Substep, PlanStep } from "./types.ts";
import { styledSymbol, statusIcon, formatDuration as thFormatDuration, getTheme } from "./orchestrator-theme.ts";


// ============================================================================
// Constants
// ============================================================================

const BOX_INNER_WIDTH = 52;
const MAX_FEED_SUBSTEPS = 8;

// Max recursive re-renders when state changes mid-render
const MAX_RENDER_RETRIES = 3;



// ============================================================================
// Activity Feed State — Layer 2 (subagent tool blocks)
// ============================================================================

// ============================================================================
// Activity Feed State — Layer 2 (subagent tool blocks)
// ============================================================================

export function createActivityFeed(): ActivityFeedState {
	return {
		goal: "",
		steps: [],
		currentStep: -1,
		rawText: "",
		planParsed: false,
	};
}



export function addStep(state: ActivityFeedState, label: string): ActivityFeedState {
	if (label === "Working...") return state;

	for (let i = 0; i < state.steps.length; i++) {
		const existing = state.steps[i];
		if (label === existing.label && existing.substeps.length === 0 && !existing.completed) {
			const newSteps = state.steps.map((s, idx) => idx === i ? { label, completed: false, substeps: [], startTime: existing.startTime } : s);
			return { ...state, steps: newSteps };
		}
	}

	if (state.steps.some((s) => s.label === label)) return state;

	let steps = state.steps;
	let currentStep = state.currentStep;
	steps = [...steps, { label, completed: false, substeps: [], startTime: Date.now() }];
	if (currentStep === -1) currentStep = 0;
	return { ...state, steps, currentStep };
}

export function addSubstep(state: ActivityFeedState, label: string, toolCallId?: string): ActivityFeedState {
	let { steps, currentStep } = state;

	if (currentStep >= 0 && currentStep < steps.length && steps[currentStep].completed) {
		return addStep(state, label);
	}
	if (currentStep < 0 || steps.length === 0) {
		if (steps.length === 0) {
			const stepLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
			return {
				...state,
				steps: [{ label: stepLabel, completed: false, substeps: [{ label, completed: false, startTime: Date.now(), ...(toolCallId ? { toolCallId } : {}) }], startTime: Date.now() }],
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
	let overflowCount = step.overflowCount || 0;
	if (step.substeps.length >= MAX_FEED_SUBSTEPS) {
		newSubsteps = step.substeps.slice(1);
		overflowCount += 1;
	}
	newSubsteps = [...newSubsteps, { label, completed: false, startTime: Date.now(), ...(toolCallId ? { toolCallId } : {}) }];

	const newSteps = steps.map((s, i) => i === currentStep ? { ...s, substeps: newSubsteps, overflowCount } : s);
	const wasErrored = state.errored;
	return { ...state, steps: newSteps, ...(wasErrored ? { errored: false, errorMessage: undefined } : {}) };
}

/**
 * Complete the active (first uncompleted) substep of the current step.
 * In the new model, substeps are parsed upfront in order; the first uncompleted is the active one.
 */
export function completeLastSubstep(state: ActivityFeedState, outputPreview?: string, isError?: boolean): ActivityFeedState {
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
		return { ...sub, completed: true, errored: isError === true, endTime: now, ...(outputPreview ? { outputPreview } : {}) };
	});
	const newSteps = state.steps.map((s, i) => i === state.currentStep ? { ...s, substeps: newSubsteps } : s);
	const wasErrored = state.errored;
	return { ...state, steps: newSteps, ...(wasErrored ? { errored: false, errorMessage: undefined } : {}) };
}

export function completeSubstepByToolCallId(state: ActivityFeedState, toolCallId: string, outputPreview?: string, isError?: boolean): ActivityFeedState {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return state;
	const step = state.steps[state.currentStep];
	if (step.substeps.length === 0) return state;

	// Find substep matching toolCallId
	let targetIdx = -1;
	for (let i = 0; i < step.substeps.length; i++) {
		if (step.substeps[i].toolCallId === toolCallId && !step.substeps[i].completed) {
			targetIdx = i;
			break;
		}
	}
	if (targetIdx < 0) return state;

	const now = Date.now();
	const newSubsteps = step.substeps.map((sub, i) => {
		if (i !== targetIdx) return sub;
		return { ...sub, completed: true, errored: isError === true, endTime: now, ...(outputPreview ? { outputPreview } : {}) };
	});
	const newSteps = state.steps.map((s, i) => i === state.currentStep ? { ...s, substeps: newSubsteps } : s);
	const wasErrored = state.errored;
	return { ...state, steps: newSteps, ...(wasErrored ? { errored: false, errorMessage: undefined } : {}) };
}

/**
 * Complete the active substep and rename its label (e.g. pending "Clarify: ..." -> completed "Clarified: ...").
 */
export function completeActiveSubstepWithLabel(state: ActivityFeedState, label: string, outputPreview?: string, isError?: boolean, isReport?: boolean): ActivityFeedState {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return state;
	const step = state.steps[state.currentStep];
	if (step.substeps.length === 0) return state;

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
		return { ...sub, label, completed: true, errored: isError === true, endTime: now, ...(outputPreview ? { outputPreview } : {}), ...(isReport ? { isReport: true } : {}) };
	});
	const newSteps = state.steps.map((s, i) => i === state.currentStep ? { ...s, substeps: newSubsteps } : s);
	const wasErrored = state.errored;
	return { ...state, steps: newSteps, ...(wasErrored ? { errored: false, errorMessage: undefined } : {}) };
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

/**
 * Immutably set outputPreview on the active (first uncompleted) substep of the current step.
 * Unlike completeLastSubstep, this does NOT mark the substep completed.
 * Returns new state — does NOT mutate in place.
 */
export function updateActiveSubstepOutput(state: ActivityFeedState, outputPreview: string): ActivityFeedState {
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

	const newSubsteps = step.substeps.map((sub, i) =>
		i === activeIdx ? { ...sub, outputPreview } : sub
	);
	const newSteps = state.steps.map((s, i) =>
		i === state.currentStep ? { ...s, substeps: newSubsteps } : s
	);
	return { ...state, steps: newSteps };
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
	return { ...state, steps: newSteps, currentStep: state.currentStep + 1, errored: false, errorMessage: undefined };
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
			return `bash: ${cmd.slice(0, 100)}`;
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
		case "ask_orchestrator": {
			const q = (input?.question || "").trim();
			return `Clarify: ${q ? q.slice(0, 80) + (q.length > 80 ? "..." : "") : "question"}`;
		}
		case "lint":
			return `Linting ${normalizePath(input?.path || "files")}`;
		case "typecheck":
			return `Type checking...`;
		case "web_search": {
			const queries = Array.isArray(input?.queries) && input.queries.length > 0
				? input.queries.filter((q: unknown) => typeof q === "string")
				: typeof input?.query === "string" ? [input.query] : [];
			if (queries.length === 0) return "Search web: (no query)";
			const first = queries[0].slice(0, 200);
			const label = `Search web: "${first}"`;
			return queries.length > 1 ? `${label} (${queries.length} queries)` : label;
		}
		case "fetch_content": {
			const urls = Array.isArray(input?.urls) && input.urls.length > 0
				? input.urls.filter((u: unknown) => typeof u === "string")
				: typeof input?.url === "string" ? [input.url] : [];
			if (urls.length === 0) return "Fetch URL: (no URL)";
			const first = urls[0].replace(/^https?:\/\//, "").slice(0, 200);
			const label = `Fetch URL: ${first}`;
			return urls.length > 1 ? `${label} (+${urls.length - 1} more)` : label;
		}
		default:
			return `Calling ${toolName}...`;
	}
}

/**
 * Returns multi-line tool_detail for multi-item tool calls (queries[], urls[]).
 * Returns undefined for single-item calls (default: reuse substep label as tool_detail).
 * Each line is separated by \n for multi-line rendering in the activity feed.
 */
export function substepToolDetail(toolName: string, input: unknown): string | undefined {
	const MAX_DETAIL = 3;
	switch (toolName) {
		case "web_search": {
			const queries = Array.isArray((input as any)?.queries)
				? (input as any).queries.filter((q: unknown) => typeof q === "string")
				: [];
			if (queries.length <= 1) return undefined;
			const extra = queries.slice(1, MAX_DETAIL + 1);
			const lines = extra.map((q: string, i: number) => `Query ${i + 2}: "${q}"`);
			if (queries.length > MAX_DETAIL + 1) {
				lines.push(`+${queries.length - MAX_DETAIL - 1} more queries`);
			}
			return lines.join("\n");
		}
		case "fetch_content": {
			const urls = Array.isArray((input as any)?.urls)
				? (input as any).urls.filter((u: unknown) => typeof u === "string")
				: [];
			if (urls.length <= 1) return undefined;
			const extra = urls.slice(1, MAX_DETAIL + 1);
			const lines = extra.map((u: string, i: number) => `URL ${i + 2}: ${u.replace(/^https?:\/\//, "")}`);
			if (urls.length > MAX_DETAIL + 1) {
				lines.push(`+${urls.length - MAX_DETAIL - 1} more URLs`);
			}
			return lines.join("\n");
		}
	}
	return undefined;
}

/**
 * Enriches a web_search substep label with results count on completion.
 * Input:  "Search web: \"query\" (3 queries)"
 * Output: "Search web: \"query\" (3 queries, 15 results)"
 * Input:  "Search web: \"query\""
 * Output: "Search web: \"query\" (5 results)"
 */
export function appendWebSearchResults(label: string, totalResults: number): string {
	const match = label.match(/\((\d+) queries\)$/);
	if (match) {
		return label.replace(/\(\d+ queries\)$/, `(${match[1]} queries, ${totalResults} results)`);
	}
	return `${label} (${totalResults} results)`;
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
		lines.push(`    ${getTheme().fg("dim", "…")} +${hidden} more`);
	}
	for (const sub of visible) {
		if (sub.completed) {
			if (sub.isReport) {
				lines.push(sub.label.startsWith("Clarified:") ? `    ${statusIcon("completed")} ${sub.label}` : `    ${statusIcon("completed")} Report: ${sub.label}`);
			} else {
				const label = sub.label.startsWith("Reading ") ? "Read " + sub.label.slice(8) : sub.label;
				lines.push(`    ${statusIcon("completed")} ${label}`);
			}
		} else {
			const label = sub.label.startsWith("Running: ") ? sub.label.slice(9) : sub.label;
			lines.push(`    ${statusIcon("running")} ${label}`);
		}
	}
	return lines;
}

/**
 * Render activity feed in canonical format per SPEC-UI.md.
 * Produces the exact hierarchical view with progress dots, steps, substeps, and tool detail.
 */
export function renderActivityFeed(_name: string, state: ActivityFeedState, goalOverride?: string, renderDepth = 0): string {

	// Snapshot currentStep atomically at render start
	const _currentStep = state.currentStep;

	if (state.errored) {
		const rawMsg = state.errorMessage;
		const msg = (rawMsg && rawMsg.trim().length > 0 && rawMsg !== '""' && rawMsg !== '"') ? rawMsg : null;
		const retryCount = (state as any).retryCount;
		if (retryCount) {
			const reason = (state as any).retryReason || msg || "Error";
			return `${getTheme().fg("warning", styledSymbol("status.warning"))} Retry ${retryCount}/3: ${reason}`;
		}
		// Render step tree with errored step showing ✗ instead of early return
		const errorLines: string[] = [];
		const total = state.steps.length;
		const completed = state.steps.filter((s) => s.completed).length;

		// Goal line — use goalOverride if provided
		const displayGoal = goalOverride ?? state.goal;
		if (displayGoal) {
			errorLines.push(`${styledSymbol("icon.goal")} ${displayGoal}`);
		}

		if (total > 0) {
			// Progress dots row: ● for completed, ✗ for errored step, ○ for pending
			let dots = "";
			for (let i = 0; i < total; i++) {
				if (state.steps[i].completed) {
					dots += styledSymbol("status.done");
				} else if (i === _currentStep) {
					dots += styledSymbol("status.error");
				} else {
					dots += styledSymbol("status.pending");
				}
			}
			errorLines.push(`${dots} ${completed}/${total}`);

			// Render each step
			for (let i = 0; i < total; i++) {
				const step = state.steps[i];
				const isErrored = i === _currentStep;
				const isPending = !step.completed && !isErrored;

				if (step.completed) {
					const duration = step.startTime && step.endTime
						? thFormatDuration(step.endTime - step.startTime)
						: "";
					const summary = `  ${statusIcon("completed")} Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`;
					errorLines.push(summary);
					// Show Report: substeps under completed steps (Collapse Not Erase)
					for (const sub of step.substeps) {
						if (sub.isReport) {
							errorLines.push(
								sub.label.startsWith("Clarified:")
									? `    ${statusIcon("completed")} ${sub.label}`
									: `    ${statusIcon("completed")} Report: ${sub.label}`
							);
						}
					}
				} else if (isErrored) {
					const duration = step.startTime
						? thFormatDuration(Date.now() - step.startTime)
						: "";
					errorLines.push(`  ${statusIcon("error")} Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`);
					if (step.overflowCount && step.overflowCount > 0) {
						errorLines.push(`    ${getTheme().fg("dim", "…")} +${step.overflowCount} more`);
					}
					let foundActive = false;
					for (const sub of step.substeps) {
						if (sub.completed) {
							if (sub.errored) {
								errorLines.push(`    ${getTheme().fg("warning", styledSymbol("status.warning"))} ${sub.label}`);
								if (sub.outputPreview) {
									errorLines.push(`      ${sub.outputPreview}`);
								}
							} else if (sub.isReport) {
								errorLines.push(
									sub.label.startsWith("Clarified:")
										? `    ${statusIcon("completed")} ${sub.label}`
										: `    ${statusIcon("completed")} Report: ${sub.label}`
								);
							} else {
								errorLines.push(`    ${statusIcon("completed")} ${sub.label}`);
							}
						} else if (!foundActive) {
							foundActive = true;
							errorLines.push(`    ${statusIcon("error")} ${sub.label}`);
						} // else: pending substeps after active one — not shown
					}
					const pendingCount = step.substeps.filter(s => !s.completed).length - (foundActive ? 1 : 0);
					if (pendingCount > 0) {
						errorLines.push(`    ${statusIcon("pending")} +${pendingCount} pending`);
					}
					if (msg && !foundActive) {
						errorLines.push(`    ${getTheme().fg("warning", styledSymbol("status.warning"))} ${msg}`);
					}
				} else if (isPending) {
					errorLines.push(`  ${statusIcon("pending")} Step ${i + 1}: ${step.label}`);
				}
			}
		} else {
			// No steps yet — just show error message
			errorLines.push(`  ${statusIcon("error")} ${msg}`);
		}

		return errorLines.join("\n");
	}

	const lines: string[] = [];
	const total = state.steps.length;
	const completed = state.steps.filter((s) => s.completed).length;
	// Goal line — use goalOverride if provided
	const displayGoal = goalOverride ?? state.goal;
	if (displayGoal) {
		lines.push(`${styledSymbol("icon.goal")} ${displayGoal}`);
	}

	// No steps yet — show working indicator
	if (total === 0) {
		lines.push(`  ${statusIcon("running")} Working...`);
		return lines.join("\n");
	}

	// Progress dots row: ●○○ N/M
	{
		let dots = "";
		for (let i = 0; i < total; i++) {
			if (state.steps[i].completed) {
				dots += styledSymbol("status.done");
			} else if (i === _currentStep) {
				// Blink: sync with 80ms spinner frame
				dots += (Math.floor(Date.now() / 1000) % 2 === 0) ? styledSymbol("status.pending") : styledSymbol("status.done");
			} else {
				dots += styledSymbol("status.pending");
			}
		}
		lines.push(`${dots} ${completed}/${total}`);
	}

	// Render each step
	for (let i = 0; i < total; i++) {
		const step = state.steps[i];
		const isCurrent = i === _currentStep;
		const isPending = !step.completed && !isCurrent;

		if (step.completed) {
			const duration = step.startTime && step.endTime
				? thFormatDuration(step.endTime - step.startTime)
				: "";
			const summary = `  ${statusIcon("completed")} Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`;
			lines.push(summary);
			// Show Report: substeps under completed steps (Collapse Not Erase)
			for (const sub of step.substeps) {
				if (sub.isReport) {
					lines.push(
						sub.label.startsWith("Clarified:")
							? `    ${statusIcon("completed")} ${sub.label}`
							: `    ${statusIcon("completed")} Report: ${sub.label}`
					);
				}
			}
		} else if (isCurrent) {
			// Active step:  <spinner> Step N: <label> (no duration)
			lines.push(`  ${statusIcon("running")} Step ${i + 1}: ${step.label}`);
			// Render substeps: completed first, then active, then pending
			if (step.overflowCount && step.overflowCount > 0) {
				lines.push(`    ${getTheme().fg("dim", "…")} +${step.overflowCount} more`);
			}
			let foundActive = false;
			for (const sub of step.substeps) {
				if (sub.completed) {
					if (sub.errored) {
						lines.push(`    ${getTheme().fg("warning", styledSymbol("status.warning"))} ${sub.label}`);
						if (sub.outputPreview) {
							lines.push(`      ${sub.outputPreview}`);
						}
					} else if (sub.isReport) {
						lines.push(
							sub.label.startsWith("Clarified:")
								? `    ${statusIcon("completed")} ${sub.label}`
								: `    ${statusIcon("completed")} Report: ${sub.label}`
						);
					} else {
						lines.push(`    ${statusIcon("completed")} ${sub.label}`);
					}
				} else if (!foundActive) {
					foundActive = true;
					// Active substep
					lines.push(`    ${statusIcon("running")} ${sub.label}`);
					// Tool detail (ephemeral, only for active substep)
					// Supports multi-line (\n-separated) for multi-item tool calls
					if (sub.toolDetail) {
						const detailLines = sub.toolDetail.split("\n");
						for (let di = 0; di < detailLines.length; di++) {
							// Single-line keeps "Running:" prefix; multi-line renders without prefix
							const prefix = detailLines.length === 1 ? "Running: " : "";
							lines.push(`        ${statusIcon("running")} ${prefix}${detailLines[di]}`);
						}
					}
				} else {
					// Pending substep
					lines.push(`    ${statusIcon("pending")} ${sub.label}`);
				}
			}

		} else if (isPending) {
			// Pending step:  ○ Step N: <label>
			lines.push(`  ${statusIcon("pending")} Step ${i + 1}: ${step.label}`);
		}
	}

	// Guard: if state changed during render, re-render (up to MAX_RENDER_RETRIES)
	if (renderDepth < MAX_RENDER_RETRIES && state.currentStep !== _currentStep) {
		return renderActivityFeed(_name, state, goalOverride, renderDepth + 1);
	}

	return lines.join("\n");
}

export const renderProgress = renderActivityFeed;

// ============================================================================
// Inspection — debug helper to inspect feed state
// ============================================================================

export function inspectFeedState(feed: ActivityFeedState): Record<string, unknown> {
    return {
        goal: feed.goal,
        currentStep: feed.currentStep,
        totalSteps: feed.steps.length,
        completedSteps: feed.steps.filter(s => s.completed).length,
        errored: feed.errored ?? false,
        errorMessage: feed.errorMessage ?? null,
        activeStep: feed.currentStep >= 0 && feed.currentStep < feed.steps.length
            ? {
                label: feed.steps[feed.currentStep].label,
                completed: feed.steps[feed.currentStep].completed,
                substeps: feed.steps[feed.currentStep].substeps.map(sub => ({
                    label: sub.label,
                    completed: sub.completed,
                    hasOutputPreview: sub.outputPreview !== undefined && sub.outputPreview !== "",
                    hasToolDetail: !!sub.toolDetail,
                    isReport: sub.isReport ?? false,
                })),
            }
            : null,
        retryCount: feed.retryCount ?? 0,
        retryReason: feed.retryReason ?? null,
    };
}

export function snapshotFeedRender(feed: ActivityFeedState): string {
    return renderActivityFeed("snapshot", feed);
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
// ActivityFeed class — encapsulates mutable feed state
// ============================================================================

/**
 * ActivityFeed — instance-based wrapper around the feed state machine.
 * All mutating methods return `this` for chaining.
 * Replaces module-level mutable state and AskOrchestratorFeedApi pattern.
 */
export class ActivityFeed {
	private state: ActivityFeedState;
	private snapshot: string | null = null;

	constructor() {
		this.state = createActivityFeed();
	}

	addStep(label: string): this {
		this.state = addStep(this.state, label);
		return this;
	}

	addSubstep(label: string, toolCallId?: string): this {
		this.state = addSubstep(this.state, label, toolCallId);
		return this;
	}

	setToolDetail(detail: string): this {
		this.state = setToolDetail(this.state, detail);
		return this;
	}

	clearToolDetail(): this {
		this.state = clearToolDetail(this.state);
		return this;
	}

	completeLastSubstep(outputPreview?: string, isError?: boolean): this {
		this.state = completeLastSubstep(this.state, outputPreview, isError);
		return this;
	}

	completeSubstepByToolCallId(toolCallId: string, outputPreview?: string, isError?: boolean): this {
		this.state = completeSubstepByToolCallId(this.state, toolCallId, outputPreview, isError);
		return this;
	}

	completeActiveSubstepWithLabel(label: string, outputPreview?: string, isError?: boolean, isReport?: boolean): this {
		this.state = completeActiveSubstepWithLabel(this.state, label, outputPreview, isError, isReport);
		return this;
	}

	completeCurrentStep(): this {
		this.state = completeCurrentStep(this.state);
		return this;
	}

	markFeedError(message: string): this {
		this.state = markFeedError(this.state, message);
		return this;
	}

	updateActiveSubstepOutput(outputPreview: string): this {
		this.state = updateActiveSubstepOutput(this.state, outputPreview);
		return this;
	}

	render(specialistName?: string, goalOverride?: string): string {
		return renderActivityFeed(specialistName ?? "", this.state, goalOverride);
	}

	inspectState(): Record<string, unknown> | null {
		return inspectFeedState(this.state);
	}

	snapshotRender(): string {
		return snapshotFeedRender(this.state);
	}

	appendWebSearchResults(results: any[]): this {
		for (const step of this.state.steps) {
			for (const sub of step.substeps) {
				if (!sub.completed && sub.label && results?.length) {
					const total = results.length;
					this.state = completeActiveSubstepWithLabel(
						this.state,
						appendWebSearchResults(sub.label, total),
						undefined,
						false,
					);
					break;
				}
			}
		}
		return this;
	}

	compressOutput(output: string): string {
		return compressOutput(output);
	}

	static fromPlanSteps(steps: PlanStep[], goal: string): ActivityFeed {
		const feed = new ActivityFeed();
		feed.state = {
			...feed.state,
			goal,
			steps: steps.map((s) => ({
				label: s.label,
				completed: s.completed,
				substeps: [],
				startTime: s.startTime ?? Date.now(),
				endTime: s.endTime,
			})),
			currentStep: steps.length > 0 ? 0 : -1,
			planParsed: true,
		};
		return feed;
	}

	/** Convenience read-only accessors for common state properties. */
	get steps(): Step[] {
		return this.state.steps;
	}

	get currentStep(): number {
		return this.state.currentStep;
	}

	get goal(): string {
		return this.state.goal;
	}

	get errored(): boolean | undefined {
		return this.state.errored;
	}

	get errorMessage(): string | undefined {
		return this.state.errorMessage;
	}

	get feedState(): ActivityFeedState {
		return this.state;
	}

	set feedState(val: ActivityFeedState) {
		this.state = val;
	}

	get planParsed(): boolean {
		return this.state.planParsed ?? false;
	}

	set planParsed(val: boolean) {
		this.state = { ...this.state, planParsed: val };
	}
}
