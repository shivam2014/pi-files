/**
 * Subagent runner — creates isolated subagent sessions for specialist delegation.
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md
 *
 * NEW: Captures lint-guard custom messages from subagent and forwards via onUpdate.
 * NEW: Accepts optional scope param to write .pi/scope.json before subagent creation.
 */

import { getModel } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { shortenLabel } from "../token-saver.ts";
import type { Specialist, SubagentContext, Scope, Substep } from "./types.ts";
import {
	addSubstep,
	createActivityFeed,
	setToolDetail,
	clearToolDetail,
	completeLastSubstep,
	completeCurrentStep,
	markFeedError,
	renderActivityFeed,
	toolCallToSubstep,
	updateActiveSubstepOutput,
	renderSubstepLines,
} from "./activity-feed.ts";
import { compressOutput, inspectFeedState, snapshotFeedRender } from "./activity-feed.ts";
import { _spinnerIndex, resetSpinner } from "./spinner-state.ts";
import { updatePlanStepDetail, recordTimelineFrame } from "./plan-panel.ts";
import { registerPeekFeed, updatePeek, updatePeekFeed } from "./peek-overlay.ts";
import { gitReadTool, ghTool } from "./scout-tools.ts";

/** Optional orchestrator UI for dynamic status messages */
export interface OrchestratorUi {
	setWorkingMessage: (msg?: string) => void;
	setStatus: (key: string, value: any) => void;
	theme: any;
}

export const SUBAGENT_ENV_KEY = "PI_ORCHESTRATOR_SUBAGENT";

/** Module-level guards for orchestrator registration skipping. */
export let _batchLoadSubagent = 0;
/** Tracks whether planSteps has been called in the current subagent session */
let _planParsed = false;
/** Getter for planParsed state — used by index.ts tool_call handler */
export function isPlanParsed(): boolean { return _planParsed; }

const OUTPUT_CAP = 30_000;

export function isSubagentContext(): boolean {
	return process.env[SUBAGENT_ENV_KEY] === "1";
}

/**
 * Write scope file for scope-guard.ts enforcement.
 * Only written if scope is provided.
 * Derives gateMode from changeType if not explicitly set.
 */
function writeScopeFile(cwd: string, scope?: Scope | null): void {
	if (!scope) return;
	const dir = join(cwd, ".pi");
	try { mkdirSync(dir, { recursive: true }); } catch {}

	// Derive gateMode from changeType if not set
	// Set defaults for hybrid scope fields
	const scopeWithGate = {
		...scope,
		directories: scope.directories ?? [],
		maxFiles: scope.maxFiles ?? 10,
		requiresApprovalBeyondScope: scope.requiresApprovalBeyondScope ?? true,
		gateMode: scope.gateMode ?? (scope.changeType === "single-file" ? "relaxed" : "strict"),
	};

	writeFileSync(join(dir, "scope.json"), JSON.stringify(scopeWithGate, null, 2));
}

/**
 * Clear scope file after subagent completes.
 */
