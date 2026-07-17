/**
 * Subagent runner — creates isolated subagent sessions for specialist delegation.
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md
 *
 * NEW: Captures lint-guard custom messages from subagent and forwards via onUpdate.
 * NEW: Accepts optional scope param to write .pi/scope.json before subagent creation.
 */

import { getModel } from "@earendil-works/pi-ai/compat";
import {
	ModelRuntime,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { subagentSessions } from "./subagent-sessions.ts";
import { shortenLabel } from "../token-saver.ts";
import type { Specialist, SubagentContext, Substep, DelegateControllerContext } from "./types.ts";
import { resolveSpecialistModel, DEFAULTS } from "./orchestrator-config.ts";
import type { Scope } from "./scope-manager.ts";
import { buildSkillSection } from "./specialists.ts";
import {
	ActivityFeed,
	toolCallToSubstep,
	substepToolDetail,
	renderSubstepLines,
	appendWebSearchResults,
	compressOutput,
} from "./activity-feed.ts";
import { statusIcon } from "./orchestrator-theme.ts";

import { currentFrame, SPINNER_INTERVAL_MS, resetSpinner } from "./spinner-state.ts";

import { updatePlanStepDetail, recordTimelineFrame } from "./plan-panel.ts";

import { debugLog } from "./debug.ts";
import { setViewerSession, updatePeek, setViewerOutput, setViewerError, clearViewerState, pushStreamingText } from "./peek-overlay.ts";
import { gitReadTool, ghTool } from "./scout-tools.ts";
import { createReadSkillTool } from "./read-skill-tool.ts";

/** Optional orchestrator UI for dynamic status messages */
export interface OrchestratorUi {
	setWorkingMessage: (msg?: string) => void;
	setStatus: (key: string, value: any) => void;
	theme: any;
}

/** @deprecated Use SubagentRunner.SUBAGENT_ENV_KEY internally. Kept for backward-compat. */
export const SUBAGENT_ENV_KEY = "PI_ORCHESTRATOR_SUBAGENT";

/**
 * Resolve skill names to existing SKILL.md paths under agentDir.
 * Filters out skills whose SKILL.md doesn't exist on disk.
 */
export function resolveSkillPaths(skills: string[], agentDir: string): string[] {
	return skills
		.map(s => join(agentDir, 'skills', s, 'SKILL.md'))
		.filter(existsSync);
}

export const OUTPUT_CAP = 80_000;
const PER_RESULT_CAP = 2000;

/**
 * Extract the last occurrence of a markdown section starting with `heading`.
 * Section runs until the next `## ` heading or end of output.
 */
function extractLastSection(output: string, heading: string): string | null {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`(?:^|\\n)${escaped}(?:\\r?\\n|$)`, "g");
	let match: RegExpExecArray | null;
	let lastIdx = -1;
	while ((match = regex.exec(output)) !== null) {
		lastIdx = match.index;
	}
	if (lastIdx === -1) return null;

	const afterHeading = output.indexOf("\n", lastIdx + heading.length);
	let end = output.length;
	if (afterHeading !== -1) {
		const nextHeading = output.indexOf("\n## ", afterHeading + 1);
		if (nextHeading !== -1) end = nextHeading;
	}
	return output.slice(lastIdx, end).trimEnd();
}

/**
 * Structured output truncation that preserves trailing `## Findings` and
 * `## Audit` sections and appends a clear marker.
 */
export function truncateSubagentOutput(output: string, cap = OUTPUT_CAP): string {
	if (output.length <= cap) return output;

	const markerText = `[output truncated at ${cap} chars; tail preserved]`;
	const tailParts: string[] = [];
	for (const heading of ["## Findings", "## Audit"]) {
		const section = extractLastSection(output, heading);
		if (section) tailParts.push(section);
	}
	const tail = tailParts.join("\n\n");
	const tailBlock = tail ? "\n\n" + tail : "";
	const suffixLength = 2 + markerText.length + tailBlock.length; // "\n\n" before marker
	const headBudget = cap - suffixLength;
	if (headBudget <= 0) {
		// Tail alone exceeds cap — fall back to plain head truncation.
		return output.slice(0, cap - markerText.length) + markerText;
	}

	const head = output.slice(0, headBudget);
	const lastNewline = head.lastIndexOf("\n");
	const cleanHead = lastNewline > 0 ? head.slice(0, lastNewline) : head;
	return cleanHead + "\n\n" + markerText + tailBlock;
}




