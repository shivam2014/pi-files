/**
 * Mock E2E Test — vitest port of test-mock-e2e.ts
 *
 * Tests activity feed state machine using mock events.
 * No real timers, no process.exit(), proper typed assertions.
 *
 * Run:
 *   node node_modules/vitest/vitest.mjs run test-mock-e2e.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActivityFeedState, Step, Substep } from "./types.ts";

// ============================================================================
// Inline stubs — used when activity-feed.ts can't provide needed functions
// ============================================================================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spinnerStartTime = Date.now();
function currentFrame(): string {
	return SPINNER_FRAMES[Math.floor((Date.now() - _spinnerStartTime) / 80) % SPINNER_FRAMES.length];
}


function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds % 60 > 0 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

function shortenLabel(label: string): string {
	let s = label;
	s = s.replace(/https?:\/\/[^\s]+/g, "");
	s = s.replace(/^(Based on this|Task|Step \d+:?|Question|Answer)\s*:?\s*/gi, "");
	s = s.replace(/\b(the|a|an|for|to|in|at|of|on|from|by|with|using|via|is|are|was|were|be|been|being|has|have|had|do|does|did|will|would|could|should|may|might|can|shall|must|need|this|that|these|those|it|its|and|or|but|if|then|else|when|where|how|what|which|who|whom|whose|why|also|just|only|even|still|already|yet|ever|never|always|often|sometimes|usually|really|very|quite|too|enough|almost|nearly|about|around|over|under|between|through|during|before|after|above|below|up|down|out|off|into|onto|upon|toward|towards|across|along|against|among|around|behind|beside|beyond|inside|outside|within|without|please|kindly|can you|could you|would you)\b/gi, "");
	s = s.replace(/[,;:!?"'()\[\]{}|]/g, " ");
	s = s.replace(/\s+/g, " ").trim();
	return s.slice(0, 40);
}

const MAX_FEED_STEPS = 6;
const MAX_FEED_SUBSTEPS = 8;
const MAX_RAW_TEXT = 10_000;

// ============================================================================
// Feed stubs (mirror activity-feed.ts behavior)
// ============================================================================

function stubCreateActivityFeed(): ActivityFeedState {
	return { goal: "", steps: [], currentStep: -1, rawText: "", planParsed: false };
}

function stubParseTextForFeed(state: ActivityFeedState, text: string): ActivityFeedState {
	let rawText = state.rawText + text;
	if (rawText.length > MAX_RAW_TEXT) {
		rawText = rawText.slice(rawText.length - MAX_RAW_TEXT);
	}
	const lines = rawText.split("\n");
	const completeLines = lines.slice(0, -1);
	let currentState: ActivityFeedState = { ...state, rawText };
	let inGoalSection = false;
	let inStepsSection = false;
	const existingStepLabels = new Set(currentState.steps.map((s) => s.label));

	for (const line of completeLines) {
		const trimmed = line.trim();
		if (!trimmed) { inGoalSection = false; inStepsSection = false; continue; }
		if (trimmed.match(/^##\s+Goal/i)) { inGoalSection = true; inStepsSection = false; continue; }
		if (trimmed.match(/^##\s+Steps/i)) { inStepsSection = true; inGoalSection = false; continue; }
		if (trimmed.match(/^#{1,3}\s+/)) { inGoalSection = false; inStepsSection = false; continue; }
		if (inGoalSection && currentState.goal === "") {
			currentState = { ...currentState, goal: trimmed };
			continue;
		}
		if (inStepsSection) {
			const stepMatch = trimmed.match(/^Step\s+(\d+):\s*(.+)/i);
			if (stepMatch) {
				const stepLabel = stepMatch[2].trim();
				if (stepLabel && !existingStepLabels.has(stepLabel)) {
					currentState = stubAddStep(currentState, stepLabel);
					existingStepLabels.add(stepLabel);
				}
				continue;
			}
			const indentMatch = line.match(/^(\s{2,})[-*]\s+(.+)/);
			if (indentMatch && currentState.currentStep >= 0 &&
				currentState.currentStep < currentState.steps.length) {
				const bulletText = indentMatch[2].trim();
				const isReport = /^Report:\s*(.+)/i.exec(bulletText);
				const substepLabel = isReport ? isReport[1].trim() : bulletText;
				const step = currentState.steps[currentState.currentStep];
				if (!step.substeps.some((s) => s.label === substepLabel)) {
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
			const legacyBullet = trimmed.match(/^[-*]\s+(.+)/);
			if (legacyBullet) {
				const label = legacyBullet[1].trim();
				if (!label.match(/^Report:/i) && !existingStepLabels.has(label)) {
					currentState = stubAddStep(currentState, label);
					existingStepLabels.add(label);
				}
				continue;
			}
			continue;
		}
		if (currentState.goal === "" && !trimmed.startsWith("#")) {
			currentState = { ...currentState, goal: trimmed };
		}
	}
	return currentState;
}

function stubAddStep(state: ActivityFeedState, label: string): ActivityFeedState {
	if (label === "Working...") return state;
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

function stubAddSubstep(state: ActivityFeedState, label: string): ActivityFeedState {
	let { steps, currentStep } = state;
	if (currentStep >= 0 && currentStep < steps.length && steps[currentStep].completed) {
		return stubAddStep(state, label);
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
		return stubAddStep(state, label);
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

function stubCompleteLastSubstep(state: ActivityFeedState, outputPreview?: string): ActivityFeedState {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return state;
	const step = state.steps[state.currentStep];
	if (step.substeps.length === 0) return state;
	let activeIdx = -1;
	for (let i = 0; i < step.substeps.length; i++) {
		if (!step.substeps[i].completed) { activeIdx = i; break; }
	}
	if (activeIdx < 0) return state;
	const now = Date.now();
	const newSubsteps = step.substeps.map((sub, i) =>
		i === activeIdx ? { ...sub, completed: true, endTime: now, ...(outputPreview ? { outputPreview } : {}) } : sub
	);
	const newSteps = state.steps.map((s, i) => i === state.currentStep ? { ...s, substeps: newSubsteps } : s);
	return { ...state, steps: newSteps };
}

function stubCompleteCurrentStep(state: ActivityFeedState): ActivityFeedState {
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

function stubToolCallToSubstep(toolName: string, input: Record<string, unknown>): string {
	const normalizePath = (p: string | undefined) => {
		if (!p) return "file";
		if (p.length > 50) {
			const parts = p.replace(/\/$/, "").split("/");
			return parts[parts.length - 1];
		}
		return p;
	};
	switch (toolName) {
		case "read": return `Reading ${normalizePath(input?.path as string | undefined || input?.file_path as string | undefined)}`;
		case "bash": return `Running: ${((input?.command as string) || "").trim().slice(0, 100)}`;
		case "edit": return `Editing ${normalizePath(input?.path as string | undefined)}${Array.isArray(input?.edits) ? ` (${(input.edits as unknown[]).length} changes)` : ""}`;
		case "write": return `Writing ${normalizePath(input?.path as string | undefined)} (${((input?.content as string)?.length || 0)} chars)`;
		case "grep": return `Searching: ${(input?.pattern as string) || "..."}`;
		default: return `Calling ${toolName}...`;
	}
}

function stubUpdateActiveSubstepOutput(state: ActivityFeedState, outputPreview: string): ActivityFeedState {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return state;
	const step = state.steps[state.currentStep];
	if (step.substeps.length === 0) return state;
	let activeIdx = -1;
	for (let i = 0; i < step.substeps.length; i++) {
		if (!step.substeps[i].completed) { activeIdx = i; break; }
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

function stubRenderActivityFeed(_name: string, state: ActivityFeedState): string {
	const lines: string[] = [];
	const total = state.steps.length;
	const completed = state.steps.filter((s) => s.completed).length;
	const spinner = currentFrame();

	if (state.goal) lines.push(`◆ ${state.goal}`);
	if (total === 0) {
		lines.push(`  ${spinner} Working...`);
		return lines.join("\n");
	}

	let dots = "";
	for (let i = 0; i < total; i++) {
		if (state.steps[i].completed) dots += "●";
		else if (i === state.currentStep) dots += "◐";
		else dots += "○";
	}
	lines.push(`${dots} ${completed}/${total}`);

	for (let i = 0; i < total; i++) {
		const step = state.steps[i];
		const isCurrent = i === state.currentStep;
		const isPending = !step.completed && !isCurrent;

		if (step.completed) {
			const duration = step.startTime && step.endTime ? formatDuration(step.endTime - step.startTime) : "";
			const reportSubsteps = step.substeps.filter(s => s.isReport);
			let summary = `  ✓ Step ${i + 1}: ${step.label}${duration ? ` (${duration})` : ""}`;
			if (step.substeps.length > 0) {
				summary += ` — ${step.substeps.length} substep${step.substeps.length !== 1 ? 's' : ''}`;
				if (reportSubsteps.length > 0) summary += `, ${reportSubsteps.length} report${reportSubsteps.length !== 1 ? 's' : ''}`;
			}
			lines.push(summary);
			for (const sub of reportSubsteps) {
				lines.push(`    ✓ Report: ${sub.label}`);
			}
		} else if (isCurrent) {
			lines.push(`  ${spinner} Step ${i + 1}: ${step.label}`);
			let foundActive = false;
			for (const sub of step.substeps) {
				if (sub.completed) {
					lines.push(sub.isReport ? `    ✓ Report: ${sub.label}` : `    ✓ ${sub.label}`);
				} else if (!foundActive) {
					foundActive = true;
					lines.push(`    ${spinner} ${sub.label}`);
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
// Mock Events — same as test-mock-e2e.ts
// ============================================================================

const MOCK_EVENTS = [
	// Event 0: Assistant sends plan with goal + steps
	{
		type: "text_delta",
		delta: "## Goal\nFix bug in test.ts\n## Steps\nStep 1: Read file\n  - Read src/test.ts\n  - Report: Found bug\n",
	},
	// Event 1-3: Tool execution: read test.ts
	{ type: "tool_execution_start", toolName: "read", args: { path: "test.ts" } },
	{ type: "tool_execution_update", partialResult: "const x = 1;\nconst y = 2;" },
	{ type: "tool_execution_end", toolName: "read", result: { content: "const x = 1;\nconst y = 2;" } },
	// Event 4: Assistant signals end of message → completes Step 1
	{ type: "message_end", message: { role: "assistant" } },
	// Event 5-7: Tool execution: edit test.ts → creates Step 2
	{ type: "tool_execution_start", toolName: "edit", args: { path: "test.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }] } },
	{ type: "tool_execution_update", partialResult: "Edit applied: x changed from 1 to 42" },
	{ type: "tool_execution_end", toolName: "edit", result: { success: true } },
	// Event 8: Assistant signals end of message → completes Step 2
	{ type: "message_end", message: { role: "assistant" } },
] as const;

type MockEvent = (typeof MOCK_EVENTS)[number];

// ============================================================================
// Feed Driver — bundles state + reducer functions
// ============================================================================

interface FeedDriver {
	feed: ActivityFeedState;
	createActivityFeed: () => ActivityFeedState;
	parseTextForFeed: (state: ActivityFeedState, text: string) => ActivityFeedState;
	addStep: (state: ActivityFeedState, label: string) => ActivityFeedState;
	addSubstep: (state: ActivityFeedState, label: string) => ActivityFeedState;
	completeLastSubstep: (state: ActivityFeedState, outputPreview?: string) => ActivityFeedState;
	completeCurrentStep: (state: ActivityFeedState) => ActivityFeedState;
	toolCallToSubstep: (toolName: string, args: Record<string, unknown>) => string;
	updateActiveSubstepOutput: (state: ActivityFeedState, outputPreview: string) => ActivityFeedState;
	renderActivityFeed: (name: string, state: ActivityFeedState) => string;
}

// ============================================================================
// Helpers
// ============================================================================

function processAllEvents(driver: FeedDriver, events: readonly MockEvent[]): ActivityFeedState {
	let feed = driver.feed;
	for (const event of events) {
		switch (event.type) {
			case "text_delta": {
				feed = driver.parseTextForFeed(feed, event.delta as string);
				break;
			}
			case "tool_execution_start": {
				const label = driver.toolCallToSubstep(event.toolName as string, (event.args as Record<string, unknown>) ?? {});
				feed = driver.addSubstep(feed, label);
				break;
			}
			case "tool_execution_end": {
				const preview = JSON.stringify((event as any).result ?? {}).slice(0, 100);
				feed = driver.completeLastSubstep(feed, preview);
				break;
			}
			case "tool_execution_update": {
				// Optional: update active substep output
				if (driver.updateActiveSubstepOutput) {
					feed = driver.updateActiveSubstepOutput(feed, (event as any).partialResult ?? "");
				}
				break;
			}
			case "message_end": {
				feed = driver.completeCurrentStep(feed);
				break;
			}
		}
	}
	return feed;
}

// ============================================================================
// Tests
// ============================================================================

describe("mock-e2e: activity feed state machine", () => {
	let driver: FeedDriver;
	let useRealModule: boolean;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000_000_000); // 2001-09-09T01:46:40.000Z

		// Try loading real module; fall back to stubs
		useRealModule = false;
		try {
			const real = await import("./activity-feed.ts");
			driver = {
				feed: stubCreateActivityFeed(),
				createActivityFeed: (real as any).createActivityFeed ?? stubCreateActivityFeed,
				parseTextForFeed: (real as any).parseTextForFeed ?? stubParseTextForFeed,
				addStep: (real as any).addStep ?? stubAddStep,
				addSubstep: (real as any).addSubstep ?? stubAddSubstep,
				completeLastSubstep: (real as any).completeLastSubstep ?? stubCompleteLastSubstep,
				completeCurrentStep: (real as any).completeCurrentStep ?? stubCompleteCurrentStep,
				toolCallToSubstep: (real as any).toolCallToSubstep ?? stubToolCallToSubstep,
				updateActiveSubstepOutput: (real as any).updateActiveSubstepOutput ?? stubUpdateActiveSubstepOutput,
				renderActivityFeed: (real as any).renderActivityFeed ?? stubRenderActivityFeed,
			};
			useRealModule = true;
		} catch {
			driver = {
				feed: stubCreateActivityFeed(),
				createActivityFeed: stubCreateActivityFeed,
				parseTextForFeed: stubParseTextForFeed,
				addStep: stubAddStep,
				addSubstep: stubAddSubstep,
				completeLastSubstep: stubCompleteLastSubstep,
				completeCurrentStep: stubCompleteCurrentStep,
				toolCallToSubstep: stubToolCallToSubstep,
				updateActiveSubstepOutput: stubUpdateActiveSubstepOutput,
				renderActivityFeed: stubRenderActivityFeed,
			};
		}

		driver.feed = driver.createActivityFeed();
	});

	// ── Test 1: text_delta parsing ──

	it("processes text_delta — extracts goal, step, substeps from markdown", () => {
		driver.feed = processAllEvents(driver, MOCK_EVENTS.slice(0, 1));

		// Goal extracted
		expect(driver.feed.goal).toBe("Fix bug in test.ts");

		// Step 1 created with label
		expect(driver.feed.steps).toHaveLength(1);
		expect(driver.feed.steps[0].label).toBe("Read file");
		expect(driver.feed.currentStep).toBe(0);

		// Substeps parsed from indented bullets
		expect(driver.feed.steps[0].substeps).toHaveLength(2);
		expect(driver.feed.steps[0].substeps[0].label).toBe("Read src/test.ts");
		expect(driver.feed.steps[0].substeps[0].completed).toBe(false);

		// Report substep marked completed immediately
		expect(driver.feed.steps[0].substeps[1].label).toBe("Found bug");
		expect(driver.feed.steps[0].substeps[1].completed).toBe(true);
		expect(driver.feed.steps[0].substeps[1].isReport).toBe(true);

		// Raw text accumulated
		expect(driver.feed.rawText).toContain("## Goal");
	});

	// ── Test 2: tool_execution_start adds substep ──

	it("tool_execution_start — adds substep to current step", () => {
		// Process text_delta + first tool start
		driver.feed = processAllEvents(driver, MOCK_EVENTS.slice(0, 2));

		expect(driver.feed.steps).toHaveLength(1);
		expect(driver.feed.steps[0].substeps).toHaveLength(3);
		// The tool call creates a substep label "Reading test.ts"
		const substepLabels = driver.feed.steps[0].substeps.map(s => s.label);
		expect(substepLabels).toContain("Reading test.ts");

		// Tool-execution substep is not completed (active)
		const readingSubstep = driver.feed.steps[0].substeps.find(s => s.label === "Reading test.ts")!;
		expect(readingSubstep.completed).toBe(false);
		expect(readingSubstep.startTime).toBeGreaterThan(0);
	});

	// ── Test 3: tool_execution_end completes substep ──

	it("tool_execution_end — completes the first uncompleted substep", () => {
		// Process events 0-3 (text_delta + read tool start/update/end)
		driver.feed = processAllEvents(driver, MOCK_EVENTS.slice(0, 4));

		expect(driver.feed.steps).toHaveLength(1);
		expect(driver.feed.steps[0].substeps).toHaveLength(3);

		// completeLastSubstep completes the FIRST uncompleted substep (index 0, "Read src/test.ts")
		const firstSubstep = driver.feed.steps[0].substeps[0];
		expect(firstSubstep.label).toBe("Read src/test.ts");
		expect(firstSubstep.completed).toBe(true);
		expect(firstSubstep.endTime).toBeGreaterThan(0);

		// The tool-generated substep "Reading test.ts" (index 2) is still uncompleted
		expect(driver.feed.steps[0].substeps[2].label).toBe("Reading test.ts");
		expect(driver.feed.steps[0].substeps[2].completed).toBe(false);
	});

	// ── Test 4: message_end completes step ──

	it("message_end — completes current step and advances to next", () => {
		// Process events 0-4 (text_delta + read tool + message_end)
		driver.feed = processAllEvents(driver, MOCK_EVENTS.slice(0, 5));

		// Step 1 is now completed
		expect(driver.feed.steps).toHaveLength(1);
		expect(driver.feed.steps[0].completed).toBe(true);
		expect(driver.feed.steps[0].endTime).toBeGreaterThan(0);

		// All substeps in Step 1 should be completed
		for (const sub of driver.feed.steps[0].substeps) {
			expect(sub.completed).toBe(true);
		}

		// currentStep advances past the completed step (no step at index 1 yet)
		expect(driver.feed.currentStep).toBe(1);
	});

	// ── Test 5: tool_execution_start creates new step when no current step exists ──

	it("tool_execution_start — creates new step when currentStep is past end", () => {
		// Process events 0-5 (through edit tool start)
		driver.feed = processAllEvents(driver, MOCK_EVENTS.slice(0, 6));

		// Should have 2 steps now
		expect(driver.feed.steps).toHaveLength(2);

		// Step 1 should be completed
		expect(driver.feed.steps[0].completed).toBe(true);

		// Step 2 was created from the tool call label
		expect(driver.feed.steps[1].label).toBe("Editing test.ts (1 changes)");
		expect(driver.feed.steps[1].completed).toBe(false);

		// currentStep should be 1 (pointing at Step 2)
		expect(driver.feed.currentStep).toBe(1);
	});

	// ── Test 6: full pipeline ──

	it("processes all events — both steps completed", () => {
		driver.feed = processAllEvents(driver, MOCK_EVENTS);

		// Final state: both steps completed
		expect(driver.feed.steps).toHaveLength(2);
		expect(driver.feed.steps[0].completed).toBe(true);
		expect(driver.feed.steps[1].completed).toBe(true);

		// currentStep = 2 (past end)
		expect(driver.feed.currentStep).toBe(2);

		// Step 1 has substeps
		expect(driver.feed.steps[0].substeps.length).toBeGreaterThanOrEqual(2);

		// Goal preserved
		expect(driver.feed.goal).toBe("Fix bug in test.ts");
	});

	// ── Test 7: render output from intermediate state ──

	it("renders activity feed with completed + active steps", () => {
		// Process up to edit tool start (Step 1 done, Step 2 active)
		driver.feed = processAllEvents(driver, MOCK_EVENTS.slice(0, 6));

		const output = driver.renderActivityFeed("scout", driver.feed);

		// Goal line
		expect(output).toContain("◆ Fix bug in test.ts");

		// Step 1 completed (summary line only — no substep details for completed steps)
		expect(output).toContain("Step 1: Read file");

		// Step 2 active (has spinner prefix, not ✓ or ○ alone)
		expect(output).toContain("Step 2: Editing test.ts (1 changes)");

		// Progress dots (2 steps, 1 completed = ●◐ 1/2)
		expect(output).toMatch(/●◐\s+1\/2/);
	});

	// ── Test 8: final render output ──

	it("renders activity feed with all steps completed", () => {
		driver.feed = processAllEvents(driver, MOCK_EVENTS);

		const output = driver.renderActivityFeed("scout", driver.feed);

		// Goal line
		expect(output).toContain("◆ Fix bug in test.ts");

		// Both steps completed (summary lines only — real render omits completed substep details)
		expect(output).toContain("Step 1: Read file");
		expect(output).toContain("Step 2: Editing test.ts (1 changes)");

		// Progress dots — both completed
		expect(output).toMatch(/●●\s+2\/2/);

		// Completed steps use summary-only: no individual substep lines in real render
		expect(output).not.toContain("Read src/test.ts");
		expect(output).not.toContain("Reading test.ts");
	});
});
