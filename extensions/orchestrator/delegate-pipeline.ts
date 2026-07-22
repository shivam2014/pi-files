/**
 * DelegatePipeline — orchestrates specialist subagent delegation end-to-end.
 * Inlined from handle-diagnostics.ts and delegate-result-processor.ts.
 */
import type { Specialist, DelegationMetrics, SubagentContext, SubagentDiagnostic, DelegateControllerContext, BatchDelegationEntry } from "./types.ts";
import { SPECIALISTS, SPECIALIST_VERBS, getSpecialistSkills } from "./specialists.ts";
import { createAskOrchestratorResolver, resolve } from "./ask-resolver.ts";
import { runSubagent, type OrchestratorUi } from "./subagent-runner.ts";
import { hasActivePlan, setupPlanPanel, startDelegationStep, finalizePlanStep, errorPlanStep, incrementDelegationCount, decrementDelegationCount, clearPlanIfComplete, updatePlanStepDetail, recordTimelineFrame } from "./plan-panel.ts";
import { debugLog } from "./debug.ts";
import { hidePeek, clearViewerState } from "./peek-overlay.ts";
import { Scope, ScopeManager, createDelegationScope, clearDelegationScope } from "./scope-manager.ts";
import { SPINNER_FRAMES, currentFrame } from "./spinner-state.ts";
import { formatMetricsLine } from "./types.ts";
import { captureDiagnostic, isDiagnosticsEnabled, persistDiagnostic, cleanupOldDiagnostics } from "./subagent-diagnostics.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import os from "os";
import { statusIcon, styledSymbol, getTheme } from "./orchestrator-theme.ts";
import { getSessionMode, loadOrchestratorConfig } from "./orchestrator-config";

/** Result type returned by executeDelegate */
export interface ExecuteDelegateResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

/**
 * Full delegation pipeline — scope resolution, subagent execution, diagnostics,
 * result formatting, plan-panel lifecycle.
 */
export class DelegatePipeline {
	constructor(private deps: { scopeManager: ScopeManager }) {}

	/**
	 * Execute a delegation to a specialist subagent.
	 *
	 * @param params - Delegation parameters (specialist, task, optional scope, optional signal)
	 * @param ctx - Agent context (cwd, modelRegistry, model, ui, etc.)
	 * @param onUpdate - Callback for progress updates during execution
	 * @returns Result with content and details
	 */
	async run(
		params: { specialist: string; task: string; skills?: string[]; scope?: Scope; signal?: AbortSignal; parallel?: boolean },
		ctx: DelegateControllerContext,
		onUpdate: (update: any) => void,
	): Promise<ExecuteDelegateResult> {
		// Ensure config is loaded and available on ctx
		if (!ctx.config) {
			ctx.config = loadOrchestratorConfig();
		}

		// ── Delegation mode guard ──
		const mode = getSessionMode(ctx);
		if (mode === "sequential" && params.parallel) {
			return {
				content: [{ type: "text", text: "Parallel delegation blocked in sequential mode. Use /delegate-mode parallel to enable." }],
				details: { error: "parallel_requested_but_mode_sequential" },
			};
		}

		// ── Validation ──
		if (!params.specialist || !params.task) {
			throw new Error("Both 'specialist' and 'task' are required. Example: delegate({ specialist: 'coder', task: 'fix auth middleware' })");
		}

		const key = params.specialist?.toLowerCase().trim();
		const specialist: Specialist | undefined = key && Object.hasOwn(SPECIALISTS, key) ? SPECIALISTS[key] : undefined;
		if (!specialist) {
			const available = Object.keys(SPECIALISTS).join(", ");
			throw new Error(`Unknown specialist: "${params.specialist}". Available: ${available}. Use one of the listed specialist names.`);
		}

		// Read-only specialists (no edit/write tools) don't need strict scope validation
		const isReadOnly = !specialist.tools.includes('edit') && !specialist.tools.includes('write');

		// Normalize specialist name for case-insensitive comparison downstream
		params = { ...params, specialist: specialist.name };

		// Expand tilde in scope paths and validate
		const expandTilde = (p: string): string => {
			if (p.startsWith("~")) {
				const expanded = p.replace(/^~/, os.homedir());
				debugLog('[scope] expanded tilde path', { original: p, expanded });
				return expanded;
			}
			return p;
		};

		if (params.scope?.filesToModify) {
			params = {
				...params,
				scope: {
					...params.scope,
					filesToModify: params.scope.filesToModify.map(p => {
						if (p.includes('..')) {
							throw new Error(`Invalid scope path: "${p}". Scope paths must not contain "..".`);
						}
						return expandTilde(p);
					}),
				},
			};
		}
		if (params.scope?.filesToCreate) {
			params = {
				...params,
				scope: {
					...params.scope,
					filesToCreate: params.scope.filesToCreate.map(p => {
						if (p.includes('..')) {
							throw new Error(`Invalid scope path: "${p}". Scope paths must not contain "..".`);
						}
						return expandTilde(p);
					}),
				},
			};
		}

		// Resolve skills: override replaces defaults (issue #42)
		const resolvedSuggestedSkills = getSpecialistSkills(specialist.name, params.skills);

		const { signal } = params;

		// ── Timeout signal: combine user signal with config timeout ──
		const timeoutMs = ctx.config?.delegation?.parallel?.timeoutMs;
		const effectiveSignal = timeoutMs
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[])
			: signal;

