/**
 * Unit tests for orchestrator critical fixes.
 * Self-contained — copies functions inline to avoid module resolution issues.
 * Run: npx vitest run test-unit.test.ts
 */
import { describe, it, expect } from "vitest";

// ============================================================================
// Types (inline)
// ============================================================================

interface Substep {
	label: string;
	completed: boolean;
	startTime?: number;
	endTime?: number;
	outputPreview?: string;
}

interface Step {
	label: string;
	completed: boolean;
	substeps: Substep[];
	startTime?: number;
	endTime?: number;
}

interface ActivityFeedState {
	goal: string;
	steps: Step[];
	currentStep: number;
	rawText: string;
	errored?: boolean;
	errorMessage?: string;
}

// ============================================================================
// Constants (from activity-feed.ts)
// ============================================================================

const MAX_FEED_STEPS = 6;
const MAX_FEED_SUBSTEPS = 8;

// ============================================================================
// Inlined functions from activity-feed.ts
// ============================================================================

function createActivityFeed(): ActivityFeedState {
	return {
		goal: "",
		steps: [],
		currentStep: -1,
		rawText: "",
	};
}

function addStep(state: ActivityFeedState, label: string): void {
	if (label === "Working...") return;

	for (let i = 0; i < state.steps.length; i++) {
		const existing = state.steps[i];
		if (
			label.startsWith(existing.label) &&
			label.length > existing.label.length &&
			existing.substeps.length === 0 &&
			!existing.completed
		) {
			state.steps[i] = {
				label,
				completed: false,
				substeps: [],
				startTime: existing.startTime,
			};
			return;
		}
	}

	if (state.steps.some((s) => s.label === label)) return;
	if (state.steps.length >= MAX_FEED_STEPS) {
		// Remove oldest completed step, shift indices
		state.steps.shift();
		if (state.currentStep > 0) state.currentStep--;
	}
	state.steps.push({
		label,
		completed: false,
		substeps: [],
		startTime: Date.now(),
	});
	if (state.currentStep === -1) state.currentStep = 0;
}

function addSubstep(state: ActivityFeedState, label: string): void {
	// If current step is completed or currentStep is past end, create a new step
	if (
		state.currentStep >= 0 &&
		state.currentStep < state.steps.length &&
		state.steps[state.currentStep].completed
	) {
		addStep(state, label);
		return;
	}
	// currentStep past end (after completeCurrentStep) — create new step
	if (state.currentStep >= state.steps.length && state.steps.length > 0) {
		addStep(state, label);
		return;
	}
	if (state.currentStep < 0 || state.steps.length === 0) {
		if (state.steps.length === 0) {
			const stepLabel =
				label.length > 60 ? label.slice(0, 57) + "..." : label;
			state.steps.push({
				label: stepLabel,
				completed: false,
				substeps: [],
				startTime: Date.now(),
			});
			state.currentStep = 0;
		}
	}
	if (
		state.currentStep < 0 ||
		state.currentStep >= state.steps.length
	)
		return;
	const step = state.steps[state.currentStep];
	if (step.substeps.some((s) => s.label === label)) return;
	if (step.substeps.length >= MAX_FEED_SUBSTEPS) {
		step.substeps.shift();
	}
	step.substeps.push({
		label,
		completed: false,
		startTime: Date.now(),
	});
}

function completeCurrentStep(state: ActivityFeedState): void {
	if (
		state.currentStep < 0 ||
		state.currentStep >= state.steps.length
	)
		return;
	for (const sub of state.steps[state.currentStep].substeps) {
		sub.completed = true;
		if (!sub.endTime) sub.endTime = Date.now();
	}
	state.steps[state.currentStep].completed = true;
	state.steps[state.currentStep].endTime = Date.now();
	state.currentStep++;
	// Don't clamp — let currentStep == steps.length so next addSubstep creates a new step
}

// --- parseTextForFeed helpers ---

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

const MAX_RAW_TEXT = 10_000;

