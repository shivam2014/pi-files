/**
 * Shared types for the orchestrator extension.
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** A step in the orchestration plan (Layer 1 header) */
export interface OrchestratorStep {
	label: string;
	completed: boolean;
	startTime?: number;
	endTime?: number;
}

/** Orchestration activity state (Layer 1 header) */
export interface OrchestratorActivity {
	steps: OrchestratorStep[];
	currentStep: number;
	startTime: number;
}

/** A substep within an activity feed step (Layer 2 chat blocks) */
export interface Substep {
	toolCallId?: string;
	label: string;
	completed: boolean;
	startTime?: number;
	endTime?: number;
	outputPreview?: string;
	isReport?: boolean;
	errored?: boolean;
	toolDetail?: string;
}

/** A step in the activity feed (Layer 2 chat blocks) */
export interface Step {
	label: string;
	completed: boolean;
	substeps: Substep[];
	startTime?: number;
	endTime?: number;
	overflowCount?: number;
}

/** Activity feed state for subagent tool blocks */
export interface ActivityFeedState {
	goal: string;
	steps: Step[];
	currentStep: number;
	rawText: string;
	planParsed: boolean;  // true after planSteps() tool is called
	errored?: boolean;
	errorMessage?: string;
	retryCount?: number;
	retryReason?: string;
}

/** Specialist definition */
export interface Specialist {
	/** Specialist name (used as key in SPECIALISTS registry) */
	name: string;
	/** Short human-readable description of the specialist's role */
	description?: string;
	/** Tool names granted to this specialist */
	tools: string[];
	/** Default skill pack names loaded for this specialist (issue #42) */
	suggestedSkills?: string[];
	/** Optional model override (e.g. "anthropic/claude-sonnet-4") */
	model?: string;
	/** Human-readable label used in the task routing UI */
	routingLabel?: string;
	/** Whether this specialist has write access (false = read-only) */
	readOnly: boolean;
	/** Full system prompt used when creating the subagent session */
	systemPrompt: string;
}

/** Context passed to subagent runner */
export interface SubagentContext {
	modelRegistry?: any;
	modelRuntime?: any;
	model?: any;
	/** Resolver for ask_orchestrator clarifications. Pauses the subagent until resolved. */
	onAskOrchestrator?: (question: string, context?: string) => Promise<string>;
}

export type StepKind = 'delegation' | 'orchestrator' | 'loop_until';

export const STEP_KIND_SCHEMA = Type.Optional(Type.Union([
	Type.Literal('delegation'),
	Type.Literal('orchestrator'),
	Type.Literal('loop_until'),
], { description: 'Step classification: delegation (subagent-owned, auto-advances), orchestrator (self-owned, call advance_plan_step), loop_until (repeating evaluation loop)' }));

/** Configuration for a loop_until step */
export interface LoopUntilConfig {
	/** Human-readable success condition */
	criterion: string;
	/** Specialist name that evaluates results (default: 'reviewer') */
	evaluator: string;
	/** Hard cap on iterations (default: 10) */
	maxIterations: number;
	/** Token budget for entire loop (optional) */
	maxTokens?: number;
	/** Evaluation mode (default: 'satisficing') */
	mode: 'single-pass' | 'satisficing';
	/** Consecutive passes required in satisficing mode (default: 2) */
	satisficingPasses: number;
	/** The delegation spec to run each iteration */
	iterationTemplate: {
		specialist: string;
		/** Task text. Use {{iteration.N}} for current iteration number */
		task: string;
		scope?: any; // Scope type from scope-manager
	};
}

/** Runtime state for a loop step (transient, not persisted) */
export interface LoopUntilState {
	currentIteration: number;
	consecutivePasses: number;
	rollingSummary: string;
	status: 'idle' | 'running' | 'completed' | 'max-reached' | 'error';
	iterations: LoopIteration[];
}

/** Record of a single loop iteration */
export interface LoopIteration {
	index: number;
	status: 'pass' | 'fail' | 'error';
	scores?: Record<string, number>;
	feedback?: string;
	summary: string;
}

/** Structured loop step input for plan() */
export interface LoopUntilStepInput {
	label: string;
	kind: 'loop_until';
	loopUntil: LoopUntilConfig;
}