		// ── Resolve scope (pure) ──
		let scopeToUse: Scope | null = ScopeManager.resolveScope(params, specialist, ctx.cwd);

		// Coder without scope → error
		if (params.specialist === "coder" && !scopeToUse) {
			throw new Error(
				`⛔ Scope required for coder. Pass a scope parameter when calling coder.\n\n` +
				`Example: delegate({ specialist: 'coder', task: 'fix auth middleware', scope: { filesToModify: ['src/auth.ts'], filesToCreate: [], directories: ['src/'], maxFiles: 10 } })\n\n` +
				`The scope tells the coder which files it may touch. Get this from scout output or declare it yourself.`
			);
		}

		// ── Apply scope (side-effectful: gate check + write) ──
		let delegationId: string | null = null;
		if (scopeToUse !== null) {
			const gateResult = resolve(params.task, scopeToUse, specialist.name);
			if (gateResult === "ask" && !isReadOnly) {
				throw new Error(
					`⚠️ Scope is vague for ${specialist.name}. Clarify scope before delegating.\n\n` +
					`Task: ${params.task}\n\n` +
					`Provide a clearer task description or explicit scope (filesToModify, filesToCreate), then retry.`
				);
			}
			// Parallel mode: create per-delegation scope for isolation
			if (mode === "parallel") {
				delegationId = createDelegationScope(scopeToUse);
			}
			// Skip shared file write in parallel mode — scope already isolated in per-delegation Map
			if (!delegationId) {
				this.deps.scopeManager.writeScope(scopeToUse);
			}
		}

		// ── Plan panel check ──
		const specName = specialist.name.charAt(0).toUpperCase() + specialist.name.slice(1);
		const stepLabel = `${specName}: ${params.task}`;

		// Auto-create minimal plan if none exists
		if (!hasActivePlan(ctx)) {
			const autoGoal = `delegate to ${specialist.name}: ${params.task}`;
			const autoSteps = [stepLabel];
			setupPlanPanel(autoGoal, autoSteps, ctx);
			debugLog('[delegate-pipeline] auto-created plan:', autoGoal);
		}

		startDelegationStep(stepLabel, ctx);

		onUpdate?.({
			content: [{ type: "text", text: `${currentFrame()} ${specialist.name}...` }],
			details: { status: "running", specialist: specialist.name },
		});

		// Dynamic status: delegating
		const orchestratorUi: OrchestratorUi | undefined = ctx?.ui ? ctx.ui : undefined;
		const verb = SPECIALIST_VERBS[specialist.name] || 'Working';
		try {
			if (orchestratorUi) {
				orchestratorUi.setWorkingMessage(`Sending to ${specialist.name}...`);
			}
		} catch {}

		incrementDelegationCount(ctx);

		// ── Metrics tracking ──
		const metrics: DelegationMetrics = {
			readCalls: 0,
			grepCalls: 0,
			findCalls: 0,
			editCalls: 0,
			writeCalls: 0,
			bashCalls: 0,
			lsCalls: 0,
		};
		const wrappedOnUpdate = (update: any) => {
			if (update.details?.tool) {
				switch (update.details.tool) {
					case "read": metrics.readCalls++; break;
					case "grep": metrics.grepCalls++; break;
					case "find": metrics.findCalls++; break;
					case "edit": metrics.editCalls++; break;
					case "write": metrics.writeCalls++; break;
					case "bash": metrics.bashCalls++; break;
					case "ls": metrics.lsCalls++; break;
				}
			}
			onUpdate?.(update);
		};

