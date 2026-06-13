/**
 * ORCHESTRATOR EXTENSION
 * 
 * Design spec: ~/.pi/agent/extensions/ORCHESTRATION-UI-DESIGN.md
 * 
 * Two-layer orchestration visualization:
 * - Layer 1: Orchestration Plan (header) — pinned at top via setHeader()
 * - Layer 2: Subagent Tool Blocks — per-subagent activity feed in chat history
 * 
 * This extension turns pi into a pure orchestrator that delegates all work
 * to specialist subagents. The main agent never touches files directly.
 * 
 * COMPONENTS:
 * 1. Activity Feed System
 *    - Tracks subagent progress for real-time UX display
 *    - Zero token cost (onUpdate not persisted)
 *    - State: ActivityFeedState { goal, steps, currentStep }
 *    - Functions: createActivityFeed, parseTextForFeed, renderActivityFeed
 *    - Format: Task box + progress dots + step list (see design spec Layer 2)
 *    
 * 2. Specialist Definitions
 *    - scout, coder, reviewer, researcher, writer
 *    - Each has: name, tools[], model?, systemPrompt
 *    - systemPrompt includes ACTIVITY_FEED_INSTRUCTION for plan output
 *    
 * 3. In-Process Subagent Runner
 *    - runSubagent(): creates isolated AgentSession
 *    - Uses parent's modelRegistry for API key inheritance
 *    - Subscribes to session events → updates activity feed
 *    
 * 4. Tool Handler
 *    - delegate(specialist, task): one specialist, one step
 * 
 * COMMON ISSUES:
 * - "No API key found" → Check modelRegistry inheritance
 * - Empty output → Check specialist.tools includes needed tools
 * - Feed not updating → Check event types in session.subscribe()
 * - Steps not parsing → Check ## Goal / ## Steps format in prompt
 * 
 * ACTIVITY FEED FLOW:
 * 1. Subagent starts → parseTextForFeed extracts goal + steps
 * 2. tool_call event → addSubstep (auto-detects tool type)
 * 3. tool_result event → completeLastSubstep
 * 4. message_end event → completeCurrentStep, advance to next
 * 5. renderActivityFeed → formats for UI display (see design spec Layer 2)
 */

import { type KnownProvider, getModel } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// @ts-expect-error — @earendil-works/pi-tui not installed in this context
import { Container, type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { shortenLabel } from "../../token-saver.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEBUG_LOG_DIR = "/tmp/orchestrator-debug";
try { mkdirSync(DEBUG_LOG_DIR, { recursive: true }); } catch {}
const DEBUG_LOG = join(DEBUG_LOG_DIR, `orchestrator-${Date.now()}.log`);

function debugLog(msg: string, data?: any): void {
	const line = data ? `[${new Date().toISOString()}] ${msg} ${JSON.stringify(data)}` : `[${new Date().toISOString()}] ${msg}`;
	try { appendFileSync(DEBUG_LOG, line + "\n"); } catch {}
}

// ============================================================================
// Config
// ============================================================================

/**
 * Environment variable guard for subagent detection.
 * process.env survives jiti module reloads (unlike module-level vars).
 * Set in runSubagent() before DefaultResourceLoader.reload().
 */
const SUBAGENT_ENV_KEY = "PI_ORCHESTRATOR_SUBAGENT";
function isSubagentContext(): boolean {
	return process.env[SUBAGENT_ENV_KEY] === "1";
}

/**
 * Module-level orchestrator activity state.
 * Persists across a delegation session.
 * Reset on new session via before_agent_start handler.
 */
/** Depth counter: >0 when loading extensions for a subagent session */
let _batchLoadSubagent = 0;
/** Runtime counter: >0 when a subagent is actively executing tools */
let _inSubagentExecution = 0;

let orchestratorActivity: OrchestratorActivity | null = null;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spinnerIndex = 0;

let orchestratorGoal: string = "";

function getOrchestratorActivity(taskDescription?: string): OrchestratorActivity {
	// Create fresh activity for each new tool call to avoid stale state
	if (!orchestratorActivity) {
		orchestratorActivity = createOrchestratorActivity();
	}
	if (taskDescription && !orchestratorGoal) {
		orchestratorGoal = shortenLabel(taskDescription);
	}
	return orchestratorActivity;
}

/** Reset orchestrator activity (called at start of each tool execute) */
function resetOrchestratorActivity(): void {
	orchestratorActivity = createOrchestratorActivity();
	orchestratorGoal = "";
}

const MAX_PARALLEL = 4;
const OUTPUT_CAP = 30_000; // bytes per subagent output fed back to main
const BOX_INNER_WIDTH = 52; // inner content width for tool block boxes
const MAX_FEED_STEPS = 6; // max main steps shown in activity feed
const MAX_FEED_SUBSTEPS = 3; // max substeps shown per step (show last N)

// ============================================================================
// Plan Panel — persistent header widget (setHeader)
// ============================================================================

/**
 * Plan panel state: the goal, steps, and timing for the Orchestration Plan header.
 * Set when delegate() is called. Cleared on before_agent_start.
 */
let planState: {
	goal: string;
	steps: Array<{ label: string; completed: boolean; active: boolean; errored?: boolean }>;
	startTime: number;
} | null = null;

let planContainer: Container | null = null;
let planTimer: ReturnType<typeof setInterval> | null = null;
let _spinnerTimer: ReturnType<typeof setInterval> | null = null;
let planTUI: TUI | null = null;

/** Non-TUI fallback: store setStatus for live progress updates */
let _planStatusFn: ((id: string, text: string) => void) | null = null;

/** Render plan panel as compact text for non-TUI status bar */
function renderPlanStatusText(): string {
	if (!planState) return "";
	const { goal, steps, startTime } = planState;
	const elapsed = Date.now() - startTime;
	const total = steps.length;
	const completed = steps.filter((s) => s.completed).length;
	const errored = steps.filter((s) => s.errored).length;
	const active = steps.findIndex((s) => s.active);
	const dots = steps.filter((s) => s.completed || s.errored).map((s) => s.errored ? "✗" : "●").join("");
	return `⚡ ${shortenLabel(goal, 25)} ${dots} [${completed}/${total}] ${formatDuration(elapsed)}`;
}

/**
 * Last rendered activity feed text.
 * Stored so renderResult can show it on final (non-partial) render.
 */
function buildPlanPanel(tui: TUI, theme: any): Container {
	// Reuse existing container so timer updates affect the SAME instance the TUI holds
	if (!planContainer) {
		planContainer = new Container();
	}
	planTUI = tui;
	renderPlanPanel();
	return planContainer;
}

/**
 * Render the orchestration plan panel (Layer 1).
 * 
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 1: Orchestration Plan
 * Replaces pi's built-in header via setHeader(). Pinned at top, never scrolls.
 * 
 * Format:
 *   ┌─ Orchestration Plan ──────────────────────────────┐
 *   │ Goal: add browsing to pi with cloakbrowser          │
 *   │  ✓ Check cloakbrowser API                           │
 *   │  ⠋ Implement browse integration                     │
 *   │  ○ Review implementation                            │
 *   │  ●●● [1/3]      •    Elapsed: 45s                   │
 *   └─────────────────────────────────────────────────────┘
 */

function renderPlanPanel(): void {
	if (!planContainer || !planState) return;
	const { goal, steps, startTime } = planState;
	const elapsed = Date.now() - startTime;
	const elapsedStr = formatDuration(elapsed);

	const total = steps.length;
	const completed = steps.filter((s) => s.completed).length;
	const errored = steps.filter((s) => s.errored).length;

	// Fixed box width for consistent rendering (BOX_INNER_WIDTH between borders)
	const W = BOX_INNER_WIDTH;

	const dots = steps.filter((s) => s.completed || s.errored).map((s) => s.errored ? "✗" : "●").join("");

	planContainer.clear();

	// Header: ┌─ Orchestration Plan ──────────────────────┐
	planContainer.addChild(new Text(`┌─ Orchestration Plan ${"─".repeat(W - 21)}┐`, 0, 0));

	// Goal line: │ Goal: <padded to W>│
	const gTrunc = goal.length > W - 7 ? goal.slice(0, W - 7 - 3) + "..." : goal;
	planContainer.addChild(new Text(`│ Goal: ${gTrunc}${" ".repeat(Math.max(0, W - 7 - gTrunc.length))}│`, 0, 0));

	// Step lines
	for (const step of steps) {
		const icon = step.errored ? "✗" : step.completed ? "✓" : step.active ? SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length] : "○";
		const lbl = step.label.length > W - 4 ? step.label.slice(0, W - 4 - 3) + "..." : step.label;
		planContainer.addChild(new Text(`│  ${icon} ${lbl}${" ".repeat(Math.max(0, W - 4 - lbl.length))}│`, 0, 0));
	}

	// Progress line
	const progressStr = errored > 0 ? `${dots} [${completed}/${total}] ✗${errored}` : `${dots} [${completed}/${total}]`;
	const pContent = `  ${progressStr}      •    Elapsed: ${elapsedStr}`;
	planContainer.addChild(new Text(`│${pContent}${" ".repeat(Math.max(0, W - pContent.length))}│`, 0, 0));

	// Footer: └────────────────────────────────────────────┘
	planContainer.addChild(new Text(`└${"─".repeat(W)}┘`, 0, 0));
}