/** A step in the plan panel header */
export interface PlanStep {
	label: string;
	completed: boolean;
	active: boolean;
	errored?: boolean;
	errorMessage?: string;
	detail?: string;
	detailLines?: string[];
	startTime?: number;
	endTime?: number;
	kind?: StepKind;
	/** Present when kind === 'loop_until'. User-provided config. */
	loopUntil?: LoopUntilConfig;
	/** Runtime state for loop steps. Transient — not persisted. */
	loopUntilState?: LoopUntilState;
}

/** A step in plan() can be a string label or a structured loop input */
export type PlanStepInput = string | LoopUntilStepInput;

/** Per-delegation tool usage metrics */
export interface DelegationMetrics {
	readCalls: number;
	grepCalls: number;
	findCalls: number;
	editCalls: number;
	writeCalls: number;
	bashCalls: number;
	lsCalls: number;
	scopeViolations: number;
}

/** Format DelegationMetrics as a single-line summary string (SSOT for metrics formatting). */
export function formatMetricsLine(m: DelegationMetrics): string {
	return `[Metrics: read=${m.readCalls}, grep=${m.grepCalls}, find=${m.findCalls}, edit=${m.editCalls}, write=${m.writeCalls}, bash=${m.bashCalls}, ls=${m.lsCalls}, scopeViolations=${m.scopeViolations}]`;
}

export interface FusionConfig {
	enabled?: boolean;
	panel?: string[];
	judge?: string;
	maxPanelModels?: number;
	temperature?: number;
	maxTokensPerPanel?: number;
	maxTokensForJudge?: number;
}

export interface FusionAnalysis {
	consensus: string[];
	contradictions: Array<{
		topic: string;
		stances: Array<{ model: string; stance: string }>;
	}>;
	unique_insights: Array<{ model: string; insight: string }>;
	blind_spots: string[];
	recommendations: string[];
}

export interface FusionResult {
	status: "ok" | "error" | "single" | "disabled" | "no_judge";
	analysis?: FusionAnalysis;
	panelModels?: string[];
	judgeModel?: string;
	responses?: Array<{ model: string; content?: string; error?: string }>;
}

/** Parameters for read_skill tool */
export interface ReadSkillParams {
	name: string;
}

/** Minimal model registry interface — avoids coupling to full pi-coding-agent types */
export interface MinimalModelRegistry {
	getModels?: () => any[];
}

import type { OrchestratorConfig } from "./orchestrator-config.ts";

/** Context for delegate-controller — thin typed wrapper over raw ExtensionContext */
export interface DelegateControllerContext {
	cwd: string;
	sessionId?: string;
	modelRegistry?: MinimalModelRegistry;
	model?: string;
	config?: OrchestratorConfig;
	ui?: {
		notify?: (msg: string, level: string) => void;
		setWorkingMessage: (msg?: string) => void;
		setStatus: (key: string, value: any) => void;
		theme: any;
	};
}

/** Diagnostic metrics for a subagent session (issue #68) */
export interface SubagentDiagnostic {
	schemaVersion: number;
	sessionId: string;
	timestamp: string;
	specialist: string;
	task: string;
	turns: number;
	toolCalls: number;
	elapsedMs: number;
	crashed: boolean;
	outputPreview: string;
	metrics: {
		readCalls: number;
		grepCalls: number;
		findCalls: number;
		bashCalls: number;
		editCalls: number;
		writeCalls: number;
		lsCalls: number;
		scopeViolations: number;
	};
	kind: 'silent_failure' | 'crash';
	diagnosticId: string;
	agentDir?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	httpStatus?: number;
}

/**
 * Session context required for plan-panel instance resolution.
 * Typed to match ExtensionContext shape with sessionManager from pi-coding-agent.
 * Callers should ensure sessionManager.getSessionId() returns a non-empty string.
 */
/** Readonly subset of SessionManager used for instance resolution. */
export type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "getHeader" | "getEntries" | "getTree" | "getSessionName">;

/** Context for plan-panel instance resolution.
 * Typed to match ExtensionContext shape with sessionManager from pi-coding-agent.
 * Callers should ensure sessionManager.getSessionId() returns a non-empty string.
 */
export interface SessionContext {
	sessionManager?: ReadonlySessionManager;
}