		const startTime = Date.now();

		// Dynamic status: subagent session starting
		try {
			if (orchestratorUi) {
				orchestratorUi.setWorkingMessage(`${verb}...`);
			}
		} catch {}

		// ── Build subagent context + run ──
		const pendingQuestions: string[] = [];
		const parentCtx: SubagentContext = {
			modelRegistry: ctx.modelRegistry,
			model: ctx.model,
			onAskOrchestrator: createAskOrchestratorResolver(ctx, pendingQuestions),
		};

		const result = await runSubagent(
			specialist, params.task, ctx.cwd,
			parentCtx,
			effectiveSignal, wrappedOnUpdate, scopeToUse, orchestratorUi, resolvedSuggestedSkills,
			ctx, // orchestratorCtx: thread session context to plan-panel calls
		);
		const elapsedMs = Date.now() - startTime;

		// Surface any questions the subagent couldn't resolve
		if (pendingQuestions.length > 0 && result?.output) {
			const questionsText = pendingQuestions.map((q, i) =>
				`  ${i + 1}. ${q}`
			).join('\n');
			result.output += `\n\n## Pending Questions\nThe subagent had questions that needed orchestrator input:\n${questionsText}\n`;
		}

		if (result?.scopeNotes) {
			metrics.scopeNotes = result.scopeNotes;
		}

		const rawSubagentOutput = result?.output;

		// Dynamic status: subagent completed
		try {
			if (orchestratorUi) {
				orchestratorUi.setWorkingMessage('Sending to orchestrator...');
			}
		} catch {}

		// ── Check for errors/abort ──
		const isAborted = (effectiveSignal?.aborted || false) || (result?.output?.startsWith("[aborted]") ?? false);
		let isError = !result || !result.output || result.output.startsWith("[error]") || result.output.startsWith("[aborted]");
		if (!isError && result?.stopReason === "error") {
			isError = true;
		}
		let hasError = isAborted || isError;

		// ── No-work detection for coder/writer ──
		const isCodeSpecialist = specialist.name === 'coder' || specialist.name === 'writer';
		const hasMutatingCalls = metrics.editCalls > 0 || metrics.writeCalls > 0 || metrics.bashCalls > 0;
		const hasDeliverable = rawSubagentOutput && (
			rawSubagentOutput.includes('## Completed') ||
			rawSubagentOutput.includes('## Findings') ||
			rawSubagentOutput.includes('## Files Changed')
		);
		const isNoWork = isCodeSpecialist && !hasMutatingCalls && !hasDeliverable && !hasError;

		if (isNoWork) {
			hasError = true;
			isError = true;
			result.output = `⚠ no-work completion — ${specialist.name} returned ok with zero edits/writes/bash calls and no deliverable. Plan step NOT advanced.`;
		}

		// ── Handle diagnostics (capture + persist, no UI) ──
		const diagnostic = this.handleDiagnostics(result, specialist.name, params.task, ctx, metrics, startTime);

		// Diagnostic UI + display — stays in controller (orchestrator concern)
		if (diagnostic) {
			// Notify user via SDK
			try {
				ctx.ui?.notify?.(
					`⚠ Diagnostic: ${diagnostic.specialist} failed — ${diagnostic.errorMessage || `0 tool calls in ${diagnostic.turns} turn(s)`}`,
					"warning"
				);
			} catch (e) {
				debugLog('[diagnostic] ui.notify failed', e);
			}

			// Text-mode visible marker in delegation output
			const warningMsg = diagnostic.errorMessage
				? `${diagnostic.specialist} failed: ${diagnostic.errorMessage.slice(0, 150)}`
				: `${diagnostic.specialist} returned 0 tool calls in ${diagnostic.turns} turn(s). Incident logged to disk.`;
			const warningLine = `\n\n⚠️ [Diagnostic] ${warningMsg}\n`;
			result.output = result.output ? warningLine + result.output : warningLine;

			// Inline display — add substep to current plan step
			try {
				const label = `⚠ Diagnostic: ${diagnostic.specialist} ${diagnostic.turns}t ${diagnostic.toolCalls}tc`;
				updatePlanStepDetail([label], ctx);
				recordTimelineFrame('subagent_diagnostic_captured', {
					diagnosticId: `${diagnostic.timestamp}-${diagnostic.specialist}-${diagnostic.task.length.toString()}`,
				}, undefined, ctx);
			} catch (e) {
				debugLog('[diagnostic] display failed', e);
			}
		}

