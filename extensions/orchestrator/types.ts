/**
 * Shared types for the orchestrator extension.
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md
 */

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
	label: string;
	completed: boolean;
	startTime?: number;
	endTime?: number;
}

/** A step in the activity feed (Layer 2 chat blocks) */
export interface Step {
	label: string;
	completed: boolean;
	substeps: Substep[];
	startTime?: number;
	endTime?: number;
}

/** Activity feed state for subagent tool blocks */
export interface ActivityFeedState {
	goal: string;
	steps: Step[];
	currentStep: number;
	rawText: string;
}

/** Specialist definition */
export interface Specialist {
	name: string;
	tools: string[];
	model?: string;
	systemPrompt: string;
}

/** Context passed to subagent runner */
export interface SubagentContext {
	modelRegistry?: any;
	model?: any;
}

/** A step in the plan panel header */
export interface PlanStep {
	label: string;
	completed: boolean;
	active: boolean;
	errored?: boolean;
}

/** Scope enforcement manifest — limits which files the coder can modify */
export interface Scope {
	filesToModify: string[];
	filesToCreate: string[];
	changeType: "single-file" | "multi-file";
	maxLinesPerFile: number;
}