function updatePlanDisplay(): void {
	_spinnerIndex++;
	renderPlanPanel();
	if (planContainer) planContainer.invalidate();
	if (planTUI) planTUI.requestRender();
	// Non-TUI fallback: push status text
	if (_planStatusFn) {
		_planStatusFn("orchestrator", renderPlanStatusText());
	}
}

function startPlanTimer(): void {
	stopPlanTimer();
	planTimer = setInterval(() => {
		if (planState && planContainer) {
			updatePlanDisplay();
		} else {
			stopPlanTimer();
		}
	}, 1000);
	// Fast spinner animation (100ms)
	_spinnerTimer = setInterval(() => {
		if (planState && planContainer) {
			_spinnerIndex++;
			renderPlanPanel();
			if (planContainer) planContainer.invalidate();
			if (planTUI) planTUI.requestRender();
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

function clearPlanPanel(ctx: { ui: { setHeader: (f: any) => void; setPinnedHeader: (f: any) => void; setStatus?: (id: string, text: string) => void }; mode?: string }): void {
	stopPlanTimer();
	planState = null;
	planContainer = null;
	planTUI = null;
	_planStatusFn = null;
	if (ctx.mode === "tui") {
		ctx.ui.setPinnedHeader(undefined);
	} else if (ctx.ui.setStatus) {
		ctx.ui.setStatus("orchestrator", "");
	}
}

function setupPlanPanel(goal: string, stepLabels: string[], ctx: { ui: { setHeader: (f: any) => void; setPinnedHeader: (f: any) => void; setStatus?: (id: string, text: string) => void }; mode?: string }): void {
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
	if (ctx.mode === "tui") {
		ctx.ui.setPinnedHeader((tui: TUI, theme: any) => buildPlanPanel(tui, theme));
		_planStatusFn = null;
	} else if (ctx.ui.setStatus) {
		_planStatusFn = ctx.ui.setStatus.bind(ctx.ui);
	} else {
		_planStatusFn = null;
	}
	startPlanTimer();
	updatePlanDisplay();
}

function completePlanStep(ctx: { ui: { setHeader: (f: any) => void; setPinnedHeader: (f: any) => void; setStatus?: (id: string, text: string) => void }; mode?: string }): void {
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

/** Mark the current plan step as errored (keeps active state so progress stops) */
function errorPlanStep(ctx: { ui: { setHeader: (f: any) => void; setPinnedHeader: (f: any) => void; setStatus?: (id: string, text: string) => void }; mode?: string }): void {
	if (!planState) return;
	const idx = planState.steps.findIndex((s) => s.active);
	if (idx >= 0) {
		planState.steps[idx].errored = true;
		planState.steps[idx].active = false;
		// Don't advance to next step — pipeline stops on error
	}
	updatePlanDisplay();
}

// ============================================================================
// Orchestrator Activity — high-level progress view for user
// ============================================================================

/**
 * OrchestratorActivity — tracks overall task progress
 * 
 * This is the USER-FACING progress view. It shows:
 *   - Overall progress [N/M]
 *   - Current step with arrow →
 *   - Completed steps with checkmark ✓ and timing
 *   - Pending steps with circle ○ (shown in step list, not dots line)
 * 
 * NO specialist names shown — just task progress.
 * 
 * Format:
 *   [3/6] → Create package.json (2m 15s)
 *     ✓ Read pi extensions docs (12s)
 *     ✓ Read CloakBrowser README (8s)
 *     ✓ Analyze API patterns (45s)
 *     → Create package.json
 *     ○ Write index.ts
 *     ○ Test extension
 */

interface OrchestratorStep {
	label: string;
	completed: boolean;
	startTime?: number;
	endTime?: number;
}

interface OrchestratorActivity {
	steps: OrchestratorStep[];
	currentStep: number;
	startTime: number;
}

function createOrchestratorActivity(): OrchestratorActivity {
	return {
		steps: [],
		currentStep: -1,
		startTime: Date.now(),
	};
}

function addOrchestratorStep(activity: OrchestratorActivity, label: string): void {
	const cleanLabel = shortenLabel(label);
	// Avoid duplicates
	if (activity.steps.some((s) => s.label === cleanLabel)) return;
	activity.steps.push({
		label: cleanLabel,
		completed: false,
		startTime: Date.now(),
	});
	if (activity.currentStep === -1) activity.currentStep = 0;
}

function completeOrchestratorStep(activity: OrchestratorActivity): void {
	if (activity.currentStep < 0 || activity.currentStep >= activity.steps.length) return;
	activity.steps[activity.currentStep].completed = true;
	activity.steps[activity.currentStep].endTime = Date.now();
	activity.currentStep++;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

/**
 * Render the orchestrator activity feed for delegate modes.
 * 
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 1
 * Shows task-level progress when multiple specialists run.
 * 
 * Format:
 *   ◆ <goal>
 *   ●●● [3/6]
 *   ✓ Read pi extensions docs (12s)
 *   ✓ Read CloakBrowser README (8s)
 *   ⠋ Analyze API patterns...
 *   ○ Create package.json
 *   ○ Write index.ts
 *   ○ Test extension
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
 * 
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 2 (combined view)
 * Shows overall task progress with the current step's subtasks indented.
 * Used when orchestrator activity is available (single mode with plan panel).
 */
function renderCombinedProgress(
	orchestratorActivity: OrchestratorActivity,
	specialistName: string,
	feedState: ActivityFeedState,
	goal?: string,
): string {
	const lines: string[] = [];
	const total = orchestratorActivity.steps.length;
	const completed = orchestratorActivity.steps.filter((s) => s.completed).length;

	// Goal as header line (no nested box — wrapInBox provides the outer box)
	if (goal) {
		const truncated = goal.length > BOX_INNER_WIDTH - 2
			? goal.slice(0, BOX_INNER_WIDTH - 5) + "..."
			: goal;
		lines.push(`◆ ${truncated}`);
	}

	// Progress dots
	const dots = orchestratorActivity.steps.filter((s) => s.completed).map(() => "●").join("");
	lines.push(`${dots} [${completed}/${total}]`);

	// Steps list
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
			// Show subagent's subtasks indented under current step (windowed)
			if (feedState.steps.length > 0 && feedState.currentStep >= 0 && feedState.currentStep < feedState.steps.length) {
				const currentFeedStep = feedState.steps[feedState.currentStep];
				const visibleSubs = currentFeedStep.substeps.slice(-MAX_FEED_SUBSTEPS);
				const hiddenCount = currentFeedStep.substeps.length - visibleSubs.length;
				if (hiddenCount > 0) {
					lines.push(`  ... +${hiddenCount} more`);
				}
				for (const sub of visibleSubs) {
					lines.push(sub.completed ? `  ✓ ${sub.label}` : `  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${sub.label}...`);
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
// Activity Feed — tracks subagent progress for UX display
// ============================================================================

/**
 * Activity Feed State
 * 
 * Tracks the subagent's work progress for real-time UX display.
 * Updated via text deltas and tool calls from the subagent session.
 * 
 * Structure:
 *   goal: string           - One-line description of the task
 *   steps: Step[]          - Main steps (defined by subagent or parsed)
 *   currentStep: number    - Index of currently active step
 *   substeps: Substep[]    - Dynamic substeps under current main step
 * 
 * Parsing:
 *   - ## Goal\n<text> → sets goal
 *   - ## Steps\n- <text> → adds main steps
 *   - Tool calls (read/grep/bash) → adds substeps
 *   - message_end → marks current step complete
 * 
 * Display:
 *   ✓ = completed, → = in progress, ○ = pending
 *   Completed main steps show substep count: "✓ Step (N items)"
 *   Current step shows last 2 substeps
 */

interface Substep {
	label: string;
	completed: boolean;
	startTime?: number;
	endTime?: number;
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
	rawText: string; // accumulated text for reliable re-parsing
}

function createActivityFeed(): ActivityFeedState {
	return {
		goal: "",
		steps: [],
		currentStep: -1,
		rawText: "",
	};
}

/**
 * Extract step label from a line, trying multiple formats.
 * Returns the cleaned label or null if not a step line.
 */
function extractStepLabel(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return null;

	// Match bullet points: "- text", "* text", "• text"
	const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
	if (bulletMatch) return bulletMatch[1].trim();

	// Match numbered steps: "1. text", "1) text", "01. text"
	const numMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
	if (numMatch) return numMatch[1].trim();

	return null;
}

/**
 * Check if a line is a section header (## Goal, ## Steps, etc.)
 */
function isSectionHeader(line: string): boolean {
	return /^#{1,3}\s+/.test(line.trim());
}

/**
 * Filter out garbage step labels that are too short, code fragments, or paths.
 */
function isValidStepLabel(label: string): boolean {
	// Too short to be meaningful
	if (label.length < 3) return false;
	// Looks like a file path or code fragment
	if (label.startsWith("`/") || label.startsWith("/") || label.startsWith("\\")) return false;
	// Starts with backtick (inline code artifact)
	if (label.startsWith("`")) return false;
	// Looks like a single common word that's likely a parsing artifact
	const garbageWords = ["But", "And", "Or", "The", "For", "All", "Not", "Can", "Will", "Then", "Else", "When", "Also", "Now", "Just", "Only"];
	if (garbageWords.includes(label) && label.length < 5) return false;
	return true;
}

/**
 * Parse subagent text output to extract goal and steps.
 * Called on each text_delta to update the feed incrementally.
 *
 * Strategy:
 * 1. Accumulate raw text in state for reliable line-based parsing
 * 2. Look for ## Goal / ## Steps sections (structured output)
 * 3. Fall back to numbered/bullet step detection
 * 4. Avoid duplicate step extraction across calls
 */
function parseTextForFeed(state: ActivityFeedState, text: string): void {
	// Accumulate all text for reliable line-boundary parsing
	state.rawText += text;
	const lines = state.rawText.split("\n");

	// The LAST element is always an incomplete line (no trailing newline yet)
	// — skip it to avoid parsing partial streaming text as steps.
	const completeLines = lines.slice(0, -1);

	// Track parsing state across lines
	let inGoalSection = false;
	let inStepsSection = false;
	const existingStepLabels = new Set(state.steps.map((s) => s.label));

	for (const line of completeLines) {
		const trimmed = line.trim();
		if (!trimmed) {
			// Empty line: exit any section context
			inGoalSection = false;
			inStepsSection = false;
			continue;
		}

		// Detect section headers
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
		// Any other ## header exits both sections
		if (isSectionHeader(trimmed)) {
			inGoalSection = false;
			inStepsSection = false;
			continue;
		}

		// Inside Goal section: first non-empty line is the goal
		if (inGoalSection && state.goal === "") {
			state.goal = trimmed;
			continue;
		}

		// Inside Steps section: extract step lines
		if (inStepsSection) {
			const label = extractStepLabel(trimmed);
			if (label && !existingStepLabels.has(label)) {
				addStep(state, label);
				existingStepLabels.add(label);
			}
			continue;
		}

		// Outside sections: detect steps from any bullet/numbered line
		// (handles models that skip ## Steps header)
		const label = extractStepLabel(trimmed);
		if (label && state.goal && !existingStepLabels.has(label)) {
			// Only add if we already have a goal (suggests we're past preamble)
			// and the label looks like a real step, not garbage
			if (isValidStepLabel(label)) {
				addStep(state, label);
				existingStepLabels.add(label);
			}
			continue;
		}

		// Goal fallback: first non-header, non-step line sets goal
		if (state.goal === "" && !trimmed.startsWith("#")) {
			state.goal = trimmed;
		}
	}
}

/**
 * Add a step to the activity feed.
 * Handles incremental streaming: if the new label EXTENDS an existing
 * incomplete step (e.g. "Step" → "Step 1: Read docs"), replaces the old.
 * Removes "Working..." fallback when real steps come in.
 */
function addStep(state: ActivityFeedState, label: string): void {
	// Skip "Working..." — it's a fallback placeholder
	if (label === "Working...") return;

	// Check if new label extends an existing incomplete step
	for (let i = 0; i < state.steps.length; i++) {
		const existing = state.steps[i];
		// If existing label is a prefix of the new one AND the existing hasn't been
		// fully started yet (no substeps), it was an incomplete streaming fragment
		if (label.startsWith(existing.label) && label.length > existing.label.length && existing.substeps.length === 0 && !existing.completed) {
			// Replace the incomplete step with the full version
			state.steps[i] = { label, completed: false, substeps: [], startTime: existing.startTime };
			return;
		}
	}

	// Avoid exact duplicates
	if (state.steps.some((s) => s.label === label)) return;
	// Cap total steps to prevent UI wall-of-text
	if (state.steps.length >= MAX_FEED_STEPS) return;
	state.steps.push({ label, completed: false, substeps: [], startTime: Date.now() });
	if (state.currentStep === -1) state.currentStep = 0;
}

/**
 * Add a substep to the current main step.
 * Called when a tool_call event is detected.
 * If no steps exist yet, creates an implicit step from the tool call
 * rather than a generic "Working..." placeholder.
 */
function addSubstep(state: ActivityFeedState, label: string): void {
	// No steps yet: derive an implicit step name from the tool call
	if (state.currentStep < 0 || state.steps.length === 0) {
		const implicitLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
		state.steps.push({ label: implicitLabel, completed: false, substeps: [], startTime: Date.now() });
		state.currentStep = 0;
	}
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	const step = state.steps[state.currentStep];
	// Avoid duplicates
	if (step.substeps.some((s) => s.label === label)) return;
	// Cap substeps to prevent UI overflow — keep only last N
	if (step.substeps.length >= MAX_FEED_SUBSTEPS) {
		step.substeps.shift(); // remove oldest
	}
	step.substeps.push({ label, completed: false, startTime: Date.now() });
}

/**
 * Mark the current step's last substep as complete.
 */
function completeLastSubstep(state: ActivityFeedState): void {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	const step = state.steps[state.currentStep];
	if (step.substeps.length > 0) {
		const sub = step.substeps[step.substeps.length - 1];
		sub.completed = true;
		sub.endTime = Date.now();
	}
}

/**
 * Mark current step as complete, advance to next.
 */
function completeCurrentStep(state: ActivityFeedState): void {
	if (state.currentStep < 0 || state.currentStep >= state.steps.length) return;
	// Complete any pending substeps
	for (const sub of state.steps[state.currentStep].substeps) {
		sub.completed = true;
		if (!sub.endTime) sub.endTime = Date.now();
	}
	state.steps[state.currentStep].completed = true;
	state.steps[state.currentStep].endTime = Date.now();
	state.currentStep++;
}

/**
 * Auto-detect substep from tool call.
 * Maps tool names to human-readable labels with normalized paths.
 */
function toolCallToSubstep(toolName: string, input: any): string {
	const normalizePath = (p: string | undefined) => {
		if (!p) return "file";
		// Use basename for very long paths to prevent duplicate
		// substeps from different truncation points in the TUI
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
 * Render the subagent activity feed.
 * 
 * Design spec: ORCHESTRATION-UI-DESIGN.md → Layer 2: Subagent Tool Blocks
 * Cache-safe: only used in onUpdate (display-only), not persisted.
 * 
 * Format (inside outer box ╭─ Specialist ──╮):
 *   ┌─ Task ───────────────┐
 *   │ check cloakbrowser    │
 *   └──────────────────────┘
 *   ●●● [3/3]
 *   ✓ scan pi web tools (8s)
 *   ✓ check cloakbrowser api (12s)
 *   ⠋ synthesize findings...
 * 
 * Key rule: Activity feed NEVER collapses.
 * During: current step shows ⠋ spinner. After: all steps show ✓ with durations.
 */
function renderActivityFeed(name: string, state: ActivityFeedState): string {
	const lines: string[] = [];

	// Feedback even without steps: show recent tool calls
	if (state.steps.length === 0) {
		const substepCount = state.steps.reduce((sum, s) => sum + s.substeps.length, 0);
		if (substepCount > 0) {
			// Find the last substep from any step
			for (const s of state.steps) {
				for (const sub of s.substeps) {
					lines.push(sub.completed ? `  ✓ ${sub.label}` : `  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${sub.label}...`);
				}
			}
			return lines.join("\n");
		}
		lines.push(`  ${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} Starting...`);
		return lines.join("\n");
	}

	const total = state.steps.length;
	const completed = state.steps.filter((s) => s.completed).length;

	// Task box with goal
	if (state.goal) {
		const boxWidth = Math.max(state.goal.length + 4, 30);
		const padding = boxWidth - 4;
		const truncated = state.goal.length > padding ? state.goal.slice(0, padding - 3) + "..." : state.goal;
		const pad = padding - truncated.length;
				lines.push(`┌─ Task ${("─").repeat(Math.max(0, boxWidth - 9))}┐`);
		lines.push(`│ ${truncated}${(" ").repeat(pad)} │`);
		lines.push(`└${("─").repeat(Math.max(0, boxWidth - 2))}┘`);
	}

	// Progress dots
	const dots = state.steps.filter((s) => s.completed).map(() => "●").join("");
	lines.push(`${dots} [${completed}/${total}]`);

	// Steps list
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
			// Show only last N substeps (windowed)
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
// ==============================================================================

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Compress subagent output for token savings.
 * 
 * Cache-safe: compression happens BEFORE output enters parent context.
 * Delegates to token-saver's compression logic for consistency.
 */
function compressOutput(output: string): string {
	let result = output;

	// Strip ANSI color codes
	result = result.replace(ANSI_RE, "");

	// Collapse triple+ blank lines
	result = result.replace(/\n{3,}/g, "\n\n");

	// Trim leading/trailing whitespace
	result = result.trim();

	return result;
}

// ============================================================================
// Subagent definitions — each specialist has a focused prompt
// ============================================================================

interface Specialist {
	name: string;
	tools: string[];
	model?: string;
	systemPrompt: string;
}

const TERSE_INSTRUCTION = `

Respond terse like smart caveman. All technical substance stay. Only fluff die.

## Persistence
ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.

## Rules
Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.
Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that..."
Good: "Bug in auth middleware. Token expiry check use '<' not '<='. Fix:"

## Auto-Clarity
Drop caveman for: security warnings, destructive ops, multi-step ambiguity, user asks clarify. Resume after clear part done.

## Boundaries
Code/commits/PRs: write normal. "stop caveman" or "normal mode": revert. Think short too. No verbose CoT.`;

const ACTIVITY_FEED_INSTRUCTION = `

## ══ CRITICAL: Plan First ══
BEFORE doing ANY work, output your plan in this EXACT format as your VERY FIRST response:

## Goal
<one line describing the goal>

## Steps
- Step 1 description
- Step 2 description
- Step 3 description

DO NOT call any tools until you have output the ## Goal and ## Steps sections above.
The system tracks your progress automatically via tool calls after you output the plan.`;

const SPECIALISTS: Record<string, Specialist> = {
	scout: {
		name: "scout",
		tools: ["read", "bash"],
		systemPrompt: `${ACTIVITY_FEED_INSTRUCTION}

You are a fast codebase scout. Investigate and return compressed findings.

Rules:
- Use grep/find to locate code, read key sections only
- Output structured findings another agent can use without re-reading files
- Be concise — your output feeds into a planner
${TERSE_INSTRUCTION}
- AFTER outputting your plan, use tools to execute each step

Output format (after plan):
## Files Found
(path + line ranges + what's there)

## Key Code
Critical types/functions/interfaces

## Dependencies
How pieces connect

## Recommendation
Which file to start with and why`,
	},

	coder: {
		name: "coder",
		tools: ["read", "bash", "edit", "write"],
		systemPrompt: `${ACTIVITY_FEED_INSTRUCTION}

You are an implementation specialist. Execute a plan precisely.

Rules:
- Read files mentioned in the plan
- Make exactly the changes described — no extra changes
- ALWAYS use \`edit\` tool for file modifications — if exact-text match fails, retry with \`write\` (full file). NEVER use \`bash\` + \`sed\`/\`awk\`
- Verify changes compile/run
- Report what changed
${TERSE_INSTRUCTION}
- AFTER outputting your plan, use tools to execute each step

Output format (after plan):
## Completed
What was done.

## Files Changed
- path - what changed

## Verification
What you checked.`,
	},

	reviewer: {
		name: "reviewer",
		tools: ["read", "bash"],
		systemPrompt: `${ACTIVITY_FEED_INSTRUCTION}

You are a senior code reviewer. Analyze for bugs, security, quality. 

Rules:
- Read the changed files
- Check for bugs, security issues, code smells
- Be specific with file paths and line numbers
- Do NOT make changes — only report
${TERSE_INSTRUCTION}

Output format:
## Critical (must fix)
Issues that block.

## Warnings (should fix)
Issues to address.

## Suggestions (nice to have)
Improvements.

## Summary
Overall assessment in 2-3 sentences.`,
	},

	researcher: {
		name: "researcher",
		tools: ["read", "bash"],
		systemPrompt: `${ACTIVITY_FEED_INSTRUCTION}

You are a research specialist. Investigate questions, find answers.

Rules:
- Read documentation, configs, source code
- Trace code paths to understand behavior
- Provide evidence-based answers
- Be thorough but concise
${TERSE_INSTRUCTION}

Output format:
## Answer
Direct answer to the question.

## Evidence
Code references and reasoning.

## Caveats
Limitations or edge cases.`,
	},

	writer: {
		name: "writer",
		tools: ["read", "write", "edit"],
		systemPrompt: `${ACTIVITY_FEED_INSTRUCTION}

You are a documentation writer. Create or update docs, READMEs, comments.

Rules:
- Read existing docs to understand style
- Match the project's existing documentation patterns
- Write clearly and concisely
- Include code examples where helpful
${TERSE_INSTRUCTION}

Output format:
## Changes Made
- file: what was written/updated

## Content
The actual documentation changes.`,
	},
};

// ============================================================================
// In-process subagent runner
// ============================================================================

interface SubagentContext {
	modelRegistry?: ModelRegistry;
	model?: any; // Parent's current model
}

async function runSubagent(
	specialist: Specialist,
	task: string,
	cwd: string,
	parentCtx?: SubagentContext,
	signal?: AbortSignal,
	onUpdate?: (update: any) => void,
	orchestratorActivity?: OrchestratorActivity,
): Promise<{ output: string; turns: number }> {
	try {
		// ── Cache optimization ──
		// Subagent system prompts = 100% stable per specialist type.
		// noContextFiles=true prevents AGENTS.md injection (see DefaultResourceLoader).
		// Model inherits parent's compat config, including cache-related settings.
		// PI_CACHE_RETENTION env var is read globally by pi-ai providers.
		// This enables prefix caching for repeated specialist calls.

		// Use parent's model registry if available, otherwise create empty
		const authStorage = AuthStorage.create();
		const modelRegistry = parentCtx?.modelRegistry ?? ModelRegistry.inMemory(authStorage);

		// Resolve model: specialist.model > parent's model > registry fallback
		let model;
		if (specialist.model) {
			// Specialist has custom model specified (format: "provider/id")
			const slashIdx = specialist.model.indexOf("/");
			if (slashIdx > 0) {
				const provider = specialist.model.slice(0, slashIdx);
				const id = specialist.model.slice(slashIdx + 1);
			model = getModel(provider as KnownProvider, id);
			}
		} else if (parentCtx?.model) {
			// Inherit parent's model
			model = parentCtx.model;
		}

		// Fallback: use first available model from registry
		if (!model) {
			const available = modelRegistry.getAvailable();
			if (available.length > 0) {
				model = available[0];
			}
		}

		if (!model) {
			return { output: "[error] No model available for subagent. Check API key configuration.", turns: 0 };
		}

		// Load extensions and skills for the subagent, but flag the context
		// so the orchestrator extension skips re-registering its tools
		// and before_agent_start handler (avoids infinite delegation loop).
		//
		// Both flags are needed:
		// - _batchLoadSubagent: covers synchronous module-scope check (same module instance)
		// - process.env: survives jiti module reload (subagent's fresh module scope)
		_batchLoadSubagent++;
		process.env[SUBAGENT_ENV_KEY] = "1";
		debugLog("SUBAGENT LOADING", { specialist: specialist.name, task: task.slice(0, 80) });
		let loader: DefaultResourceLoader;
		try {
			// Cache optimization: noContextFiles=true keeps subagent system prompts
			// 100% stable per specialist type → stable prefix = cache hits.
			// The specialist.systemPrompt is the sole source of subagent instructions.
			loader = new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				systemPromptOverride: () => specialist.systemPrompt,
				noContextFiles: true,
			});
			await loader.reload();
		} finally {
			_batchLoadSubagent--;
			delete process.env[SUBAGENT_ENV_KEY];
			debugLog("SUBAGENT LOADING DONE", { specialist: specialist.name });
		}

		const { session } = await createAgentSession({
			cwd,
			model,
			tools: specialist.tools,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			modelRegistry,
		});

		let output = "";
		let turns = 0;
		const feed = createActivityFeed();
		feed.goal = shortenLabel(task);

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				output += event.assistantMessageEvent.delta;
				parseTextForFeed(feed, event.assistantMessageEvent.delta);
			}
			if (event.type === "message_end") {
				if (event.message?.role === "assistant") {
					turns++;
					if (feed.steps.length > 0 && feed.currentStep < feed.steps.length) {
						completeCurrentStep(feed);
					}
					// Use combined progress if orchestrator activity available, else standalone feed
					const text = orchestratorActivity
						? renderCombinedProgress(orchestratorActivity, specialist.name, feed, orchestratorGoal)
						: renderActivityFeed(specialist.name, feed);
					if (planTUI) planTUI.requestRender(true);
					onUpdate?.({
						content: [{ type: "text", text }],
						details: { specialist: specialist.name, status: "running", turns },
					});
				}
			}
			if (event.type === "tool_execution_start") {
				const substepLabel = toolCallToSubstep(event.toolName, event.args);
				addSubstep(feed, substepLabel);
				const text = orchestratorActivity
					? renderCombinedProgress(orchestratorActivity, specialist.name, feed, orchestratorGoal)
					: renderActivityFeed(specialist.name, feed);
				if (planTUI) planTUI.requestRender(true);
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { specialist: specialist.name, status: "running", tool: event.toolName },
				});
			}
			if (event.type === "tool_execution_end") {
				completeLastSubstep(feed);
				const text = orchestratorActivity
					? renderCombinedProgress(orchestratorActivity, specialist.name, feed, orchestratorGoal)
					: renderActivityFeed(specialist.name, feed);
				if (planTUI) planTUI.requestRender(true);
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { specialist: specialist.name, status: "running" },
				});
			}
		});

		// Abort handler — cancel subagent when parent aborts
		const abortHandler = () => {
			session.abort();
		};
		if (signal) {
			if (signal.aborted) abortHandler();
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			_inSubagentExecution++;
			await session.prompt(task);
		} catch (error) {
			output = `[error] ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			_inSubagentExecution--;
			unsubscribe();
			if (signal) signal.removeEventListener("abort", abortHandler);
			session.dispose();
		}

		// Compress + cap output before returning to main agent
		let finalOutput = compressOutput(output || "(no output)");
		if (finalOutput.length > OUTPUT_CAP) {
			finalOutput = finalOutput.slice(0, OUTPUT_CAP) + "\n\n[output truncated]";
		}

		return { output: finalOutput, turns };
	} catch (error) {
		// Catch ALL errors from initialization (DefaultResourceLoader, createAgentSession, etc.)
		const msg = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : "";
		return { output: `[error] Subagent init failed: ${msg}${stack ? "\n" + stack.split("\n").slice(0, 5).join("\n") : ""}`, turns: 0 };
	}
}

// ============================================================================
// The Extension
// ============================================================================

/**
 * Auto-generate plan step labels from the user's task description.
 * Uses keyword matching to produce relevant step labels.
 * These are displayed in the Orchestration Plan header panel
 * BEFORE the main LLM starts, so the user sees the plan immediately.
 */
function generateStepsFromPrompt(prompt: string): string[] {
	const p = prompt.toLowerCase();
	const steps: string[] = [];
	const has = (words: string[]) => words.some(w => p.includes(w));

	// Detect investigation/research need
	const needsResearch = has([
		"find", "what", "how", "why", "learn", "understand",
		"investigate", "explore", "look at", "check", "research",
		"discover", "analyze", "read", "search", "examine", "audit",
	]);

	// Detect implementation need
	const needsImplement = has([
		"implement", "create", "add", "build", "write", "make",
		"develop", "code", "change", "modify", "update", "fix",
		"debug", "patch", "refactor", "integrate", "setup", "configure",
		"install", "extend", "edit",
	]);

	// Detect documentation need
	const needsDocs = has([
		"document", "doc", "readme", "write docs", "explain",
		"documentation", "comment",
	]);

	// Detect testing need
	const needsTest = has([
		"test", "verify", "validate", "check correctness",
	]);

	// Detect review need
	const needsReview = has([
		"review", "audit", "inspect", "check quality",
	]);

	if (needsResearch) {
		steps.push("Gather context and investigate");
	}

	if (needsImplement) {
		if (needsResearch) {
			steps.push("Design solution approach");
		}
		steps.push("Implement changes");
	}

	if (needsTest) {
		steps.push("Verify correctness");
	}

	if (needsReview) {
		steps.push("Review and validate");
	}

	if (needsDocs) {
		steps.push("Document changes");
	}

	// Fallback: if nothing matched or only generic match
	if (steps.length === 0) {
		steps.push("Research and understand context");
		steps.push("Implement solution");
		steps.push("Verify and finalize");
	}

	return steps;
}

export default function (pi: ExtensionAPI) {

	// ── Guard: Skip registration when loading for a subagent session ──────
	// When _batchLoadSubagent > 0, this extension is being loaded as part
	// of a subagent's resource discovery. Registering the orchestrator
	// tools and before_agent_start handler would cause:
	//   1. Subagent gets "Orchestrator Mode" injected into its system prompt
	//   2. Orchestrator tools become available, risking recursion
	//
	// Subagents still get all other extensions (token-saver, pi-web-access)
	// and skills (caveman, librarian) — only the orchestrator opts out.
	//
	// NOTE: _batchLoadSubagent is module-scoped, so jiti re-executes the
	// module fresh for each DefaultResourceLoader.reload() — the subagent's
	// module scope always has _batchLoadSubagent === 0. We ALSO check
	// process.env (which survives across module reloads) as the primary guard.
	if (_batchLoadSubagent > 0 || isSubagentContext()) {
		debugLog("SKIPPING orchestrator registration (subagent context)", {
			batchLoad: _batchLoadSubagent,
			envGuard: process.env[SUBAGENT_ENV_KEY],
		});
		return;
	}

	// ── System Prompt: Tell the agent to ALWAYS delegate ──────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		// Reset orchestrator activity for new session
		orchestratorActivity = null;
		orchestratorGoal = "";
		clearPlanPanel(ctx);

		// ── Deterministic enforcement: strip ALL non-delegation tools ──
		// SDK: event.systemPromptOptions.selectedTools = tools currently active
		// in the prompt. Mutating this BEFORE the system prompt is built removes
		// non-delegation tools from the "Available tools" section the LLM sees.
		// Combined with the tool_call block handler, this creates two layers:
		//   1. Soft: LLM only sees delegate in available tools (prompt-level)
		//   2. Hard: tool_call handler blocks non-delegation calls (runtime-level)
		if (event.systemPromptOptions?.selectedTools) {
			event.systemPromptOptions.selectedTools = [
				"delegate",
			];
		}

		// ── Show initial plan panel from the user's prompt ──
		// Show the goal immediately so the user sees what's being orchestrated.
		// Steps populated by delegate calls.
		// We do NOT auto-generate steps — the LLM decides the plan.
		const prompt = event.prompt || "";
		if (prompt) {
			orchestratorGoal = shortenLabel(prompt);
			// Show a "Planning..." placeholder — steps come from delegate calls
			setupPlanPanel(shortenLabel(prompt), ["Planning..."], ctx);
		}

		const delegationInstructions = `
## Orchestrator Mode — DELEGATE ONLY

You are an expert coding assistant operating in **orchestrator mode**. In this mode, your role shifts from direct execution to delegation management — you direct specialist agents who do the hands-on work.

### Your tool: delegate(specialist, task)

You have ONE tool: \`delegate(specialist, task)\`.
Call it once per step. Review the output. Then call it again for the next step.

You do NOT have read, bash, grep, find, edit, or write tools in this mode.
You CANNOT access files or run commands directly.

### Specialist roster:
- **scout** — Fast codebase investigation (read-only)
- **coder** — Implementation (read/write/bash)
- **reviewer** — Code review (read-only, thorough)
- **researcher** — Question answering (read-only)
- **writer** — Documentation (read/write)

### Workflow:
1. Analyze the request
2. Call delegate(scout, "investigate ...") — read output
3. Call delegate(coder, "implement ... based on: [scout output]") — read output
4. Call delegate(reviewer, "review ... based on: [coder output]") — read output
5. Synthesize all results into final answer

You decide next step AFTER seeing previous result. NOT before.

### Example:
User: "Add error handling to main.ts"
Step 1: delegate(scout, "Find main.ts and understand current error handling")
  → scout returns: "main.ts has no try/catch..."
Step 2: delegate(coder, "Add try/catch based on: [above]")
  → coder returns: "Added try/catch to lines 15-30..."
Step 3: delegate(reviewer, "Review the changes: [above]")
  → reviewer returns: "Looks good, one edge case..."

Your response: the synthesized summary — NOT implementation details.
`;

	// Cache optimization: delegation instructions are stable (same every call).
	// They're appended as a stable suffix to the pi-cache-optimizer-processed
	// system prompt (which already has `---` separator from stable/dynamic split).
	// The agent picks up where the main prompt leaves off — clean separation.
	return {
		systemPrompt: event.systemPrompt + "\n\n" + delegationInstructions,
	};
	});

	// ── Safety net: Block non-delegation tool calls ──────────────────────
	// Blocks non-delegate tool calls. Subagents skip this via env var guard.
	pi.on("tool_call", async (event, ctx) => {
		if (_inSubagentExecution > 0) return; // Don't block subagent tools
		if (event.toolName !== "delegate") {
			return { block: true, reason: `Orchestrator mode: use delegate() instead of ${event.toolName}` };
		}
	});
	//     }
	// });

	// ── Box-wrapping helpers (standalone functions, no `this` binding issues) ──

	function wrapInBox(lines: string[], boxWidth: number, contentColor?: (text: string) => string): string {
		const out: string[] = [];
		for (const line of lines) {
			const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
			const padded = clean.length > boxWidth - 4
				? clean.slice(0, boxWidth - 4)
				: clean + " ".repeat(boxWidth - 4 - clean.length);
			// Apply content color only to the padded text, not the box borders
			const coloredContent = contentColor ? contentColor(padded) : padded;
			out.push(`│ ${coloredContent} │`);
		}
		out.push(`╰${("─").repeat(boxWidth - 2)}╯`);
		return out.join("\n");
	}

	function boxWidthFor(name: string): number {
		if (!name) return 0;
		return 3 + name.length + 1 + Math.max(0, BOX_INNER_WIDTH - name.length) + 1;
	}

	function specDisplayName(params: any, details: any): string {
		const raw = params?.specialist || details?.specialist || "";
		return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
	}

	// ── Tool: delegate ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "delegate",
		label: "delegate",
		description: `Delegate work to a specialist subagent. Provides specialist name and task.`,
		parameters: Type.Object({
			specialist: Type.String({
				description: "Specialist: scout, coder, reviewer, researcher, writer",
			}),
			task: Type.String({
				description: "Task description for the specialist to execute",
			}),
		}),

		// ── Render: what shows when tool is invoked ──
		renderCall(args, theme, context) {
			const comp = context.lastComponent ?? new Text("", 0, 0);
			const name = (args.specialist || "").charAt(0).toUpperCase() + (args.specialist || "").slice(1);
			const task = args.task ? args.task.slice(0, 60) : "";
			const content = theme.fg("toolTitle", theme.bold(`delegate ${name}`)) +
				(task ? theme.fg("dim", `: ${task}`) : "");
			comp.setText(content);
			return comp;
		},

		// ── Render: what shows during/after execution ──
		renderResult(result, { isPartial, expanded }, theme, context) {
			const state = context.state as any;
			const details = result.details as any;
			const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";

			// SDK pattern: timer for live elapsed updates (like bash.js)
			if (isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!isPartial && state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}

			const comp = context.lastComponent ?? new Text("", 0, 0);

			if (isPartial) {
				if (text) state.lastFeedText = text;
				comp.setText(text ? theme.fg("warning", text) : theme.fg("warning", `${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} working...`));
			} else {
				const feedText = state.lastFeedText || text || "✓ done";
				comp.setText(theme.fg("success", feedText));
			}

			return comp;
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Single mode ──
			if (!params.specialist || !params.task) {
				return { content: [{ type: "text", text: "Provide specialist+task, tasks[], or steps[]" }], details: {} };
			}

			const specialist = SPECIALISTS[params.specialist];
			if (!specialist) {
				const available = Object.keys(SPECIALISTS).join(", ");
				return { content: [{ type: "text", text: `Unknown specialist: "${params.specialist}". Available: ${available}` }], details: {} };
			}

			// Set up plan panel for this single delegation
			
			if (!planState || planState.steps.length <= 1) {
				resetOrchestratorActivity();
				const specName = specialist.name.charAt(0).toUpperCase() + specialist.name.slice(1);
				setupPlanPanel(shortenLabel(params.task), [`${specName}: ${shortenLabel(params.task)}`], ctx);
			}

			onUpdate?.({
				content: [{ type: "text", text: `${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${specialist.name}...` }],
				details: { status: "running", specialist: specialist.name },
			});

			const result = await runSubagent(specialist, params.task, ctx.cwd, { modelRegistry: ctx.modelRegistry, model: ctx.model }, signal, onUpdate);

			if (result.output.startsWith("[error]")) {
				errorPlanStep(ctx);
			} else {
				completePlanStep(ctx);
			}

			return {
				content: [{ type: "text", text: result.output }],
				details: { specialist: specialist.name, task: params.task, status: "done", turns: result.turns, outputLength: result.output.length },
			};
		},
	});


	// ── Command: /orchestrate — manual task trigger ───────────────────────

	pi.registerCommand("orchestrate", {
		description: "Run an orchestrated task with multiple specialists\nUsage: /orchestrate <task description>",
		handler: async (args, ctx) => {
			if (!args || args.trim().length === 0) {
				ctx.ui.notify("Usage: /orchestrate <task description>", "warning");
				return;
			}

			const task = args.trim();
			ctx.ui.notify(`Starting orchestrated task: ${task}`, "info");

			// Send a message to the agent as if the user typed it
			pi.sendUserMessage(task, { deliverAs: "followUp" });
		},
	});

	// ── Command: /specialists — list available specialists ─────────────────

	pi.registerCommand("specialists", {
		description: "List available specialists and their capabilities\nUsage: /specialists",
		handler: async (_args, ctx) => {
			const lines = Object.entries(SPECIALISTS).map(([key, spec]) => {
				return `${key}: ${spec.tools.join(", ")}`;
			});
			ctx.ui.notify(`Specialists:\n${lines.join("\n")}`, "info");
		},
	});
}

// ============================================================================
// Static box-wrapping helper (for tools without `this` access)
// ============================================================================

function wrapInBoxStatic(lines: string[], boxWidth: number): string {
	const out: string[] = [];
	for (const line of lines) {
		const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
		const padded = clean.length > boxWidth - 4
			? clean.slice(0, boxWidth - 4)
			: clean + " ".repeat(boxWidth - 4 - clean.length);
		out.push(`│ ${padded} │`);
	}
	out.push(`╰${("─").repeat(boxWidth - 2)}╯`);
	return out.join("\n");
}