		// ── Findings salvage: if output is empty/short, check disk ──
		let salvagedFindings = '';
		if (!rawSubagentOutput || rawSubagentOutput.trim().length < 50) {
			try {
				const fs = await import('node:fs');
				const path = await import('node:path');
				const osMod = await import('node:os');
				const findingsPath = path.join(osMod.tmpdir(), 'orchestrator-debug', `findings-${ctx.sessionId}.md`);
				if (fs.existsSync(findingsPath)) {
					salvagedFindings = fs.readFileSync(findingsPath, 'utf-8');
				}
			} catch {}
		}

		// Apply salvaged findings to result.output before formatting
		if (salvagedFindings) {
			if (!result?.output || result.output.trim().length < 50) {
				// Output empty/short — replace entirely with salvaged findings
				result.output = `⚠ PARTIAL — salvaged from disk\n\n${salvagedFindings}`;
			} else if (salvagedFindings.length > (result.output.length - (result.output.length - rawSubagentOutput?.length || 0))) {
				// Output exists but salvaged is longer — append
				result.output += `\n\n---\n⚠ SALVAGED FINDINGS (additional context from disk)\n\n${salvagedFindings}`;
			}
		}

		// ── Format result output ──
		try {
			if (!hasError && result?.output) {
				// Dynamic status: processing result
				try {
					if (orchestratorUi) {
						orchestratorUi.setWorkingMessage('Processing...');
					}
				} catch {}

				if (result.output) {
					debugLog("delegate-tool: subagent completed", { specialist: params.specialist, outputLength: result.output.length });
				}

				result.output = this.processDelegateResult(
					result.output, metrics, elapsedMs,
					result.toolCallTrail || [], result.turns || 0,
					false, false,
				);
			} else if (result?.output) {
				// Error/abort path
				result.output = this.processDelegateResult(
					result.output, metrics, elapsedMs,
					result.toolCallTrail || [], result.turns ?? 0,
					isAborted, isError,
					result?.errorMessage,
					result?.stopReason,
				);
			}

			// Mark plan step
			if (hasError) {
				errorPlanStep(ctx, isAborted, result?.errorMessage);
			} else {
				finalizePlanStep(ctx);
			}
		} finally {
			decrementDelegationCount(ctx);
			clearPlanIfComplete(ctx);
			hidePeek();
			clearViewerState();
			// Clear scope after delegation completes
			this.deps.scopeManager.clearScope();
			// Clear per-delegation scope if parallel mode
			if (delegationId) {
				clearDelegationScope(delegationId);
			}
			// Dynamic status: clear on completion
			try {
				if (orchestratorUi) {
					orchestratorUi.setWorkingMessage();
				}
			} catch {}
		}

		const status = isAborted ? "aborted" : isError ? "error" : "done";
		let finalOutput = result?.output || "[error] Subagent returned no output";

		// If error but processDelegateResult was never called (null/empty result), prepend error banner
		if (hasError && !result?.output) {
			const banner = isAborted
				? `\n⚠ DELEGATION ABORTED — no output from subagent.\n`
				: `\n⚠ DELEGATION FAILED — status:${result?.stopReason || 'unknown'} — ${result?.errorMessage || 'no error message'}\nNo output produced. Retry or escalate.\n`;
			finalOutput = banner + finalOutput;
		}