function clearScopeFile(cwd: string): void {
	try {
		const path = join(cwd, ".pi", "scope.json");
		if (existsSync(path)) unlinkSync(path);
	} catch {}
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
): Promise<{ output: string; turns: number; elapsed_ms?: number; toolCallTrail?: { tool: string; outputPreview?: string; completed: boolean }[] }> {
	// Write scope file for scope-guard.ts enforcement
	writeScopeFile(cwd, scope);

	const startTime = Date.now();

	try {
		const authStorage = AuthStorage.create();
		const modelRegistry = parentCtx?.modelRegistry ?? ModelRegistry.create(authStorage);

		// Resolve model: specialist.model > parent's model > registry fallback
		let model;
		if (specialist.model) {
			const slashIdx = specialist.model.indexOf("/");
			if (slashIdx > 0) {
				const provider = specialist.model.slice(0, slashIdx);
				const id = specialist.model.slice(slashIdx + 1);
				model = getModel(provider as any, id);
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

		// Load extensions for subagent, flag context so orchestrator skips re-registration
		_batchLoadSubagent++;
		process.env[SUBAGENT_ENV_KEY] = "1";
		let loader: DefaultResourceLoader | undefined;
		try {
			loader = new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				systemPromptOverride: () => {
				let prompt = specialist.systemPrompt;
				if (scope) {
					const modFiles = scope.filesToModify.length > 0 ? scope.filesToModify.map(f => `  - ${f}`).join('\n') : '  - (none)';
					const createFiles = scope.filesToCreate.length > 0 ? scope.filesToCreate.map(f => `  - ${f}`).join('\n') : '  - (none)';
					const dirs = scope.directories.length > 0 ? scope.directories.join(', ') : '(none)';
					prompt += `\n\n## Scope Restrictions\nYou may ONLY modify/create files within this scope:\n- Files to modify:\n${modFiles}\n- Files to create:\n${createFiles}\n- Allowed directories: ${dirs}\n- Max files: ${scope.maxFiles ?? 10}\n- Changes beyond scope require approval: ${scope.requiresApprovalBeyondScope ?? true}\n`;
					if (scope.changeType) {
						prompt += `- Change type: ${scope.changeType} (${scope.changeType === 'single-file' ? 'edit one file' : 'may edit multiple files'})\n`;
					}
					if (scope.maxLinesPerFile) {
						prompt += `- Max lines per file: ${scope.maxLinesPerFile}\n`;
					}
				}
				return prompt;
			},
				noContextFiles: true, // Don't load parent's AGENTS.md/context into subagent
			});
			await loader.reload();
		} finally {
			_batchLoadSubagent--;
			_planParsed = false;  // Reset for next subagent session
			if (_batchLoadSubagent <= 0) {
				delete process.env[SUBAGENT_ENV_KEY];
			}
		}

		const excludeTools = (specialist.name === "writer" || specialist.name === "researcher")
			? ["bash"]
			: undefined;

		let output = "";
		let turns = 0;
		let feed = createActivityFeed();
		let _lastFeedSnapshot: string | null = null;
		const goal = shortenLabel(task);
		feed.goal = goal;

		// Define planSteps tool — subagent calls this ONCE to register its plan
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
					feed = {
						...feed,
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
					_planParsed = true;  // Sync module-level flag
					const text = renderActivityFeed(specialist.name, feed);
					onUpdate?.({ content: [{ type: "text", text }], details: { status: "plan_set" } });
				}
				return { content: [{ type: "text", text: `Plan registered with ${params.steps.length} steps` }], details: {} };
			}
		});

		// Define advanceStep tool — subagent calls this after each step completes
		const advanceStepTool = defineTool({
			name: "advanceStep",
			label: "Advance Step",
			description: "Mark the current step as complete and advance to the next step. Call this after each step finishes.",
			parameters: Type.Object({}),
			execute: async (_toolCallId: string, _params: Record<string, never>) => {
				if (feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
					feed = completeCurrentStep(feed);
					const nextLabel = feed.currentStep < feed.steps.length
						? feed.steps[feed.currentStep].label
						: "All steps complete";
					const text = renderActivityFeed(specialist.name, feed);
					onUpdate?.({ content: [{ type: "text", text }], details: { status: "step_advanced" } });
					return { content: [{ type: "text", text: `Step complete. Next: ${nextLabel}` }], details: {} };
				}
				return { content: [{ type: "text", text: "No active step to complete" }], details: {} };
			}
		});

		// Define reportFinding tool — subagent calls this to report noteworthy findings
		const reportFindingTool = defineTool({
			name: "reportFinding",
			label: "Report Finding",
			description: "Report an important finding discovered during execution. Call this when you discover something noteworthy.",
			parameters: Type.Object({
				finding: Type.String({ description: "What you discovered" }),
			}),
			execute: async (_toolCallId: string, params: { finding: string }) => {
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
					feed = { ...feed, steps: newSteps };
					const text = renderActivityFeed(specialist.name, feed);
					onUpdate?.({ content: [{ type: "text", text }], details: { status: "report" } });
					return { content: [{ type: "text", text: `✓ Reported: ${params.finding}` }], details: {} };
				}
				return { content: [{ type: "text", text: "No active step" }], details: {} };
			},
		});

		// Merge tools with planSteps, advanceStep, and reportFinding
		const allTools = [...(specialist.tools || []), "planSteps", "advanceStep", "reportFinding"];

		const { session } = await createAgentSession({
			cwd,
			model,
			tools: allTools,
			customTools: [
				planStepsTool,
				advanceStepTool,
				reportFindingTool,
				...(specialist.name === "scout" ? [gitReadTool, ghTool] : []),
			],
			excludeTools,
			resourceLoader: loader!,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			modelRegistry,
		});

		// Register feed for peek overlay (Layer 3)
		const peekAbort = new AbortController();
		registerPeekFeed(feed, peekAbort, shortenLabel(task));
		signal?.addEventListener("abort", () => peekAbort.abort(), { once: true });
		peekAbort.signal.addEventListener("abort", () => { try { session.abort(); } catch {} }, { once: true });

		const unsubscribe = session.subscribe((event) => {
			// Standard assistant message delta
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				output += event.assistantMessageEvent.delta;
				const snapshot = JSON.stringify(inspectFeedState(feed));
				if (snapshot !== _lastFeedSnapshot) {
					_lastFeedSnapshot = snapshot;
					resetSpinner();
					updatePlanStepDetail(feed.goal || "");
					recordTimelineFrame("step_started", inspectFeedState(feed), snapshotFeedRender(feed));
				}
				updatePeekFeed(feed);
				updatePeek(event.assistantMessageEvent.delta);
				const textDelta = renderActivityFeed(specialist.name, feed);
				onUpdate?.({
					content: [{ type: "text", text: textDelta }],
					details: { status: "running", streaming: true },
				});
			}

			// Assistant message completed
			if (event.type === "message_end") {
				if (event.message?.role === "assistant") {
					turns++;
					const text = renderActivityFeed(specialist.name, feed);
					onUpdate?.({
						content: [{ type: "text", text }],
						details: { specialist: specialist.name, status: "running", turns },
					});
				}

				// Capture lint-guard tool messages: integrate into feed + forward to onUpdate
				const lintMsg = (event as any).message;
				if (lintMsg?.role === "tool" && lintMsg?.toolName === "lint") {
					const lintContent = typeof lintMsg.content === "string"
						? lintMsg.content
						: JSON.stringify(lintMsg.content ?? "");

					// Add lint result as a substep in the feed (visible in delegation step/substep view)
					feed = addSubstep(feed, lintContent.slice(0, 80));
					feed = completeLastSubstep(feed);
					updatePeekFeed(feed);

					// Forward lint content to the delegation output blob
					output += "\n" + lintContent + "\n";
					onUpdate?.({
						content: typeof lintMsg.content === "string"
							? [{ type: "text", text: lintMsg.content }]
							: (lintMsg.content ?? []),
						details: { specialist: specialist.name, status: "lint", ...(lintMsg.details ?? {}) },
					});
				}
			}

			// Tool execution started
			if (event.type === "tool_execution_start") {
				if (event.toolName === "planSteps" || event.toolName === "advanceStep" || event.toolName === "reportFinding") return;
				const substepLabel = toolCallToSubstep(event.toolName, event.args);
				// Auto-create substep if feed is empty (model skipped text output)
				feed = addSubstep(feed, substepLabel);
				feed = setToolDetail(feed, substepLabel);
				recordTimelineFrame("tool_start", inspectFeedState(feed), snapshotFeedRender(feed));
				_lastFeedSnapshot = null;
				updatePeekFeed(feed);
				updatePeek(`\u2192 ${event.toolName}\n`);
				// Pass substep history lines to plan panel immediately
				const activeStep = feed.steps[feed.currentStep];
				if (activeStep) {
					updatePlanStepDetail(renderSubstepLines(activeStep.substeps));
				} else {
					updatePlanStepDetail(substepLabel);
				}
				const text = renderActivityFeed(specialist.name, feed);
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { specialist: specialist.name, status: "running", tool: event.toolName },
				});
			}

			// Tool execution streaming update
			if (event.type === "tool_execution_update") {
				try {
					// Update the active substep with partial output preview — immutable
					if (event.partialResult && feed.steps.length > 0) {
						const activeStep = feed.steps[feed.currentStep];
						if (activeStep && activeStep.substeps.length > 0) {
							if (!activeStep.substeps[activeStep.substeps.length - 1].completed) {
								// Truncate to 80 chars for display
								const preview = event.partialResult.length > 80
									? event.partialResult.slice(0, 77) + "..."
									: event.partialResult;
								feed = updateActiveSubstepOutput(feed, preview);

								// Update plan panel from new feed state
								const newActiveStep = feed.steps[feed.currentStep];
								if (newActiveStep) {
									updatePlanStepDetail(renderSubstepLines(newActiveStep.substeps));
								}

								// Emit onUpdate so UI stays responsive during tool execution
								const text = renderActivityFeed(specialist.name, feed);
								onUpdate?.({ content: [{ type: "text", text }], details: { specialist: specialist.name, status: "running", tool: event.toolName } })
							}
						}
					}
				} catch (e) { console.error("[subagent] update failed:", e); }
			}

			// Tool execution completed
			if (event.type === "tool_execution_end") {
				if (event.toolName === "planSteps" || event.toolName === "advanceStep" || event.toolName === "reportFinding") {
					const text = renderActivityFeed(specialist.name, feed);
					onUpdate?.({ content: [{ type: "text", text }], details: { specialist: specialist.name, status: "running" } });
					return;
				}
				// Extract truncated output preview from tool result
				let outputPreview: string | undefined;
				let rawResult: any;
				try {
					rawResult = event.result ?? (event as any).output;
					if (rawResult != null) {
						const raw = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
						const stripped = compressOutput(raw);
						outputPreview = stripped.length > 80 ? stripped.slice(0, 77) + "..." : stripped || undefined;
					}
				} catch {}
				const isError = (event as any).isError === true;
				// For errors, extract actual error message from result structure
				if (isError && rawResult != null) {
					if (typeof rawResult === "string") {
						outputPreview = rawResult;
					} else if (rawResult.content && Array.isArray(rawResult.content) && rawResult.content[0]?.text) {
						outputPreview = rawResult.content[0].text;
					} else {
						outputPreview = JSON.stringify(rawResult);
					}
				}
				feed = clearToolDetail(feed);
				feed = completeLastSubstep(feed, outputPreview, isError);
				// After edit/write tool completion, add lint indicator substep
				if (!isError && (event.toolName === "edit" || event.toolName === "write")) {
					feed = addSubstep(feed, `lint: checking ${(event as any).arguments?.filePath ?? (event as any).arguments?.path ?? "files"}...`);
				}
				recordTimelineFrame("tool_end", inspectFeedState(feed), snapshotFeedRender(feed));
				_lastFeedSnapshot = null;
				updatePeekFeed(feed);
				updatePeek(`\u2713 ${event.toolName}\n`);
				// Update plan panel with substep history lines
				const activeStep = feed.steps[feed.currentStep];
				if (activeStep && activeStep.substeps.length > 0) {
					updatePlanStepDetail(renderSubstepLines(activeStep.substeps));
				}
				const text = renderActivityFeed(specialist.name, feed);
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { specialist: specialist.name, status: "running" },
				});
			}

			// Turn end — capture tool results for tracking
			if (event.type === "turn_end") {
				// Turn-end tracking: error detection only
				// Substep creation is handled by tool_execution_start with proper labels via toolCallToSubstep()
				const results = (event as any).toolResults;
				
			}
		});

		// Periodic re-render timer — animates spinner between events
		let renderTimer: ReturnType<typeof setInterval> | null = null;
		let _lastRenderText: string | null = null;
		let _lastSpinnerIndex = -1;
		const startRenderTimer = () => {
			renderTimer = setInterval(() => {
				if (feed.steps.length > 0 || output.length > 0) {
					const text = renderActivityFeed(specialist.name, feed);
					// Always emit if spinner frame changed or content changed
					if (_spinnerIndex !== _lastSpinnerIndex || text !== _lastRenderText) {
						_lastRenderText = text;
						_lastSpinnerIndex = _spinnerIndex;
						onUpdate?.({
							content: [{ type: "text", text }],
							details: { specialist: specialist.name, status: "running" },
						});
					}
				}
			}, 80);
		};
		startRenderTimer();

		// Abort handler — cancel subagent when parent aborts
		const abortHandler = () => { session.abort(); };
		if (signal) {
			if (signal.aborted) abortHandler();
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		let finalStatus = "completed";

		try {
			await session.prompt(task);
			finalStatus = "completed";
		} catch (error) {
			const isAborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
			const errorMsg = error instanceof Error ? error.message : String(error);
			finalStatus = isAborted ? "aborted" : "error";
			// Surface error in activity feed before cleanup
			feed = markFeedError(feed, errorMsg);
			updatePeekFeed(feed);
			const errorText = renderActivityFeed(specialist.name, feed) ?? errorMsg;
			onUpdate?.({content: [{ type: "text", text: errorText }],
				details: { specialist: specialist.name, status: isAborted ? "aborted" : "error", error: errorMsg },
			});
			output = isAborted
				? `[aborted] Interrupted by user${errorMsg && !errorMsg.toLowerCase().includes("abort") ? ` (${errorMsg})` : ""}`
				: `[error] ${errorMsg}`;
		} finally {
			if (_batchLoadSubagent <= 0) {
				delete process.env[SUBAGENT_ENV_KEY];
			}
			unsubscribe();
			if (renderTimer) {
				clearInterval(renderTimer);
				renderTimer = null;
			}
			_lastRenderText = null;
			if (signal) signal.removeEventListener("abort", abortHandler);
			session.dispose();
		}

		// Finalize feed state — complete any remaining steps
		if (feed.steps.length > 0 && feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
			feed = completeCurrentStep(feed);
		}
		feed.currentStep = feed.steps.length;

		// Emit final render so TUI shows clean final state
		const finalText = renderActivityFeed(specialist.name, feed);
		onUpdate?.({ content: [{ type: "text", text: finalText }], details: { specialist: specialist.name, status: finalStatus } });
		recordTimelineFrame("step_finalized", inspectFeedState(feed), snapshotFeedRender(feed));

		// Compress + cap output before returning to parent
		let finalOutput = compressOutput(output || "(no output)");
		if (finalOutput.length > OUTPUT_CAP) {
			finalOutput = finalOutput.slice(0, OUTPUT_CAP) + "\n\n[output truncated]";
		}

		// Build tool call trail from feed state
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

		return { output: finalOutput, turns, elapsed_ms: Date.now() - startTime, toolCallTrail };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : "";
		return {
			output: `[error] Subagent init failed: ${msg}${stack ? "\n" + stack.split("\n").slice(0, 5).join("\n") : ""}`,
			turns: 0,
		};
	} finally {
		clearScopeFile(cwd);
	}
}
