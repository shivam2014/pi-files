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
import { statusIcon, formatTokens } from "./orchestrator-theme.ts";

import { currentFrame, SPINNER_INTERVAL_MS, resetSpinner } from "./spinner-state.ts";

import { updatePlanStepDetail, recordTimelineFrame } from "./plan-panel.ts";

import { debugLog } from "./debug.ts";
import { LoopWatchdog, pushPhase, popPhase, resetPhaseTracker } from "./loop-watchdog.ts";
import { setViewerSession, updatePeek, setViewerOutput, setViewerError, clearViewerState, pushStreamingText, setViewerTokens } from "./peek-overlay.ts";
import { gitReadTool, ghTool } from "./scout-tools.ts";
import { createReadSkillTool } from "./read-skill-tool.ts";

/**
 * Timer-based progress emission coalescer.
 *
 * Instead of checking Date.now() - lastEmit >= threshold (which still emits
 * immediately when threshold has passed), this uses a deferred emission model:
 * 1. When any event wants to emit progress, call schedule()
 * 2. If a timer is already armed, do nothing (pending emit will include this update)
 * 3. If no timer armed, schedule one for coalesceMs ahead
 * 4. When timer fires: call the actual emit function, clear the timer
 * 5. Naturally batches bursts: 9 calls in 10ms -> 1 emission 150ms later
 */
class ProgressScheduler {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly coalesceMs: number;
	private readonly emit: () => void;

	constructor(emit: () => void, coalesceMs: number = 150) {
		this.emit = emit;
		this.coalesceMs = coalesceMs;
	}

	schedule(): void {
		if (this.timer !== null) return; // Already armed - pending emit will cover this
		this.timer = setTimeout(() => {
			this.timer = null;
			this.emit();
		}, this.coalesceMs);
	}

	/** Force an immediate emission, canceling any pending timer. */
	flush(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.emit();
	}

	/** Cancel any pending timer without emitting. */
	dispose(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}

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
 * Determine whether a subagent that stopped early should be nudged to continue.
 * Returns true only when the stop is non-error, steps remain incomplete,
 * and we haven't already nudged this session.
 */
export function shouldNudge(lastStopReason: string, stepsIncomplete: boolean, alreadyNudged: boolean): boolean {
	return lastStopReason === "stop" && stepsIncomplete && !alreadyNudged;
}

/**
 * Build the flight recorder dump object for post-hoc debugging.
 */
export function createFlightRecorderDump(params: FlightRecorderDumpParams): Record<string, any> {
	return {
		specialist: params.specialist,
		task: params.task,
		timestamp: new Date().toISOString(),
		sessionId: params.sessionId,
		model: params.model,
		turns: params.turns,
		elapsedMs: params.elapsedMs,
		stopReason: params.stopReason,
		errorMessage: params.errorMessage,
		finalStatus: params.finalStatus,
		messages: params.messages,
		scope: params.scope,
		toolCallTrail: params.toolCallTrail ?? [],
		blockedCalls: params.blockedCalls ?? [],
		planSteps: params.planSteps ?? [],
		metrics: params.metrics ?? {},
		tokenSummary: params.tokenSummary ?? { totalInput: 0, totalOutput: 0, totalCached: 0, ctxTokensFinal: 0 },
		systemPrompt: params.systemPrompt,
		activityFeed: params.activityFeed,
	};
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
	metrics?: Record<string, number>;
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
	scopeNotes?: import('./types.ts').ScopeNotes;
	tokenUsage?: { input: number; output: number; cached: number };
	hasLintFailures?: boolean;
};

/** Parameters for createFlightRecorderDump */
export interface FlightRecorderDumpParams {
	specialist: string;
	task: string;
	sessionId?: string;
	model?: string;
	turns: number;
	elapsedMs: number;
	stopReason?: string;
	errorMessage?: string;
	finalStatus: string;
	messages: any[];
	scope?: Scope;
	systemPrompt?: string;
	activityFeed?: any;
	toolCallTrail?: Array<{ tool: string; label: string; input: any; output: string; isError: boolean; durationMs: number }>;
	blockedCalls?: Array<{ tool: string; target: string; reason: string; timestamp: number }>;
	planSteps?: Array<{ label: string; durationMs: number; completed: boolean }>;
	metrics?: Record<string, number>;
	tokenSummary?: { totalInput: number; totalOutput: number; totalCached: number; ctxTokensFinal: number };
}

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