/**
 * Create the ask_orchestrator tool that only subagents see.
 * Pauses the subagent session until the orchestrator resolver returns an answer.
 */
export function createAskOrchestratorTool(
	resolve: ((question: string, context?: string) => Promise<string>) | undefined,
	onUpdate: ((update: any) => void) | undefined,
	specialistName: string,
	feed: ActivityFeed,
) {
	return defineTool({
		name: "ask_orchestrator",
		label: "Ask Orchestrator",
		description: "Pause the subagent and ask the orchestrator a clarification question. The orchestrator answers from context and the codebase. If it cannot answer, report the question back to the orchestrator in your final output.",
		parameters: Type.Object({
			question: Type.String({ description: "The clarification question for the orchestrator" }),
			context: Type.Optional(Type.String({ description: "Optional extra context to help answer the question" })),
		}),
		async execute(_toolCallId: string, params: { question: string; context?: string }) {
			if (!resolve) {
				return {
					content: [{ type: "text" as const, text: "[error] ask_orchestrator is not wired to an orchestrator resolver." }],
					details: {},
				};
			}

			const label = toolCallToSubstep("ask_orchestrator", params);
			feed.updateActiveSubstepOutput("Waiting for orchestrator...");
			onUpdate?.({
				content: [{ type: "text", text: feed.render(specialistName) }],
				details: { status: "clarifying", label },
			});

			const answer = await resolve(params.question, params.context);
			const answerPreview = answer.slice(0, 80);

			feed.completeActiveSubstepWithLabel(`Clarified: ${answerPreview}`, answerPreview, false, true);
			const text = feed.render(specialistName);
			onUpdate?.({
				content: [{ type: "text", text }],
				details: { status: "clarified", answer },
			});

			return {
				content: [{ type: "text" as const, text: answer }],
				details: {},
			};
		},
	});
}

/**
 * Capture a shallow copy of the current process environment.
 */
export function snapshotSubagentEnv(): NodeJS.ProcessEnv {
	return { ...process.env };
}

/**
 * Return a cleaned env that strips orchestrator-specific vars and any
 * internal PI_* tokens so they do not leak into subagent child processes.
 */
export function cleanSubagentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const cleaned: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (key === SUBAGENT_ENV_KEY || key.startsWith("PI_")) continue;
		cleaned[key] = value;
	}
	return cleaned;
}

/**
 * Replace the active process.env with the provided snapshot.
 */
export function installSubagentEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(process.env)) {
		delete process.env[key];
	}
	Object.assign(process.env, env);
}
/**
 * Configuration options for SubagentRunner.
 * All config properties are immutable after construction.
 */
export interface SubagentRunnerConfig {
	cwd: string;
	modelRegistry: ModelRegistry;
	agentDir: string;
	signal?: AbortSignal;
	onUpdate?: (update: any) => void;
	agentSessionFactory?: (options: {
		cwd: string;
		model: any;
		tools: string[];
		customTools: any[];
		excludeTools: string[] | undefined;
		resourceLoader: any;
		sessionManager: any;
		modelRuntime: any;
	}) => Promise<{ session: any }>;
}

export type SubagentResult = {
	output: string;
	turns: number;
	elapsed_ms?: number;
	toolCallTrail?: { tool: string; outputPreview?: string; completed: boolean }[];
	stopReason?: string;
	errorMessage?: string;
	model?: string;
};
/**
 * SubagentRunner — creates isolated subagent sessions for specialist delegation.
 *
 * Owns an ActivityFeed instance for the run duration.
 */
