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
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortenLabel } from "../token-saver.ts";
import type { Specialist, OrchestratorActivity, SubagentContext, Scope } from "./types.ts";
import {
	createActivityFeed,
	parseTextForFeed,
	addSubstep,
	completeLastSubstep,
	completeCurrentStep,
	markFeedError,
	renderActivityFeed,
	renderCombinedProgress,
	toolCallToSubstep,
	renderSubstepLines,
	_spinnerIndex,
} from "./activity-feed.ts";
import { compressOutput } from "./activity-feed.ts";
import { updatePlanStepDetail } from "./plan-panel.ts";
import { registerPeekFeed, updatePeek } from "./peek-overlay.ts";

/** Optional orchestrator UI for dynamic status messages */
export interface OrchestratorUi {
	setWorkingMessage: (msg?: string) => void;
	setStatus: (key: string, value: any) => void;
	theme: any;
}

export const SUBAGENT_ENV_KEY = "PI_ORCHESTRATOR_SUBAGENT";

/** Module-level guards for orchestrator registration skipping. */
export let _batchLoadSubagent = 0;

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
	const scopeWithGate = {
		...scope,
		gateMode: scope.gateMode ?? (scope.changeType === "single-file" ? "relaxed" : "strict"),
	};

	writeFileSync(join(dir, "scope.json"), JSON.stringify(scopeWithGate, null, 2));
}

/**
 * Clear scope file after subagent completes.
 */