			// Resolve model info for onUpdate metadata
			const modelId = (model as any)?.id ?? (model as any)?.model ?? 'unknown';
			const provider = typeof modelId === 'string' && modelId.includes('/') ? modelId.split('/')[0] : 'unknown';
			const modelLabel = typeof modelId === 'string' && modelId.includes('/') ? modelId.split('/')[1] || modelId : modelId;

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
						// Replace {sessionId} placeholder with actual session ID
						if (sessionId) {
							prompt = prompt.replace(/\{sessionId\}/g, sessionId);
						}
						return prompt;
					},
					noContextFiles: true,
				});
				await loader.reload();
			} finally {
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
						// Sync subagentSessions map so tool guard sees planParsed=true
						if (sessionId) {
							const sessionEntry = subagentSessions.get(sessionId);
							if (sessionEntry) {
								subagentSessions.set(sessionId, { ...sessionEntry, planParsed: true });
							}
						}
						const text = feed.render(specialist.name);
						config.onUpdate?.({ content: [{ type: "text", text }], details: { status: "plan_set", model: modelLabel, provider } });
					}
					return { content: [{ type: "text", text: `Plan registered with ${params.steps.length} steps` }], details: { stepCount: params.steps.length, goal: params.goal, status: "plan_set" } };
				}
			});

			// Define advanceStep tool
			const advanceStepTool = defineTool({
				name: "advanceStep",
				label: "Advance Step",
				description: "Mark the current step as complete and advance to the next step. Call this after each step finishes.",
				parameters: Type.Object({}),
				execute: async (_toolCallId: string, _params: Record<string, never>): Promise<{ content: { type: "text"; text: string }[]; details: { nextStep?: string; totalSteps?: number; allComplete?: boolean; status?: string } }> => {
					if (!feed.planParsed) {
						return { content: [{ type: "text" as const, text: "Error: planSteps() must be called first" }], details: {} };
					}
					if (feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
						feed.completeCurrentStep();
						const nextLabel = feed.currentStep < feed.steps.length
							? feed.steps[feed.currentStep].label
							: "All steps complete";
						const text = feed.render(specialist.name);
						config.onUpdate?.({ content: [{ type: "text", text }], details: { status: "step_advanced", model: modelLabel, provider } });
						return { content: [{ type: "text", text: `Step complete. Next: ${nextLabel}` }], details: { nextStep: nextLabel, totalSteps: feed.steps.length, allComplete: feed.currentStep >= feed.steps.length, status: "step_advanced" } };
					}
					return { content: [{ type: "text", text: "No active step to complete" }], details: { status: "no_active_step" } };
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
						config.onUpdate?.({ content: [{ type: "text", text }], details: { status: "report", model: modelLabel, provider } });
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
			sessionId = session.sessionId as string;
			subagentSessions.set(sessionId, { specialistName: specialist.name, planParsed: false, blockedCalls: [] });

			const { signal } = config;

			// Register feed for peek overlay
			const peekAbort = new AbortController();
			setViewerSession(session, task.length > 60 ? task.slice(0, 57) + "..." : task);
			signal?.addEventListener("abort", () => peekAbort.abort(), { once: true });
			peekAbort.signal.addEventListener("abort", () => { try { session.abort(); } catch {} }, { once: true });

			let hasLintFailures = false;
			let lastStopReason: string | undefined;
			let lastErrorMessage: string | undefined;
			let accInput = 0, accOutput = 0, accCached = 0;
			let ctxTokens = 0;
			let ctxWindow: number | undefined;
			const PROGRESS_COALESCE_MS = 150;

			// Timer-based progress coalescer — batches rapid emissions into one per window
			const progressScheduler = new ProgressScheduler(() => {
				const elapsed = Date.now() - startTime;
				feed.feedState = { ...feed.feedState, tokenInput: accInput, tokenOutput: accOutput, tokenCached: accCached, ctxTokens, ctxWindow };
				const text = feed.render(specialist.name);
				config.onUpdate?.({
					content: [{ type: "text", text }],
					details: { specialist: specialist.name, status: "running", turns, model: modelLabel, provider, tokenInput: accInput, tokenOutput: accOutput, tokenCached: accCached, ctxTokens, ctxWindow, elapsedMs: elapsed },
				});
				setViewerTokens({ input: accInput, output: accOutput, cached: accCached, ctxTokens, ctxWindow });
			}, PROGRESS_COALESCE_MS);

			const watchdog = new LoopWatchdog({
				onStall: (info) => { debugLog("[watchdog] loop-blocked:", info); },
			});
			resetPhaseTracker();

			const unsubscribe = session.subscribe((event: any) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					pushPhase("message_update");
					try {
						output += event.assistantMessageEvent.delta;
						const snapshot = JSON.stringify(feed.inspectState());
						if (snapshot !== _lastFeedSnapshot) {
							_lastFeedSnapshot = snapshot;
							resetSpinner();
							updatePlanStepDetail(feed.goal || "", orchestratorCtx);
							recordTimelineFrame("step_started", feed.inspectState(), feed.snapshotRender(), orchestratorCtx);
						}
						pushStreamingText(event.assistantMessageEvent.delta);
						progressScheduler.schedule();
					} finally {
						popPhase();
					}
				}

				if (event.type === "message_end") {
					pushPhase("message_end");
					try {
					if (event.message?.role === "assistant") {
						turns++;
						const assistantMsg = event.message as any;
						lastStopReason = assistantMsg.stopReason;
						lastErrorMessage = assistantMsg.errorMessage;
						// C1: Accumulate per-turn token usage
						const usage = (event.message as any).usage;
						if (usage) {
							accInput += usage.input || 0;
							accOutput += usage.output || 0;
							accCached += usage.cacheRead || 0;
							ctxTokens = usage.totalTokens || 0;
							if (!ctxWindow && model?.contextWindow) ctxWindow = model.contextWindow;
							progressScheduler.schedule();
						}
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
							details: { specialist: specialist.name, status: "lint", model: modelLabel, provider, ...(lintMsg.details ?? {}) },
						});
					}
					} finally {
						popPhase();
					}
				}

				if (event.type === "tool_execution_start") {
					pushPhase("tool_start:" + event.toolName);
					try {
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
					progressScheduler.schedule();
					} finally {
						popPhase();
					}
				}

				if (event.type === "tool_execution_update") {
					pushPhase("tool_update");
					try {
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
									progressScheduler.schedule();
								}
							}
						}
					} catch (e) { debugLog("[subagent] update failed:", e); }
					} finally {
						popPhase();
					}
				}

				if (event.type === "tool_execution_end") {
					pushPhase("tool_end:" + event.toolName);
					try {
					if (event.toolName === "planSteps" || event.toolName === "advanceStep" || event.toolName === "reportFinding") {
						const text = feed.render(specialist.name);
						config.onUpdate?.({ content: [{ type: "text", text }], details: { specialist: specialist.name, status: "running", model: modelLabel, provider } });
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
					progressScheduler.schedule();
					} finally {
						popPhase();
					}
				}

				// agent_end has no event.usage — message_end already accumulated usage;
				// here we just refresh ctxTokens from the last assistant message.
				if (event.type === "agent_end" && event.messages) {
					pushPhase("agent_end");
					try {
					const messages = event.messages as any[];
					for (let i = messages.length - 1; i >= 0; i--) {
						if (messages[i].role === "assistant" && messages[i].usage) {
							ctxTokens = messages[i].usage.totalTokens || ctxTokens;
							break;
						}
					}
					const total = accInput + accOutput + accCached;
					const cachePart = accCached > 0 ? ` \u21C4${formatTokens(accCached)}` : "";
					updatePlanStepDetail([`tokens: \u2191${formatTokens(accInput)}${cachePart} \u2193${formatTokens(accOutput)}`], orchestratorCtx);
					setViewerTokens({ input: accInput, output: accOutput, cached: accCached, ctxTokens, ctxWindow });
					progressScheduler.schedule();
					} finally {
						popPhase();
					}
				}

				if (event.type === "turn_end") {
					pushPhase("turn_end");
					try {
					// No-op: turn_end handler kept for future use
					} finally {
						popPhase();
					}
				}
			});

			// Periodic elapsed-time timer (1s) — uses flush for forced immediate emission
			let elapsedTimer: ReturnType<typeof setInterval> | null = null;
			elapsedTimer = setInterval(() => {
				progressScheduler.flush();
			}, 1000);

			// Abort handler
			const abortHandler = () => { session.abort(); };
			if (signal) {
				if (signal.aborted) abortHandler();
				signal.addEventListener("abort", abortHandler, { once: true });
			}

			let finalStatus = "completed";

			let nudged = false;

			watchdog.start();
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
						details: { specialist: specialist.name, status: "error", error: errorMsg, model: modelLabel, provider },
					});
				} else {
					const stepsIncomplete = feed.planParsed && feed.currentStep < feed.steps.length;
					if (shouldNudge(lastStopReason ?? "", stepsIncomplete, nudged)) {
						nudged = true;
						await session.prompt("You stopped before completing the task. Continue: finish all remaining steps, then report the final result.");
					}
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
					details: { specialist: specialist.name, status: isAborted ? "aborted" : "error", error: errorMsg, model: modelLabel, provider },
				});
				const prevOutput = output;
				if (isAborted) {
					const marker = `[aborted] Interrupted by user${errorMsg && !errorMsg.toLowerCase().includes("abort") ? ` (${errorMsg})` : ""}`;
					output = marker + (prevOutput ? "\n\n--- Partial output before abort: ---\n\n" + prevOutput : "");
				} else {
					const marker = `[error] ${errorMsg}`;
					output = marker + (prevOutput ? "\n\n--- Partial output before error: ---\n\n" + prevOutput : "");
				}
			} finally {
				watchdog.stop();
				unsubscribe();
				progressScheduler.dispose();
				if (elapsedTimer) {
					clearInterval(elapsedTimer);
					elapsedTimer = null;
				}
				delete process.env[SubagentRunner.SUBAGENT_ENV_KEY];
				if (signal) signal.removeEventListener("abort", abortHandler);

				// -- Flight Recorder: dump full session conversation for post-hoc debugging --
				try {
					const debugDir = '/tmp/orchestrator-debug';
					try { mkdirSync(debugDir, { recursive: true }); } catch {}
					const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
					const filename = `delegation-${timestamp}-${specialist.name}.json`;
					const toolCallTrailDump: Array<{ tool: string; label: string; input: any; output: string; isError: boolean; durationMs: number }> = [];
					const messages = session.messages as any[];
					if (messages && messages.length > 0) {
						// Collect toolCall blocks from assistant messages
						const toolCallsById = new Map<string, { id: string; name: string; arguments: any }>();
						for (const msg of messages) {
							if (msg.role === "assistant" && Array.isArray(msg.content)) {
								for (const block of msg.content) {
									if (block.type === "toolCall") {
										toolCallsById.set(block.id, { id: block.id, name: block.name, arguments: block.arguments });
									}
								}
							}
						}
						// Match each toolCall with its toolResult
						for (const msg of messages) {
							if (msg.role === "tool" && msg.toolCallId) {
								const tc = toolCallsById.get(msg.toolCallId);
								if (!tc) continue;
								const isError = msg.isError === true;
								const outputParts: string[] = [];
								if (Array.isArray(msg.content)) {
									for (const part of msg.content) {
										if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
									}
								}
								let output = outputParts.join("");
								if (output.length > 50000) output = output.slice(0, 49950) + "\n...[truncated at 50KB]";
								const label = toolCallToSubstep(tc.name, tc.arguments);
								let durationMs = 0;
								for (const step of feed.steps) {
									for (const sub of step.substeps) {
										if ((sub as any).toolCallId === msg.toolCallId && sub.endTime && sub.startTime) {
											durationMs = sub.endTime - sub.startTime;
										}
									}
								}
								toolCallTrailDump.push({
									tool: tc.name,
									label,
									input: tc.arguments,
									output,
									isError,
									durationMs,
								});
							}
						}
					}
					if (toolCallTrailDump.length === 0) {
						// Fallback: build from feed.steps with truncated values
						for (const step of feed.steps) {
							for (const sub of step.substeps) {
								toolCallTrailDump.push({
									tool: sub.label,
									label: sub.label,
									input: sub.label.slice(0, 100),
									output: (sub.outputPreview ?? "").slice(0, 100),
									isError: sub.errored ?? false,
									durationMs: (sub.endTime ?? 0) - (sub.startTime ?? 0),
								});
							}
						}
					}
					const dump = createFlightRecorderDump({
						specialist: specialist.name,
						task,
						sessionId,
						model: (model as any)?.id ?? (model as any)?.model ?? undefined,
						turns,
						elapsedMs: Date.now() - startTime,
						stopReason: lastStopReason,
						errorMessage: lastErrorMessage,
						finalStatus,
						messages: session.messages,
						scope,
						toolCallTrail: toolCallTrailDump,
						blockedCalls: subagentSessions.get(sessionId!)?.blockedCalls ?? [],
						planSteps: feed.steps.map(s => ({
							label: s.label,
							durationMs: (s.endTime ?? Date.now()) - (s.startTime ?? Date.now()),
							completed: s.completed,
						})),
						metrics: config.metrics ?? {},
						tokenSummary: { totalInput: accInput, totalOutput: accOutput, totalCached: accCached, ctxTokensFinal: ctxTokens },
						systemPrompt: specialist.systemPrompt,
						activityFeed: { ...feed.feedState },
					});
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

			// Flush any pending coalesced progress before sending final status
			progressScheduler.flush();
			// Freeze tokens so they persist in the final render
			feed.feedState = { ...feed.feedState, tokensFrozen: true };
			const finalText = feed.render(specialist.name);
			config.onUpdate?.({ content: [{ type: "text", text: finalText }], details: { specialist: specialist.name, status: finalStatus, model: modelLabel, provider, elapsed: Date.now() - startTime, tokens: accInput + accOutput + accCached, tokenInput: accInput, tokenOutput: accOutput, tokenCached: accCached } });
			setViewerTokens({ input: accInput, output: accOutput, cached: accCached, ctxTokens, ctxWindow });
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

			// Collect scope notes from blocked calls
			let scopeNotes: import('./types.ts').ScopeNotes | undefined;
			if (sessionId) {
				const state = subagentSessions.get(sessionId);
				if (state && state.blockedCalls && state.blockedCalls.length > 0) {
					const blockedTools = state.blockedCalls.map(bc => ({ ...bc }));
					const assessment = blockedTools.length <= 2
						? 'minor-deviation' as const
						: 'significant-deviation' as const;
					scopeNotes = {
						blockedTools,
						assessment,
						summary: `${blockedTools.length} tool call(s) blocked \u2014 ${blockedTools.map(b => `${b.tool}(${b.target})`).join(', ')}`,
					};
				}
			}

			return {
				output: finalOutput,
				turns,
				elapsed_ms: Date.now() - startTime,
				toolCallTrail,
				stopReason: lastStopReason,
				errorMessage: lastErrorMessage,
				model: (model as any)?.id ?? (model as any)?.model ?? undefined,
				scopeNotes,
				tokenUsage: { input: accInput, output: accOutput, cached: accCached },
				hasLintFailures,
			};
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