export class SubagentRunner {
	private config: SubagentRunnerConfig;
	private feed: ActivityFeed;
	private static readonly SUBAGENT_ENV_KEY = "PI_ORCHESTRATOR_SUBAGENT";

	constructor(config: SubagentRunnerConfig) {
		this.config = config;
		this.feed = new ActivityFeed();
	}

	/** Snapshot env — delegates to module-level snapshotSubagentEnv. */
	private snapshotEnv(): NodeJS.ProcessEnv {
		return snapshotSubagentEnv();
	}

	/** Clean env — delegates to module-level cleanSubagentEnv. */
	private cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
		return cleanSubagentEnv(env);
	}

	/** Install env — delegates to module-level installSubagentEnv. */
	private installEnv(env: NodeJS.ProcessEnv): void {
		installSubagentEnv(env);
	}

	async run(
		task: string,
		specialist: Specialist,
		scope?: Scope,
		suggestedSkills?: string[],
		parentCtx?: SubagentContext,
		orchestratorCtx?: DelegateControllerContext,
		orchestratorUi?: OrchestratorUi,
	): Promise<SubagentResult> {
		const startTime = Date.now();
		let envSnapshot: NodeJS.ProcessEnv;
		let sessionId: string | undefined;
		const { config } = this;
		const feed = this.feed;

		try {
			const modelRegistry = config.modelRegistry;

			// Resolve model: config override > specialist.model > parent's model > registry fallback
			let model;
			const configModel = resolveSpecialistModel(
				orchestratorCtx?.config ?? DEFAULTS,
				specialist.name,
				specialist.model,
			);

			if (configModel) {
				const slashIdx = configModel.indexOf("/");
				if (slashIdx > 0) {
					const provider = configModel.slice(0, slashIdx);
					const modelId = configModel.slice(slashIdx + 1);
					model = modelRegistry.find(provider, modelId);
				}
			} else if (parentCtx?.model) {
				model = parentCtx.model;
			}

			if (!model) {
				const available = modelRegistry.getAvailable();
				if (available.length > 0) {
					model = available[0];
				}
			}

			if (!model) {
				return { output: "[error] No model available for subagent. Check API key configuration.", turns: 0 };
			}

			// Snapshot, clean, and install isolated env for the subagent session.
			envSnapshot = this.snapshotEnv();
			this.installEnv(this.cleanEnv(envSnapshot));

			// Resolve skill names to paths for DefaultResourceLoader, filtering to existing files
			const resolvedSkillPaths = (suggestedSkills ?? [])
				.map(s => join(config.agentDir, 'skills', s, 'SKILL.md'))
				.filter(existsSync);

			// Load extensions for subagent, flag context so orchestrator skips re-registration
			process.env[SubagentRunner.SUBAGENT_ENV_KEY] = "1";
			let loader: DefaultResourceLoader | undefined;
			try {
				loader = new DefaultResourceLoader({
					cwd: config.cwd,
					agentDir: config.agentDir,
					additionalSkillPaths: resolvedSkillPaths,
					systemPromptOverride: () => {
						let prompt = specialist.systemPrompt;
						if (scope) {
							const filesToModify = Array.isArray(scope.filesToModify) ? scope.filesToModify : [];
							const filesToCreate = Array.isArray(scope.filesToCreate) ? scope.filesToCreate : [];
							const modFiles = filesToModify.length > 0 ? filesToModify.map(f => `  - ${f}`).join('\n') : '  - (none)';
							const createFiles = filesToCreate.length > 0 ? filesToCreate.map(f => `  - ${f}`).join('\n') : '  - (none)';
							const dirs = Array.isArray(scope.directories) && scope.directories.length > 0 ? scope.directories.join(', ') : '(none)';
							prompt += `\n\n## Scope Restrictions\nYou may ONLY modify/create files within this scope:\n- Files to modify:\n${modFiles}\n- Files to create:\n${createFiles}\n- Allowed directories: ${dirs}\n- Max files: ${scope.maxFiles ?? 10}\n- Changes beyond scope require approval: ${scope.requiresApprovalBeyondScope ?? true}\n`;
							if (scope.changeType) {
								prompt += `- Change type: ${scope.changeType} (${scope.changeType === 'single-file' ? 'edit one file' : 'may edit multiple files'})\n`;
							}
							if (scope.maxLinesPerFile) {
								prompt += `- Max lines per file: ${scope.maxLinesPerFile}\n`;
							}
							if (scope.boundaries) {
								prompt += `- Boundaries: ${scope.boundaries}\n`;
							}
						}
						if (suggestedSkills && suggestedSkills.length > 0) {
							prompt += buildSkillSection(specialist.name, suggestedSkills);
						}
						return prompt;
					},
					noContextFiles: true,
				});
				await loader.reload();
			} finally {
				delete process.env[SubagentRunner.SUBAGENT_ENV_KEY];
			}

			const excludeTools = (specialist.name === "writer" || specialist.name === "researcher" || specialist.name === "scout")
				? ["bash"]
				: undefined;

			let output = "";
			let turns = 0;
			let _lastFeedSnapshot: string | null = null;
			const goal = shortenLabel(task);
			feed.feedState = { ...feed.feedState, goal };

			// Define planSteps tool
			const planStepsTool = defineTool({
				name: "planSteps",
				label: "Plan Steps",
				description: "Register your plan for this task. Call this ONCE at the start before making any tool calls.",
				parameters: Type.Object({
					goal: Type.String({ description: "One-line goal for this task" }),
					steps: Type.Array(Type.String(), { description: "Ordered list of step descriptions (what you'll do, not tool commands)" })
				}),
				execute: async (_toolCallId: string, params: { goal: string; steps: string[] }) => {
					if (!feed.planParsed) {
						feed.feedState = {
							...feed.feedState,
							goal: params.goal,
							steps: params.steps.map((label: string) => ({
								label,
								completed: false,
								substeps: [],
								startTime: Date.now()
							})),
							currentStep: 0,
							planParsed: true
						};
						const text = feed.render(specialist.name);
						config.onUpdate?.({ content: [{ type: "text", text }], details: { status: "plan_set" } });
					}
					return { content: [{ type: "text", text: `Plan registered with ${params.steps.length} steps` }], details: {} };
				}
			});

			// Define advanceStep tool
			const advanceStepTool = defineTool({
				name: "advanceStep",
				label: "Advance Step",
				description: "Mark the current step as complete and advance to the next step. Call this after each step finishes.",
				parameters: Type.Object({}),
				execute: async (_toolCallId: string, _params: Record<string, never>) => {
					if (!feed.planParsed) {
						return { content: [{ type: "text" as const, text: "Error: planSteps() must be called first" }], details: {} };
					}
					if (feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
						feed.completeCurrentStep();
						const nextLabel = feed.currentStep < feed.steps.length
							? feed.steps[feed.currentStep].label
							: "All steps complete";
						const text = feed.render(specialist.name);
						config.onUpdate?.({ content: [{ type: "text", text }], details: { status: "step_advanced" } });
						return { content: [{ type: "text", text: `Step complete. Next: ${nextLabel}` }], details: {} };
					}
					return { content: [{ type: "text", text: "No active step to complete" }], details: {} };
				}
			});

			// Define reportFinding tool
			const reportFindingTool = defineTool({
				name: "reportFinding",
				label: "Report Finding",
				description: "Report an important finding discovered during execution. Call this when you discover something noteworthy.",
				parameters: Type.Object({
					finding: Type.String({ description: "What you discovered" }),
				}),
				execute: async (_toolCallId: string, params: { finding: string }) => {
					if (!feed.planParsed) {
						return { content: [{ type: "text" as const, text: "Error: planSteps() must be called first" }], details: {} };
					}
					if (feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
						const step = feed.steps[feed.currentStep];
						const newSubstep: Substep = {
							label: params.finding,
							completed: true,
							isReport: true,
							startTime: Date.now(),
							endTime: Date.now(),
						};
						const newSubsteps = [...step.substeps, newSubstep];
						const newSteps = feed.steps.map((s, i) =>
							i === feed.currentStep ? { ...s, substeps: newSubsteps } : s
						);
						feed.feedState = { ...feed.feedState, steps: newSteps };
						const text = feed.render(specialist.name);
						config.onUpdate?.({ content: [{ type: "text", text }], details: { status: "report" } });
						return { content: [{ type: "text", text: `${statusIcon("completed")} Reported: ${params.finding}` }], details: {} };
					}
					return { content: [{ type: "text", text: "No active step" }], details: {} };
				},
			});

			const allTools = [...(specialist.tools || []), "planSteps", "advanceStep", "reportFinding", "ask_orchestrator", "read_skill", "vision_query", "glob"];

			const askOrchestratorTool = createAskOrchestratorTool(
				parentCtx?.onAskOrchestrator,
				config.onUpdate,
				specialist.name,
				feed,
			);

			const createSession = config.agentSessionFactory ?? createAgentSession;
			const { session } = await createSession({
				cwd: config.cwd,
				model,
				tools: allTools,
				customTools: [
					planStepsTool,
					advanceStepTool,
					reportFindingTool,
					askOrchestratorTool,
					createReadSkillTool(),
					...(["scout", "researcher"].includes(specialist.name) ? [gitReadTool, ghTool] : []),
				],
				excludeTools,
				resourceLoader: loader!,
				sessionManager: SessionManager.inMemory(config.cwd),
				modelRuntime: await ModelRuntime.create(),
			});

			// Register session in per-session Map for concurrent-safe routing
			const sessionId = session.sessionId as string;
			subagentSessions.set(sessionId, { specialistName: specialist.name, planParsed: false });

			const { signal } = config;

			// Register feed for peek overlay
			const peekAbort = new AbortController();
			setViewerSession(session, task.length > 60 ? task.slice(0, 57) + "..." : task);
			signal?.addEventListener("abort", () => peekAbort.abort(), { once: true });
			peekAbort.signal.addEventListener("abort", () => { try { session.abort(); } catch {} }, { once: true });

			let lastStopReason: string | undefined;
			let lastErrorMessage: string | undefined;

			const unsubscribe = session.subscribe((event: any) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					output += event.assistantMessageEvent.delta;
					const snapshot = JSON.stringify(feed.inspectState());
					if (snapshot !== _lastFeedSnapshot) {
						_lastFeedSnapshot = snapshot;
						resetSpinner();
						updatePlanStepDetail(feed.goal || "", orchestratorCtx);
						recordTimelineFrame("step_started", feed.inspectState(), feed.snapshotRender(), orchestratorCtx);
					}
					pushStreamingText(event.assistantMessageEvent.delta);
					const textDelta = feed.render(specialist.name);
					config.onUpdate?.({
						content: [{ type: "text", text: textDelta }],
						details: { status: "running", streaming: true },
					});
				}

				if (event.type === "message_end") {
					if (event.message?.role === "assistant") {
						turns++;
						const assistantMsg = event.message as any;
						lastStopReason = assistantMsg.stopReason;
						lastErrorMessage = assistantMsg.errorMessage;
						const text = feed.render(specialist.name);
						config.onUpdate?.({
							content: [{ type: "text", text }],
							details: { specialist: specialist.name, status: "running", turns },
						});
					}

					const lintMsg = (event as any).message;
					if (lintMsg?.role === "tool" && lintMsg?.toolName === "lint") {
						const lintContent = typeof lintMsg.content === "string"
							? lintMsg.content
							: JSON.stringify(lintMsg.content ?? "");
						feed.addSubstep(lintContent.slice(0, 80));
						feed.completeLastSubstep();
						output += "\n" + lintContent + "\n";
						config.onUpdate?.({
							content: typeof lintMsg.content === "string"
								? [{ type: "text", text: lintMsg.content }]
								: (lintMsg.content ?? []),
							details: { specialist: specialist.name, status: "lint", ...(lintMsg.details ?? {}) },
						});
					}
				}

				if (event.type === "tool_execution_start") {
					if (event.toolName === "planSteps" || event.toolName === "advanceStep" || event.toolName === "reportFinding") return;
					const substepLabel = toolCallToSubstep(event.toolName, event.args);
					feed.addSubstep(substepLabel, event.toolCallId);
					const extraDetail = substepToolDetail(event.toolName, event.args);
					feed.setToolDetail(extraDetail ?? substepLabel);
					recordTimelineFrame("tool_start", feed.inspectState(), feed.snapshotRender(), orchestratorCtx);
					_lastFeedSnapshot = null;
					updatePeek(`\u2192 ${event.toolName}\n`);
					const activeStep = feed.steps[feed.currentStep];
					if (activeStep) {
						updatePlanStepDetail(renderSubstepLines(activeStep.substeps), orchestratorCtx);
					} else {
						updatePlanStepDetail(substepLabel, orchestratorCtx);
					}
					const text = feed.render(specialist.name);
					config.onUpdate?.({
						content: [{ type: "text", text }],
						details: { specialist: specialist.name, status: "running", tool: event.toolName },
					});
				}

				if (event.type === "tool_execution_update") {
					try {
						if (event.partialResult && feed.steps.length > 0) {
							const activeStep = feed.steps[feed.currentStep];
							if (activeStep && activeStep.substeps.length > 0) {
								if (!activeStep.substeps[activeStep.substeps.length - 1].completed) {
									const preview = event.partialResult.length > 80
										? event.partialResult.slice(0, 77) + "..."
										: event.partialResult;
									feed.updateActiveSubstepOutput(preview);
									const newActiveStep = feed.steps[feed.currentStep];
									if (newActiveStep) {
										updatePlanStepDetail(renderSubstepLines(newActiveStep.substeps), orchestratorCtx);
									}
									const text = feed.render(specialist.name);
									config.onUpdate?.({ content: [{ type: "text", text }], details: { specialist: specialist.name, status: "running", tool: event.toolName } })
								}
							}
						}
					} catch (e) { debugLog("[subagent] update failed:", e); }
				}

				if (event.type === "tool_execution_end") {
					if (event.toolName === "planSteps" || event.toolName === "advanceStep" || event.toolName === "reportFinding") {
						const text = feed.render(specialist.name);
						config.onUpdate?.({ content: [{ type: "text", text }], details: { specialist: specialist.name, status: "running" } });
						return;
					}
					let outputPreview: string | undefined;
					let rawResult: any;
					let stripped: string | undefined;
					try {
						rawResult = event.result ?? (event as any).output;
						if (rawResult != null) {
							const raw = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
							stripped = compressOutput(raw);
							outputPreview = stripped.length > 80 ? stripped.slice(0, 77) + "..." : stripped || undefined;
						}
					} catch {}
					// Append tool result to output for complete delegation results
					if (rawResult != null && stripped != null) {
						const cappedResult = stripped.length > PER_RESULT_CAP
							? stripped.slice(0, PER_RESULT_CAP - 50) + "\n...[tool result truncated at " + PER_RESULT_CAP + " chars]"
							: stripped;
						output += "\n[tool result]\n" + cappedResult + "\n[/tool result]\n";
					}
					const isError = (event as any).isError === true;
					if (isError && rawResult != null) {
						if (typeof rawResult === "string") {
							outputPreview = rawResult;
						} else if (rawResult.content && Array.isArray(rawResult.content) && rawResult.content[0]?.text) {
							outputPreview = rawResult.content[0].text;
						} else {
							outputPreview = JSON.stringify(rawResult);
						}
					}
					feed.clearToolDetail();
					let completedWithLabel = false;
					if (event.toolName === "web_search" && !isError) {
						const totalResults = (event.result as any)?.details?.totalResults;
						if (typeof totalResults === "number") {
							const step = feed.steps[feed.currentStep];
							const sub = step?.substeps?.find(s => !s.completed);
							if (sub?.label) {
								feed.completeActiveSubstepWithLabel(appendWebSearchResults(sub.label, totalResults), outputPreview, isError);
								completedWithLabel = true;
							}
						}
					}
					if (!completedWithLabel) {
						feed.completeSubstepByToolCallId((event as any).toolCallId, outputPreview, isError);
					}
					if (!isError && (event.toolName === "edit" || event.toolName === "write")) {
						feed.addSubstep(`lint: checking ${(event as any).arguments?.filePath ?? (event as any).arguments?.path ?? "files"}...`);
					}
					recordTimelineFrame("tool_end", feed.inspectState(), feed.snapshotRender(), orchestratorCtx);
					_lastFeedSnapshot = null;
					updatePeek(`\u2713 ${event.toolName}\n`);
					const activeStep = feed.steps[feed.currentStep];
					if (activeStep && activeStep.substeps.length > 0) {
						updatePlanStepDetail(renderSubstepLines(activeStep.substeps), orchestratorCtx);
					}
					const text = feed.render(specialist.name);
					config.onUpdate?.({
						content: [{ type: "text", text }],
						details: { specialist: specialist.name, status: "running" },
					});
				}

				if (event.type === "turn_end") {
					// No-op: turn_end handler kept for future use
				}
			});

			// Periodic re-render timer
			let renderTimer: ReturnType<typeof setInterval> | null = null;
			let _lastRenderText: string | null = null;
			let _lastFrame: string = "";

			const startRenderTimer = () => {
				renderTimer = setInterval(() => {
					if (feed.steps.length > 0 || output.length > 0) {
						const text = feed.render(specialist.name);
						const frame = currentFrame();
						if (frame !== _lastFrame || text !== _lastRenderText) {
							_lastRenderText = text;
							_lastFrame = frame;
							config.onUpdate?.({
								content: [{ type: "text", text }],
								details: { specialist: specialist.name, status: "running" },
							});
						}
					}
				}, SPINNER_INTERVAL_MS);
			};
			startRenderTimer();

			// Abort handler
			const abortHandler = () => { session.abort(); };
			if (signal) {
				if (signal.aborted) abortHandler();
				signal.addEventListener("abort", abortHandler, { once: true });
			}

			let finalStatus = "completed";

			try {
				await session.prompt(task);

				if (lastStopReason === "error") {
					const errorMsg = lastErrorMessage || "Unknown model error";
					finalStatus = "error";
					output = `[error] ${errorMsg}`;
					feed.markFeedError(errorMsg);
					setViewerError(errorMsg);
					const errorText = feed.render(specialist.name) ?? errorMsg;
					config.onUpdate?.({content: [{ type: "text", text: errorText }],
						details: { specialist: specialist.name, status: "error", error: errorMsg },
					});
				} else {
					finalStatus = "completed";
				}
			} catch (error) {
				const isAborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
				const errorMsg = lastErrorMessage && typeof lastErrorMessage === 'string' && lastErrorMessage.length > 0
					? lastErrorMessage
					: error instanceof Error ? error.message : String(error);
				finalStatus = isAborted ? "aborted" : "error";
				feed.markFeedError(errorMsg);
				setViewerError(errorMsg);
				const errorText = feed.render(specialist.name) ?? errorMsg;
				config.onUpdate?.({content: [{ type: "text", text: errorText }],
					details: { specialist: specialist.name, status: isAborted ? "aborted" : "error", error: errorMsg },
				});
				output = isAborted
					? `[aborted] Interrupted by user${errorMsg && !errorMsg.toLowerCase().includes("abort") ? ` (${errorMsg})` : ""}`
					: `[error] ${errorMsg}`;
			} finally {
				unsubscribe();
				if (renderTimer) {
					clearInterval(renderTimer);
					renderTimer = null;
				}
				_lastRenderText = null;
				if (signal) signal.removeEventListener("abort", abortHandler);

				// ── Flight Recorder: dump full session conversation for post-hoc debugging ──
				try {
					const debugDir = '/tmp/orchestrator-debug';
					try { mkdirSync(debugDir, { recursive: true }); } catch {}
					const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
					const filename = `delegation-${timestamp}-${specialist.name}.json`;
					const dump = {
						specialist: specialist.name,
						task,
						timestamp: new Date().toISOString(),
						sessionId,
						model: (model as any)?.id ?? (model as any)?.model ?? undefined,
						turns,
						elapsedMs: Date.now() - startTime,
						stopReason: lastStopReason,
						errorMessage: lastErrorMessage,
						finalStatus,
						messages: session.messages,
					};
					writeFileSync(join(debugDir, filename), JSON.stringify(dump, null, 2));
				} catch (e) {
					// Best-effort — never let debugging dump failure break the delegation
				}

				session.dispose();
				clearViewerState();
			}

			if (finalStatus !== "error" && finalStatus !== "aborted") {
				while (feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
					feed.completeCurrentStep();
				}
			}

			const finalText = feed.render(specialist.name);
			config.onUpdate?.({ content: [{ type: "text", text: finalText }], details: { specialist: specialist.name, status: finalStatus } });
			recordTimelineFrame("step_finalized", feed.inspectState(), feed.snapshotRender(), orchestratorCtx);

			const finalOutput = truncateSubagentOutput(compressOutput(output || "(no output)"), OUTPUT_CAP);

			setViewerOutput(output);

			const toolCallTrail: { tool: string; outputPreview?: string; completed: boolean }[] = [];
			for (const step of feed.steps) {
				for (const sub of step.substeps) {
					toolCallTrail.push({
						tool: sub.label,
						outputPreview: sub.outputPreview,
						completed: sub.completed,
					});
				}
			}

			return { output: finalOutput, turns, elapsed_ms: Date.now() - startTime, toolCallTrail, stopReason: lastStopReason, errorMessage: lastErrorMessage, model: (model as any)?.id ?? (model as any)?.model ?? undefined };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : "";
			return {
				output: `[error] Subagent init failed: ${msg}${stack ? "\n" + stack.split("\n").slice(0, 5).join("\n") : ""}`,
				turns: 0,
			};
		} finally {
			subagentSessions.delete(sessionId!);
			this.installEnv(envSnapshot!);
		}
	}
}

/**
 * Run a specialist subagent with isolated session.
 *
 * @param specialist - The specialist definition (tools, system prompt)
 * @param task - The task description passed to the subagent
 * @param cwd - Working directory
 * @param parentCtx - Optional parent context (model registry, model)
 * @param signal - Optional abort signal for cancellation
 * @param onUpdate - Callback for real-time activity feed updates
 * @param scope - Optional scope manifest for scope-guard enforcement
 */
export async function runSubagent(
	specialist: Specialist,
	task: string,
	cwd: string,
	parentCtx?: SubagentContext,
	signal?: AbortSignal,
	onUpdate?: (update: any) => void,
	scope?: Scope | null,
	orchestratorUi?: OrchestratorUi,
	suggestedSkills?: string[],
	orchestratorCtx?: DelegateControllerContext,
): Promise<SubagentResult> {
	const agentDir = getAgentDir();
	const runner = new SubagentRunner({
		cwd,
		modelRegistry: parentCtx?.modelRegistry ?? new ModelRegistry(await ModelRuntime.create()),
		agentDir,
		signal,
		onUpdate,
	});
	return runner.run(task, specialist, scope ?? undefined, suggestedSkills, parentCtx, orchestratorCtx, orchestratorUi);
}