function clearScopeFile(cwd: string): void {
	try { writeFileSync(join(cwd, ".pi", "scope.json"), ""); } catch {}
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
 * @param orchestratorActivity - Optional orchestrator activity for combined progress view
 * @param scope - Optional scope manifest for scope-guard enforcement
 */
export async function runSubagent(
	specialist: Specialist,
	task: string,
	cwd: string,
	parentCtx?: SubagentContext,
	signal?: AbortSignal,
	onUpdate?: (update: any) => void,
	orchestratorActivity?: OrchestratorActivity,
	scope?: Scope | null,
	orchestratorUi?: OrchestratorUi,
): Promise<{ output: string; turns: number; elapsed_ms?: number; toolCallTrail?: { tool: string; outputPreview?: string; completed: boolean }[] }> {
	// Write scope file for scope-guard.ts enforcement
	writeScopeFile(cwd, scope);

	const startTime = Date.now();

	try {
		const authStorage = AuthStorage.create();
		const modelRegistry = parentCtx?.modelRegistry ?? ModelRegistry.inMemory(authStorage);

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
		let loader: DefaultResourceLoader;
		try {
			loader = new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				systemPromptOverride: () => specialist.systemPrompt,
				noContextFiles: true,
			});
			await loader.reload();
		} finally {
			_batchLoadSubagent--;
			// Env var stays active — cleaned up in finally after session.prompt()
		}

		const excludeTools = (specialist.name === "writer" || specialist.name === "researcher")
			? ["bash"]
			: undefined;

		const { session } = await createAgentSession({
			cwd,
			model,
			tools: specialist.tools,
			excludeTools,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			modelRegistry,
		});

		let output = "";
		let turns = 0;
		const feed = createActivityFeed();
		feed.goal = shortenLabel(task);

		// Register feed for peek overlay (Layer 3)
		const peekAbort = new AbortController();
		registerPeekFeed(feed, peekAbort, shortenLabel(task));
		signal?.addEventListener("abort", () => peekAbort.abort(), { once: true });
		peekAbort.signal.addEventListener("abort", () => { try { session.abort(); } catch {} }, { once: true });

		const unsubscribe = session.subscribe((event) => {
			// Standard assistant message delta
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				output += event.assistantMessageEvent.delta;
				parseTextForFeed(feed, event.assistantMessageEvent.delta);
				updatePeek(event.assistantMessageEvent.delta);
			}

			// Assistant message completed
			if (event.type === "message_end") {
				if (event.message?.role === "assistant") {
					turns++;
					if (feed.steps.length > 0 && feed.currentStep < feed.steps.length) {
						completeCurrentStep(feed);
					}
					const text = orchestratorActivity
						? renderCombinedProgress(orchestratorActivity, specialist.name, feed, "")
						: renderActivityFeed(specialist.name, feed);
					onUpdate?.({
						content: [{ type: "text", text }],
						details: { specialist: specialist.name, status: "running", turns },
					});
				}

				// NEW: Capture lint-guard custom messages from subagent
				if (event.message?.role === "custom" && event.message?.customType === "lint-guard") {
					const lintContent = typeof event.message.content === "string"
						? event.message.content
						: JSON.stringify(event.message.content ?? "");
					output += "\n--- " + lintContent + "\n";
					onUpdate?.({
						content: typeof event.message.content === "string"
							? [{ type: "text", text: event.message.content }]
							: (event.message.content ?? []),
						details: { specialist: specialist.name, status: "lint", ...(event.message.details ?? {}) },
					});
				}
			}

			// Tool execution started
			if (event.type === "tool_execution_start") {
				const substepLabel = toolCallToSubstep(event.toolName, event.args);
				addSubstep(feed, substepLabel);
				updatePeek(`\u2192 ${event.toolName}\n`);
				// Pass substep history lines to plan panel immediately
				const activeStep = feed.steps[feed.currentStep];
				if (activeStep) {
					updatePlanStepDetail(renderSubstepLines(activeStep.substeps));
				} else {
					updatePlanStepDetail(substepLabel);
				}
				const text = orchestratorActivity
					? renderCombinedProgress(orchestratorActivity, specialist.name, feed, "")
					: renderActivityFeed(specialist.name, feed);
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { specialist: specialist.name, status: "running", tool: event.toolName },
				});
			}

			// Tool execution streaming update
			if (event.type === "tool_execution_update") {
				try {
					// Update the last substep with partial output preview
					if (event.partialResult && feed.steps.length > 0) {
						const activeStep = feed.steps[feed.currentStep];
						if (activeStep && activeStep.substeps.length > 0) {
							const lastSub = activeStep.substeps[activeStep.substeps.length - 1];
							if (!lastSub.completed) {
								// Truncate to 80 chars for display
								const preview = event.partialResult.length > 80
									? event.partialResult.slice(0, 77) + "..."
									: event.partialResult;
								lastSub.outputPreview = preview;

								// Update plan panel
								updatePlanStepDetail(renderSubstepLines(activeStep.substeps));

								// Emit onUpdate so UI stays responsive during tool execution
								const text = orchestratorActivity
									? renderCombinedProgress(orchestratorActivity, specialist.name, feed, "")
									: renderActivityFeed(specialist.name, feed);
								onUpdate?.({ content: [{ type: "text", text }], details: { specialist: specialist.name, status: "running", tool: event.toolName } })
							}
						}
					}
				} catch {}
			}

			// Tool execution completed
			if (event.type === "tool_execution_end") {
				// Extract truncated output preview from tool result
				let outputPreview: string | undefined;
				try {
					const rawResult = (event as any).result ?? (event as any).output;
					if (rawResult != null) {
						const raw = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
						const stripped = compressOutput(raw);
						outputPreview = stripped.length > 80 ? stripped.slice(0, 77) + "..." : stripped || undefined;
					}
				} catch {}
				completeLastSubstep(feed, outputPreview);
				updatePeek(`\u2713 ${event.toolName}\n`);
				// Update plan panel with substep history lines
				const activeStep = feed.steps[feed.currentStep];
				if (activeStep && activeStep.substeps.length > 0) {
					updatePlanStepDetail(renderSubstepLines(activeStep.substeps));
				}
				const text = orchestratorActivity
					? renderCombinedProgress(orchestratorActivity, specialist.name, feed, "")
					: renderActivityFeed(specialist.name, feed);
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { specialist: specialist.name, status: "running" },
				});
			}
		});

		// Periodic re-render timer — animates spinner between events
		let renderTimer: ReturnType<typeof setInterval> | null = null;
		let _lastRenderText: string | null = null;
		let _lastSpinnerIndex = -1;
		const startRenderTimer = () => {
			renderTimer = setInterval(() => {
				if (feed.steps.length > 0 || output.length > 0) {
					const text = orchestratorActivity
						? renderCombinedProgress(orchestratorActivity, specialist.name, feed, "")
						: renderActivityFeed(specialist.name, feed);
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

		try {
			await session.prompt(task);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			// Surface error in activity feed before cleanup
			markFeedError(feed, errorMsg);
			const errorText = renderActivityFeed(specialist.name, feed) ?? errorMsg;
			onUpdate?.({
				content: [{ type: "text", text: errorText }],
				details: { specialist: specialist.name, status: "error", error: errorMsg },
			});
			output = `[error] ${errorMsg}`;
		} finally {
			delete process.env[SUBAGENT_ENV_KEY];
			unsubscribe();
			if (renderTimer) {
				clearInterval(renderTimer);
				renderTimer = null;
			}
			_lastRenderText = null;
			if (signal) signal.removeEventListener("abort", abortHandler);
			session.dispose();
		}

		// After successful completion, force-complete remaining steps
		for (const step of feed.steps) {
			if (!step.completed) {
				step.completed = true;
				for (const sub of step.substeps) sub.completed = true;
			}
		}
		// Reset currentStep to show final state
		feed.currentStep = Math.max(feed.currentStep, feed.steps.length);

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
