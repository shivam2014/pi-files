/**
 * DelegateFeedBuilder — wraps activity-feed.ts for delegation context.
 * Provides a simple lifecycle API for tracking subagent tool activity:
 *   startDelegation → onToolCall* → onComplete → render
 *
 * Each call is mapped to the underlying activity-feed state machine.
 */

import type { ActivityFeedState } from "./types.ts";
import {
	createActivityFeed,
	addStep,
	addSubstep,
	completeCurrentStep,
	completeActiveSubstepWithLabel,
	updateActiveSubstepOutput,
	renderActivityFeed,
	toolCallToSubstep,
} from "./activity-feed.ts";

export class DelegateFeedBuilder {
	private state: ActivityFeedState | null = null;
	private specialist: string = "";
	private task: string = "";
	private toolCallHistory: Array<{ tool: string; input: unknown }> = [];

	/** Current feed state (null if no delegation started). */
	getState(): ActivityFeedState | null {
		return this.state;
	}

	/** Specialist name from last startDelegation. */
	getSpecialist(): string {
		return this.specialist;
	}

	/** Task from last startDelegation. */
	getTask(): string {
		return this.task;
	}

	/** Ordered list of tool calls received via onToolCall. */
	getToolCallHistory(): Array<{ tool: string; input: unknown }> {
		return this.toolCallHistory;
	}

	/** Begin a delegation. Creates fresh feed state with goal set. */
	startDelegation(specialist: string, task: string): void {
		this.specialist = specialist;
		this.task = task;
		this.toolCallHistory = [];

		let feed = createActivityFeed();
		feed = { ...feed, goal: `${specialist}: ${task}` };
		feed = addStep(feed, task);
		this.state = feed;
	}

	/** Record a tool call as a substep in the current step. Completes any prior active substep. */
	onToolCall(toolName: string, input: unknown): void {
		if (!this.state) return;

		const label = toolCallToSubstep(toolName, input);
		// Complete the previous active substep if one exists
		const prevLabel = this.state.steps[this.state.currentStep]?.substeps.find(s => !s.completed)?.label ?? "";
		this.state = completeActiveSubstepWithLabel(this.state, prevLabel);
		// Add the new substep
		this.state = addSubstep(this.state, label);
		this.toolCallHistory.push({ tool: toolName, input });
	}

	/** Record a finding as a substep. */
	onReportFinding(finding: { summary: string; key_files: string[] }): void {
		if (!this.state) return;
		this.state = addSubstep(this.state, `Finding: ${finding.summary}`);
	}

	/** Record a question to the orchestrator as a substep. */
	onAskOrchestrator(question: string): void {
		if (!this.state) return;
		this.state = addSubstep(this.state, `Asking orchestrator: ${question}`);
	}

	/** Complete the active orchestrator question substep with the answer. */
	onAskOrchestratorComplete(answer: string): void {
		if (!this.state) return;
		this.state = completeActiveSubstepWithLabel(this.state, `Orchestrator: ${answer}`);
	}

	/** Set output detail/preview on the active substep. */
	setDetail(detail: string): void {
		if (!this.state) return;
		this.state = updateActiveSubstepOutput(this.state, detail);
	}

	/** Complete the delegation — finishes all open steps/substeps. */
	onComplete(output?: string): void {
		if (!this.state) return;
		// Complete the last active substep with output preview
		const prevLabel = this.state.steps[this.state.currentStep]?.substeps.find(s => !s.completed)?.label ?? "";
		this.state = completeActiveSubstepWithLabel(this.state, prevLabel, output);
		// Complete the current step
		this.state = completeCurrentStep(this.state);
	}

	/** Render the current feed state. Returns empty string if no delegation active. */
	render(): string {
		if (!this.state) return "";
		return renderActivityFeed("delegate", this.state);
	}
}