		return {
			content: [{ type: "text", text: finalOutput }],
			details: {
			specialist: specialist.name,
			task: params.task,
			status,
			turns: result?.turns || 0,
			outputLength: finalOutput.length,
			elapsedMs,
			stopReason: result?.stopReason,
			errorMessage: result?.errorMessage,
			partialResults: hasError && !!rawSubagentOutput && !rawSubagentOutput.startsWith("[error]") && !rawSubagentOutput.startsWith("[aborted]"),
			// Model info for UI display badge
			model: (() => {
				const m = (ctx as any)?.model;
				if (!m) return undefined;
				const id = typeof m === 'string' ? m : (m?.id ?? m?.model ?? '');
				return id.includes('/') ? id.split('/')[1] || id : id;
			})(),
			provider: (() => {
				const m = (ctx as any)?.model;
				if (!m) return undefined;
				const id = typeof m === 'string' ? m : (m?.id ?? m?.model ?? '');
				return id.includes('/') ? id.split('/')[0] : undefined;
			})(),
			tokenUsage: result?.tokenUsage ? { input: result.tokenUsage.input, output: result.tokenUsage.output, cached: result.tokenUsage.cached } : undefined,
			},
		};
	}

	/**
	 * Execute multiple delegations concurrently via batch parameter.
	 * Each entry runs as an independent delegation through this.run(),
	 * which already handles scope, timeout, diagnostics, and plan panel.
	 */
	async runBatch(
		entries: BatchDelegationEntry[],
		ctx: DelegateControllerContext,
		onUpdate: (update: any) => void,
		signal?: AbortSignal,
	): Promise<ExecuteDelegateResult> {
		const maxConcurrent = ctx.config?.delegation?.parallel?.maxConcurrent ?? 4;
		const batchStart = Date.now();

		onUpdate?.({
			content: [{ type: "text", text: `Starting batch delegation: ${entries.length} entries (max ${maxConcurrent} concurrent)` }],
			details: { status: "batch_start", count: entries.length, maxConcurrent },
		});

		// Process in chunks of maxConcurrent
		const allResults: Array<{
			specialist: string;
			success: boolean;
			output: string;
			error?: string;
			elapsed_ms?: number;
		}> = [];

		for (let i = 0; i < entries.length; i += maxConcurrent) {
			const chunk = entries.slice(i, i + maxConcurrent);
			const chunkResults = await Promise.allSettled(
				chunk.map(async (entry) => {
					const entryStart = Date.now();
					try {
						const result = await this.run(
							{
								specialist: entry.specialist,
								task: entry.task,
								skills: entry.skills,
								scope: entry.scope,
								signal,
								parallel: true,
							},
							ctx,
							onUpdate,
						);
						const output = result.content?.[0]?.type === "text" ? result.content[0].text : "";
						return {
							specialist: entry.specialist,
							success: true,
							output,
							elapsed_ms: Date.now() - entryStart,
						};
					} catch (e) {
						return {
							specialist: entry.specialist,
							success: false,
							output: "",
							error: String(e),
							elapsed_ms: Date.now() - entryStart,
						};
					}
			})
			);

			for (const r of chunkResults) {
				if (r.status === "fulfilled") {
					allResults.push(r.value);
				} else {
					// Promise rejected — shouldn't happen since run() errors are caught, but defensive
					allResults.push({
						specialist: "unknown",
						success: false,
						output: "",
						error: r.status === "rejected" ? String(r.reason) : "Unknown error",
					});
				}
			}
		}

		// Aggregate into single output
		const output = allResults.map((r, i) => {
			const header = `## Batch Delegation ${i + 1}: ${r.specialist}`;
			if (r.success) {
				return `${header}\n${r.output}`;
			} else {
				return `${header}\n❌ Error: ${r.error}`;
			}
		}).join("\n\n---\n\n");

		const totalElapsed = Date.now() - batchStart;

		onUpdate?.({
			content: [{ type: "text", text: `Batch delegation complete: ${allResults.filter(r => r.success).length}/${allResults.length} succeeded in ${(totalElapsed / 1000).toFixed(1)}s` }],
			details: { status: "batch_complete", total: allResults.length, succeeded: allResults.filter(r => r.success).length },
		});

		return {
			content: [{ type: "text", text: output }],
			details: {
				status: "batch_complete",
				total: allResults.length,
				succeeded: allResults.filter(r => r.success).length,
				failed: allResults.filter(r => !r.success).length,
				totalElapsed_ms: totalElapsed,
				maxConcurrent,
			},
		};
	}

	/**
	 * Capture and persist diagnostic if diagnostics are enabled and subagent failed.
	 *
	 * Returns the diagnostic (or null) — caller decides what to do with UI/display.
	 * Does NOT call ctx.ui.notify, updatePlanStepDetail, or recordTimelineFrame.
	 */
	private handleDiagnostics(
		result: any,
		specialistName: string,
		task: string,
		ctx: DelegateControllerContext,
		metrics: DelegationMetrics,
		startTime: number,
	): SubagentDiagnostic | null {
		if (!isDiagnosticsEnabled()) return null;

		const diagnostic = captureDiagnostic({
			output: result?.output || '',
			turns: result?.turns || 0,
			toolCallTrail: result?.toolCallTrail || [],
			blockedCalls: result?.scopeNotes?.blockedTools,
			elapsedMs: Date.now() - startTime,
			specialist: specialistName,
			task,
			sessionId: ctx.sessionId || 'unknown',
			metrics,
			agentDir: getAgentDir(),
			model: result?.model,
			stopReason: result?.stopReason,
			errorMessage: result?.errorMessage,
		});

		if (!diagnostic) return null;

		debugLog('[diagnostic]', diagnostic.specialist, diagnostic.turns, diagnostic.toolCalls);

		// Persist to disk
		try {
			const filePath = persistDiagnostic(getAgentDir(), diagnostic);
			debugLog('[diagnostic] persisted to', filePath);
		} catch (e) {
			debugLog('[diagnostic] persist failed', e);
		}

		// Cleanup old diagnostics (non-blocking best-effort)
		try {
			const cleaned = cleanupOldDiagnostics(getAgentDir(), 30);
			if (cleaned > 0) debugLog('[diagnostic] cleaned', cleaned, 'old directories');
		} catch (e) {
			debugLog('[diagnostic] cleanup failed', e);
		}

		return diagnostic;
	}

	/**
	 * Process a delegate result into a formatted output string.
	 * Pure function — no side effects.
	 */
	private processDelegateResult(
		output: string,
		metrics: DelegationMetrics,
		elapsedMs: number,
		toolCallTrail: any[],
		turns: number,
		isAborted: boolean,
		isError: boolean,
		errorMessage?: string,
		stopReason?: string,
	): string {
		if (isAborted || isError) {
			return DelegatePipeline.formatErrorAbort(output, toolCallTrail, turns, isAborted, errorMessage, stopReason);
		}
		// Output hygiene: strip raw JSON tool-result blocks when report exists
		const cleaned = DelegatePipeline.sanitizeOutputForOrchestrator(output);
		return DelegatePipeline.formatSuccess(cleaned, metrics, elapsedMs, toolCallTrail, turns);
	}

	/**
	 * Format a successful subagent result with findings, metadata, trail, audit, metrics.
	 */
	private static formatSuccess(
		output: string,
		metrics: DelegationMetrics,
		elapsedMs: number,
		toolCallTrail: any[],
		turns: number,
	): string {
		let result = output;

		// Prepend findings summary
		const findings = DelegatePipeline.extractFindingsFromOutput(result);
		if (findings && findings.summary) {
			const summaryParts = [`[Findings: ${findings.summary}]`];
			if (findings.key_files.length > 0) summaryParts.push(`Files: ${findings.key_files.join(', ')}`);
			if (findings.issues.length > 0 && findings.issues[0] !== 'none') summaryParts.push(`Issues: ${findings.issues.join('; ')}`);
			if (findings.recommendation) summaryParts.push(`Next: ${findings.recommendation}`);
			result = summaryParts.join('\n') + '\n\n' + result;
		}

		// Prepend execution metadata
		const execStatus = result?.startsWith("[error]") ? "error" : "ok";
		const execMeta = [`[Execution: elapsed=${(elapsedMs / 1000).toFixed(1)}s, turns=${turns}, status=${execStatus}]`];
		if (execStatus === "error") {
			execMeta.push(`[Error: ${result.slice(0, 200)}]`);
		}
		result = execMeta.join('\n') + '\n\n' + result;

		// Prepend tool call trail
		if (toolCallTrail && toolCallTrail.length > 0) {
			const trail = toolCallTrail.map(t =>
				`${t.completed ? statusIcon('completed') : getTheme().fg('warning', styledSymbol('status.warning'))} ${t.tool}${t.outputPreview ? ` → ${t.outputPreview}` : ''}`
			).join('\n');
			result = `[Tool Calls (${toolCallTrail.length}):\n${trail}\n]\n\n` + result;
		}

		// Prepend scope notes from structured data
		if (metrics.scopeNotes && metrics.scopeNotes.blockedTools.length > 0) {
			const blocks = metrics.scopeNotes.blockedTools;
			const details = blocks.map(b => `${b.tool} → ${b.target}: ${b.reason}`).join('; ');
			result = `[Scope: ${blocks.length} block(s) — ${details}]\n` + result;
		}

		// Prepend metrics line
		const metricsLine = formatMetricsLine(metrics);
		result = metricsLine + '\n' + result;

		// Status note
		const toolCalls = toolCallTrail?.length || 0;
		const turnWord = turns === 1 ? "turn" : "turns";
		const toolWord = toolCalls === 1 ? "tool call" : "tool calls";
		const statusNote = `${statusIcon('completed')} Completed (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;
		result = `${statusNote}\n${result}`;

		return result;
	}

	/**
	 * Format an error/abort result with trail and status note.
	 */
	private static formatErrorAbort(
		output: string,
		toolCallTrail: any[],
		turns: number,
		isAborted: boolean,
		errorMessage?: string,
		stopReason?: string,
	): string {
		const toolCalls = toolCallTrail?.length ?? 0;
		const turnWord = turns === 1 ? "turn" : "turns";
		const toolWord = toolCalls === 1 ? "tool call" : "tool calls";

		let trailStr = "";
		if (toolCallTrail && toolCallTrail.length > 0) {
			trailStr = "\nCompleted tool calls:\n" + toolCallTrail.map(t => `${t.completed ? statusIcon('completed') : getTheme().fg('warning', styledSymbol('status.warning'))} ${t.tool}`).join("\n");
		}

		const statusNote = isAborted
			? `${statusIcon('aborted')} Aborted — interrupted by user (${turns} ${turnWord}, ${toolCalls} ${toolWord})`
			: `${statusIcon('error')} Error (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;

		// Error banner that the orchestrator cannot ignore
		const errorBanner = isAborted
			? `\n⚠ DELEGATION ABORTED — partial results below. Do not trust partial data without verifying.\n`
			: `\n⚠ DELEGATION FAILED — status:${stopReason || 'unknown'} — ${errorMessage || 'no error message'}\nPartial results exist but may be incomplete or corrupted. Retry or escalate.\n`;

		return `${statusNote}${trailStr}\n${errorBanner}\n${output}`;
	}

	/**
	 * Extract structured findings from the "## Findings" section of an output string.
	 */
	static extractFindingsFromOutput(output: string): { summary: string; key_files: string[]; issues: string[]; recommendation: string } | null {
		const findingsMatch = output.match(/##\s+Findings\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
		if (!findingsMatch) return null;
		const block = findingsMatch[1];
		const extract = (key: string): string => {
			const m = block.match(new RegExp(`-?\\s*${key}:\\s*(.+)`, 'i'));
			return m ? m[1].trim() : '';
		};
		const extractList = (key: string): string[] => {
			const m = block.match(new RegExp(`-?\\s*${key}:\\s*\\[?(.+?)\\]?\\s*$`, 'im'));
			if (!m) return [];
			const inner = m[1].trim();
			if (inner === ']' || inner === '') return [];
			return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
		};
		return {
			summary: extract('summary') || '',
			key_files: extractList('key_files'),
			issues: extractList('issues'),
			recommendation: extract('recommendation') || '',
		};
	}

	/**
	 * Output hygiene: when a structured report exists in the output, strip raw
	 * JSON tool-result blocks and `[tool result]` markers that burn context tokens.
	 * When no report exists, leave output as-is (already diagnostic/salvaged).
	 */
	static sanitizeOutputForOrchestrator(output: string): string {
		const hasReport = /##\s+(Findings|Completed|Audit|Verification|Scope|Notes|Recommendations|Pending Questions|Files Changed)\b/.test(output);
		if (!hasReport) return output;

		const lines = output.split('\n');
		const keepSections = new Set([
			'findings', 'completed', 'audit', 'verification',
			'scope', 'notes', 'recommendations', 'pending questions',
			'files changed',
		]);
		const kept: string[] = [];
		let inReportSection = false;

		for (const line of lines) {
			if (/^\[Metrics:/.test(line) || /^\[Execution:/.test(line) || /^\[Scope:/.test(line)) {
				kept.push(line); continue;
			}
			if (/^[✓✗⚠−]/.test(line)) {
				kept.push(line); continue;
			}
			const sectionMatch = line.match(/^##\s+(.+)/);
			if (sectionMatch) {
				const sectionName = sectionMatch[1].toLowerCase().trim();
				inReportSection = keepSections.has(sectionName);
				if (inReportSection) { kept.push(line); continue; }
			}
			if (inReportSection) { kept.push(line); continue; }
			// Strip noise outside report sections
			if (/^\s*\{\s*"/.test(line) || /^\s*\[\s*\{\s*"/.test(line)) continue;
			if (/^\s*\[tool result/.test(line) || /^\s*\[already read/.test(line)) continue;
			if (/^\s*\[Tool Calls/.test(line)) continue;
			if (/^\s*\[Findings:/.test(line)) continue;
			if (/^\s*\[Error:/.test(line)) continue;
			if (/^\s*\[(aborted|error)\]/.test(line)) continue;
			if (/^⚠️?\s*\[Diagnostic\]/.test(line)) continue;
			if (line.trim() === '' && kept.length > 0 && kept[kept.length - 1].trim() === '') continue;
			kept.push(line);
		}
		let result = kept.join('\n').trim();
		if (output.trim().length < 50) {
			result = `⚠ PARTIAL — salvaged\n\n${result}`;
		}
		return result;
	}

}

// ── Standalone exports for test compatibility ───────────────────────────
// These wrap DelegatePipeline static methods so they can be imported
// directly as functions by tests.

export function extractFindingsFromOutput(output: string) {
	return DelegatePipeline.extractFindingsFromOutput(output);
}



export interface FormatResultParams {
	output: string;
	metrics: DelegationMetrics;
	elapsed: number;
	turns: number;
	toolCalls: number;
	status: 'ok' | 'error' | 'aborted';
	toolCallTrail?: Array<{ tool: string; outputPreview?: string; completed: boolean }>;
}

export function formatResult(params: FormatResultParams): {
	formatted: string;
	findings: ReturnType<typeof extractFindingsFromOutput>;
	audit: { problems: string[]; resolution: string[] } | null;
} {
	const { output, metrics, elapsed, turns, toolCalls, status, toolCallTrail } = params;
	const isAborted = status === 'aborted';
	const isError = status === 'error';

	// Reconstruct the internal formatting logic
	let statusLine: string;
	if (status === 'ok') {
		statusLine = `${statusIcon("completed")} Completed (${turns} ${turns === 1 ? 'turn' : 'turns'}, ${toolCalls} ${toolCalls === 1 ? 'tool call' : 'tool calls'})`;
	} else if (status === 'aborted') {
		statusLine = `${statusIcon("aborted")} Aborted — interrupted by user (${turns} ${turns === 1 ? 'turn' : 'turns'}, ${toolCalls} ${toolCalls === 1 ? 'tool call' : 'tool calls'})`;
	} else {
		statusLine = `${statusIcon('error')} Error (${turns} ${turns === 1 ? 'turn' : 'turns'}, ${toolCalls} ${toolCalls === 1 ? 'tool call' : 'tool calls'})`;
	}

	const metricsLine = `[Metrics: read=${metrics.readCalls}, grep=${metrics.grepCalls}, find=${metrics.findCalls}, edit=${metrics.editCalls}, write=${metrics.writeCalls}, bash=${metrics.bashCalls}, ls=${metrics.lsCalls}]`;

	let trailStr = '';
	if (toolCallTrail && toolCallTrail.length > 0) {
		const trailItems = toolCallTrail.map(t => {
			const icon = t.completed ? statusIcon("completed") : getTheme().fg("warning", styledSymbol("status.warning"));
			const preview = t.outputPreview ? ` ${getTheme().fg("dim", styledSymbol("icon.tool"))} ${t.outputPreview}` : '';
			return `${icon} ${t.tool}${preview}`;
		}).join('\n');
		trailStr = `\n\n[Tool Calls (${toolCallTrail.length}):\n${trailItems}]`;
	}

	const execStr = `\n\n[Execution: elapsed=${elapsed}s, turns=${turns}, status=${status}]`;

	let findingsStr = '';
	const findings = extractFindingsFromOutput(output);
	if (findings) {
		findingsStr = `\n\n[Findings: ${findings.summary}]`;
	}

	const audit = null;

	let outputSection = output;
	if (isError) {
		const truncated = output.length > 200 ? output.slice(0, 200) : output;
		outputSection = `[Error: ${truncated}]`;
	}

	const formatted = `${statusLine}\n${metricsLine}${trailStr}${execStr}${findingsStr}\n\n${outputSection}`;

	return { formatted, findings, audit };
}

export function sanitizeOutputForOrchestrator(output: string) {
	return DelegatePipeline.sanitizeOutputForOrchestrator(output);
}