function parseTextForFeed(state: ActivityFeedState, text: string): void {
	state.rawText += text;
	if (state.rawText.length > MAX_RAW_TEXT) {
		const excess = state.rawText.length - MAX_RAW_TEXT;
		const firstNewline = state.rawText.indexOf("\n", excess);
		state.rawText =
			firstNewline >= 0
				? state.rawText.slice(firstNewline + 1)
				: state.rawText.slice(excess);
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

// ============================================================================
// Tests
// ============================================================================

describe("addSubstep — creates new step when current is completed", () => {
	it("should create a new step after completing the previous one", () => {
		const feed = createActivityFeed();
		addStep(feed, "Step 1: Read files");
		expect(feed.steps.length).toBe(1);
		expect(feed.currentStep).toBe(0);

		// Complete the step
		completeCurrentStep(feed);
		expect(feed.steps[0].completed).toBe(true);
		expect(feed.currentStep).toBe(1); // points past end

		// addSubstep should create a new step since current is completed
		addSubstep(feed, "Editing file.ts");
		expect(feed.steps.length).toBe(2);
		expect(feed.currentStep).toBe(1);
		expect(feed.steps[1].label).toBe("Editing file.ts");
		expect(feed.steps[1].completed).toBe(false);
		// addSubstep via completed path creates step with label (no substep added yet)
		expect(feed.steps[1].substeps.length).toBe(0);
	});
});

describe("completeCurrentStep — does not clamp", () => {
	it("currentStep == 1 after completing step 0 of 2 steps", () => {
		const feed = createActivityFeed();
		addStep(feed, "Step A");
		addStep(feed, "Step B");
		expect(feed.steps.length).toBe(2);
		expect(feed.currentStep).toBe(0);

		completeCurrentStep(feed);
		expect(feed.steps[0].completed).toBe(true);
		expect(feed.currentStep).toBe(1);
	});

	it("currentStep == 1 after completing the only step (not clamped to 0)", () => {
		const feed = createActivityFeed();
		addStep(feed, "Only step");
		expect(feed.steps.length).toBe(1);
		expect(feed.currentStep).toBe(0);

		completeCurrentStep(feed);
		expect(feed.steps[0].completed).toBe(true);
		expect(feed.currentStep).toBe(1);
	});
});

describe("addStep — shift eviction", () => {
	it("evicts oldest step when exceeding MAX_FEED_STEPS (6)", () => {
		const feed = createActivityFeed();

		// Add 6 steps (at max)
		for (let i = 1; i <= 6; i++) {
			addStep(feed, `Step ${i}`);
		}
		expect(feed.steps.length).toBe(6);
		expect(feed.steps[0].label).toBe("Step 1");
		expect(feed.steps[5].label).toBe("Step 6");

		// Add 7th — should evict oldest
		addStep(feed, "Step 7");
		expect(feed.steps.length).toBe(6);
		expect(feed.steps[0].label).toBe("Step 2");
		expect(feed.steps[5].label).toBe("Step 7");
	});
});

describe("parseTextForFeed — parses ## Steps section", () => {
	it("extracts goal and step labels from formatted text", () => {
		const feed = createActivityFeed();
		const text = [
			"## Goal",
			"Fix the authentication bug",
			"",
			"## Steps",
			"- Read the auth middleware file",
			"- Identify the token validation issue",
			"- Apply the fix",
			"- Run tests to verify",
			"",
		].join("\n");

		parseTextForFeed(feed, text);

		expect(feed.goal).toBe("Fix the authentication bug");
		expect(feed.steps.length).toBe(4);
		expect(feed.steps[0].label).toBe("Read the auth middleware file");
		expect(feed.steps[1].label).toBe("Identify the token validation issue");
		expect(feed.steps[2].label).toBe("Apply the fix");
		expect(feed.steps[3].label).toBe("Run tests to verify");
	});

	it("handles numbered list format", () => {
		const feed = createActivityFeed();
		const text = [
			"## Steps",
			"1. Read config",
			"2. Update dependencies",
			"3. Write tests",
			"",
		].join("\n");

		parseTextForFeed(feed, text);

		expect(feed.steps.length).toBe(3);
		expect(feed.steps[0].label).toBe("Read config");
		expect(feed.steps[1].label).toBe("Update dependencies");
		expect(feed.steps[2].label).toBe("Write tests");
	});
});

// ============================================================================
// Peek overlay exports test
// ============================================================================

describe("peek-overlay — exports are functions", () => {
	it("showPeek, hidePeek, updatePeek, isPeekOpen are exported functions", async () => {
		const mod = await import("./peek-overlay");
		expect(typeof mod.showPeek).toBe("function");
		expect(typeof mod.hidePeek).toBe("function");
		expect(typeof mod.updatePeek).toBe("function");
		expect(typeof mod.isPeekOpen).toBe("function");
	});
});
