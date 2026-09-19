/**
 * DelegatePipeline — orchestrates specialist subagent delegation end-to-end.
 * Inlined from handle-diagnostics.ts and delegate-result-processor.ts.
 */
import type { Specialist, DelegationMetrics, SubagentContext, SubagentDiagnostic, DelegateControllerContext, BatchDelegationEntry } from "./types.ts";
import { SPECIALISTS, SPECIALIST_VERBS, getSpecialistSkills, DELIVERABLE_MARKERS, isReadOnlySpecialist } from "./specialists.ts";
import { createAskOrchestratorResolver, resolve } from "./ask-resolver.ts";
import { runSubagent, ERROR_MARKER, ABORT_MARKER, PROVIDER_RETRY_MAX_ATTEMPTS, providerBackoffDelayMs, type OrchestratorUi } from "./subagent-runner.ts";
import { hasActivePlan, setupPlanPanel, startDelegationStep, finalizePlanStep, errorPlanStep, incrementDelegationCount, decrementDelegationCount, clearPlanIfComplete, updatePlanStepDetail, recordTimelineFrame } from "./plan-panel.ts";
import { debugLog } from "./debug.ts";
import { hidePeek, clearViewerState } from "./peek-overlay.ts";
import { Scope, ScopeManager, createDelegationScope, clearDelegationScope } from "./scope-manager.ts";
import { SPINNER_FRAMES, currentFrame } from "./spinner-state.ts";
import { formatMetricsLine } from "./types.ts";
import { captureDiagnostic, isDiagnosticsEnabled, persistDiagnostic, cleanupOldDiagnostics } from "./subagent-diagnostics.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import type { BudgetStatus } from "./subagent-runner.ts";
import type { CalibrationRecord, CalibrationBudgetGate } from "./types.ts";

/** Neutral BudgetStatus — used when a delegation produced no calibration inputs. */
export const EMPTY_BUDGET_STATUS: BudgetStatus = {
	exceeded: false,
	breachKind: "none",
	reason: "",
	explorationCalls: 0,
	distinctFiles: 0,
	turns: 0,
};

/** Neutral budget-gate outcome — no breach, nothing forced. */
export const EMPTY_BUDGET_GATE: CalibrationBudgetGate = {
	forced: false,
	grossBreach: false,
	finalRecommend: "",
	banner: "",
};

/**
 * Merge the calibration record into an existing flight-recorder dump file
 * (read-modify-write, SAME path — ONE joinable record per delegation, no join
 * key required). ADDITIVE instrumentation: it records escalation data the
 * pipeline already computed and never influences any decision.
 *
 * Best-effort: never throws. An undefined path (the runner did not write a dump)
 * or an unwritable file must NOT break a delegation. Mirrors the existing
 * flight-recorder gating — the write is not gated by PI_ORCHESTRATOR_DIAGNOSTICS;
 * it is attempted and failures are swallowed.
 */
export function writeCalibrationRecord(
	filePath: string | undefined,
	calibration: CalibrationRecord,
): void {
	if (!filePath) return;
	try {
		const raw = readFileSync(filePath, "utf-8");
		const record = JSON.parse(raw);
		Object.assign(record, calibration);
		writeFileSync(filePath, JSON.stringify(record, null, 2));
	} catch {
		// Best-effort — never let instrumentation failure break a delegation.
	}
}
import os from "os";
import { statusIcon, styledSymbol, getTheme } from "./orchestrator-theme.ts";
import { getSessionMode, loadOrchestratorConfig } from "./orchestrator-config";
import { sanitizeOutputForOrchestrator as sanitizeOutputShared } from "./activity-feed.ts";
import { DELEGATION_OUTCOME, classifyProviderFailure, type DelegationOutcome } from "./outcome.ts";

// ── Delegation outcome mapping (canonical taxonomy from outcome.ts) ───────────

/** Observable signals the pipeline maps onto a DELEGATION_OUTCOME. */
export interface DelegationOutcomeInputs {
	status?: 'completed' | 'error' | 'aborted';
	stopReason?: string;
	errorMessage?: string;
	/** ProgressState from ProgressDetector (HEALTHY | DEGRADED | STALLED). */
	progressState?: string;
	/** Provider/infra failures observed in the final detector window. */
	providerFailures?: number;
	/** Unresolved ask_orchestrator questions — delegation blocked on orchestrator input. */
	blocked?: boolean;
	/** Delegation timeout ceiling hit (AbortSignal.timeout fired). */
	timedOut?: boolean;
	/** Coder/writer finished with zero work (no tool calls, no deliverable). */
	noWork?: boolean;
	/** True when the runner terminated after an unanswered stall nudge. */
	stallTerminated?: boolean;
}

/**
 * Map observable SubagentResult signals to the canonical DELEGATION_OUTCOME.
 *
 * Priority order:
 *  1. PROVIDER_FAILURE — provider/infra faults are classified FIRST so they can
 *     NEVER be mapped to agent stuckness (stalled_no_progress).
 *  2. RESOURCE_LIMIT  — timeout/ceiling hit.
 *  3. BLOCKED         — subagent asked the orchestrator and got no resolution.
 *  4. STALLED_NO_PROGRESS — detector says STALLED with zero provider failures
 *     (agent-level stuckness only; guarded against provider faults).
 *  5. INCOMPLETE      — aborted / errored / stopped early / no-work.
 *  6. DONE            — clean completion with a deliverable.
 */
export function classifyDelegationOutcome(i: DelegationOutcomeInputs): DelegationOutcome {
	const O = DELEGATION_OUTCOME;

	// 1. Provider/infra faults first — never read as agent stuckness.
	if (i.status === 'error' && classifyProviderFailure(i.errorMessage)) {
		return O.PROVIDER_FAILURE;
	}

	// 2. Resource ceilings (delegation timeout backstop fired).
	if (i.timedOut) {
		return O.RESOURCE_LIMIT;
	}

	// 3. Blocked on orchestrator input.
	if (i.blocked) {
		return O.BLOCKED;
	}

	// 4. Agent-level stall — requires a STALLED detector state AND no provider
	//    failures in the window (a provider-only window is DEGRADED upstream and
	//    must route to provider_failure, not stalled_no_progress).
	if (i.progressState === 'STALLED' && (i.providerFailures ?? 0) === 0 && i.status !== 'completed') {
		return O.STALLED_NO_PROGRESS;
	}
	if (i.progressState === 'STALLED' && (i.providerFailures ?? 0) === 0 && i.status === 'completed' && i.stallTerminated === true) {
		// Completed but terminated after an unanswered stall nudge — still an
		// agent-level stall outcome. A completed run WITHOUT termination is a
		// success even if the detector window went silent during report writing
		// (C1 guard): it falls through to DONE below.
		return O.STALLED_NO_PROGRESS;
	}

	// 5. Aborted / stopped early / no-work.
	if (i.status === 'aborted') return O.INCOMPLETE;
	if (i.status === 'error') return O.INCOMPLETE;
	if (i.noWork) return O.INCOMPLETE;

	// 6. Clean completion.
	return O.DONE;
}


/**
 * Extract the `## Findings` section from subagent output.
 * Returns everything from `## Findings` to the next `##` heading or end of string.
 */
function extractFindingsText(output: string | undefined): string | undefined {
	if (!output) return undefined;
	const idx = output.indexOf('## Findings');
	if (idx === -1) return undefined;
	const afterHeading = output.indexOf('\n', idx);
	if (afterHeading === -1) return output.slice(idx).trim();
	const nextHeading = output.indexOf('\n## ', afterHeading + 1);
	if (nextHeading === -1) return output.slice(idx).trim();
	return output.slice(idx, nextHeading).trim();
}

/**
 * Difficulty signal contract (PART A) — the subagent's self-reported escalation signal.
 * Emitted at the end of the \`## Findings\` report (see \`## Difficulty\` block).
 * Each field is the literal string the subagent emitted; empty string when absent.
 */
export interface DifficultySignal {
	exploration: 'low' | 'medium' | 'high' | '';
	uncertainty: 'low' | 'medium' | 'high' | '';
	verification: 'pass' | 'fail' | '';
	iteration: 'low' | 'medium' | 'high' | '';
	recommend: 'none' | 'review' | 'investigate' | 'plan' | '';
}

/**
 * Format a DifficultySignal for the delegate output the orchestrator sees.
 * Falls back to a neutral value (\`[Difficulty: not reported]\`) when the block is absent
 * or empty — the orchestrator treats this as "no escalation signal".
 */
export function formatDifficultySignal(d: DifficultySignal | null): string {
	if (!d) return '[Difficulty: not reported]';
	const parts: string[] = [];
	if (d.exploration) parts.push(`exploration=${d.exploration}`);
	if (d.uncertainty) parts.push(`uncertainty=${d.uncertainty}`);
	if (d.verification) parts.push(`verification=${d.verification}`);
	if (d.iteration) parts.push(`iteration=${d.iteration}`);
	if (d.recommend) parts.push(`recommend=${d.recommend}`);
	return parts.length > 0 ? `[Difficulty: ${parts.join(', ')}]` : '[Difficulty: not reported]';
}

/** Result type returned by executeDelegate */
export interface ExecuteDelegateResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

/**
 * Full delegation pipeline — scope resolution, subagent execution, diagnostics,
 * result formatting, plan-panel lifecycle.
 */
/**
 * Hard cap for auto-created plan labels (matches the batch path's substring(0, 60)).
 */
export const AUTO_PLAN_LABEL_MAX = 60;

/**
 * Cap a label to `max` chars at a WORD boundary (never mid-word), appending an
 * ellipsis. This is the LAST resort for the semantic compressor — it only runs
 * when a clean clause still overflows the widget cap.
 */
export function capAtWordBoundary(s: string, max = AUTO_PLAN_LABEL_MAX): string {
	const trimmed = s.replace(/\s+/g, " ").trim();
	if (trimmed.length <= max) return trimmed;
	const hard = trimmed.slice(0, max - 1); // leave room for the ellipsis
	const lastSpace = hard.lastIndexOf(" ");
	const wordSafe = lastSpace > 0 ? hard.slice(0, lastSpace) : hard;
	return wordSafe.replace(/[\s\-–—:;,]+$/, "") + "…";
}

/**
 * Semantic compression for auto-created plan labels.
 *
 * Unlike character truncation, this extracts the FIRST meaningful clause at a
 * natural boundary — sentence end (`. `), em/en-dash, hyphen, colon, or
 * newline — so the label reads as a real summary rather than a cut-off string.
 * A word-boundary cut with an ellipsis is applied ONLY when the extracted
 * clause still exceeds `max`.
 */
export function compressTaskToLabel(task: string, max = AUTO_PLAN_LABEL_MAX): string {
	const normalized = task.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
	if (!normalized) return "task";

	// Natural boundaries, earliest position wins.
	const boundaries = ["\n", ". ", " — ", " – ", " - ", ": "];
	let cut = -1;
	for (const b of boundaries) {
		const idx = normalized.indexOf(b);
		if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
	}

	let clause = cut === -1 ? normalized : normalized.slice(0, cut);

	// A single-sentence task ends with a terminal period and no `. ` boundary.
	clause = clause.replace(/[.]+$/, "");

	// Strip wrapping punctuation/filler and collapse whitespace.
	clause = clause
		.replace(/^[\s\-–—:;,.]+/, "")
		.replace(/[\s\-–—:;,]+$/, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!clause) return "task";

	// Capitalize sensibly: upper-case the first character, leave the rest.
	clause = clause.charAt(0).toUpperCase() + clause.slice(1);

	// Last resort only: word-boundary cut + ellipsis.
	return capAtWordBoundary(clause, max);
}

/**
 * Build the auto-created plan goal + step label for an implicit delegation.
 *
 * Prefers an explicit `label` (the orchestrator's short summary) when supplied;
 * otherwise derives a semantic summary from the raw task via
 * compressTaskToLabel(). Never leaks the raw, unbounded task string.
 */
export function buildAutoPlanLabels(
	specialistName: string,
	specName: string,
	task: string,
	label?: string,
): { stepLabel: string; autoGoal: string } {
	const explicit = label?.trim();
	const summary = explicit
		? capAtWordBoundary(explicit.replace(/\s+/g, " "), AUTO_PLAN_LABEL_MAX)
		: compressTaskToLabel(task, AUTO_PLAN_LABEL_MAX);
	return {
		stepLabel: capAtWordBoundary(`${specName}: ${summary}`, AUTO_PLAN_LABEL_MAX),
		autoGoal: capAtWordBoundary(`delegate to ${specialistName}: ${summary}`, AUTO_PLAN_LABEL_MAX),
	};
}

/**
 * Single source of truth for a batch entry's plan step label. Mirrors the
 * single-delegation path: semantic summary from the task, or the entry's
 * explicit `label` when provided.
 */
export function buildBatchStepLabel(specialist: string, task: string, label?: string): string {
	const specName = specialist.charAt(0).toUpperCase() + specialist.slice(1);
	return buildAutoPlanLabels(specialist, specName, task, label).stepLabel;
}

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
		params: { specialist: string; task: string; skills?: string[]; scope?: Scope; signal?: AbortSignal; parallel?: boolean; skipStepTracking?: boolean; label?: string },
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

		// Read-only specialists (no edit/write tools) don't need strict scope validation.
		// SSOT (V5): use the registry's declared flag, not a re-derivation from tools.
		const isReadOnly = isReadOnlySpecialist(specialist.name);

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

		// Resolve skills: override merges (union) with defaults (issue #42)
		const resolvedSuggestedSkills = getSpecialistSkills(specialist.name, params.skills);

		const { signal } = params;

		// ── Timeout signal: combine user signal with config timeout ──
		const timeoutMs = ctx.config?.delegation?.parallel?.timeoutMs;
		// Hold the timeout signal so we can attribute aborts: a timeout-ceiling abort
		// maps to RESOURCE_LIMIT, a user abort maps to INCOMPLETE.
		let timedOut = false;
		const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
		timeoutSignal?.addEventListener("abort", () => { timedOut = true; }, { once: true });
		const effectiveSignal = timeoutMs
			? AbortSignal.any([signal, timeoutSignal].filter(Boolean) as AbortSignal[])
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
		// FIX 1: shorten the raw task for both the step label and the auto goal.
		const { stepLabel, autoGoal } = buildAutoPlanLabels(specialist.name, specName, params.task, params.label);

		// Auto-create minimal plan if none exists
		if (!hasActivePlan(ctx)) {
			const autoSteps = [stepLabel];
			setupPlanPanel(autoGoal, autoSteps, ctx);
			debugLog('[delegate-pipeline] auto-created plan:', autoGoal);
		}

		if (!params.skipStepTracking) {
			startDelegationStep(stepLabel, ctx);
		}

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
		// BUG-1: counters were previously fed from update.details.tool, which the
		// runner never emits — they stayed 0 forever. Metrics now come from the
		// runner's real tool-call counts (derived from SDK tool events).
		const EMPTY_METRICS: DelegationMetrics = {
			readCalls: 0,
			grepCalls: 0,
			findCalls: 0,
			editCalls: 0,
			writeCalls: 0,
			bashCalls: 0,
			lsCalls: 0,
		};
		let metrics: DelegationMetrics = { ...EMPTY_METRICS };
		const wrappedOnUpdate = (update: any) => {
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

		// ── Append acceptance test instructions for coder tasks ──
		const effectiveTask = (params.specialist === "coder" && params.task)
		    ? params.task + "\n\n## Acceptance Tests\nAfter implementing, describe acceptance tests (vitest assertions, plain text) that verify your work:\n- Happy path — confirm feature works as expected\n- Edge cases — boundary conditions are handled\n- Regression (if fixing a bug) — fix stays effective\n\nInclude these as plain-text assertions under a ## Acceptance Tests section in your output. Do NOT use the plan() tool.\n"
		    : params.task;

		// ── Run subagent with provider-failure retry OUTSIDE the agent loop ──
		// A stop-reason-level provider fault (5xx, rate-limit, timeout) is retried by
		// re-running the delegation after exponential backoff — a fresh session per
		// attempt. These retries NEVER consume agent turns and are NEVER mapped to
		// agent stuckness (stalled_no_progress). Auth failures are not retried.
		let providerRetryAttempts = 0;
		let result;
		for (;;) {
			result = await runSubagent(
				specialist, effectiveTask, ctx.cwd,
				parentCtx,
				effectiveSignal, wrappedOnUpdate, scopeToUse, orchestratorUi, resolvedSuggestedSkills,
				ctx, // orchestratorCtx: thread session context to plan-panel calls
			);
			const providerKind = result?.status === "error"
				? classifyProviderFailure(result?.errorMessage)
				: null;
			if (providerKind && providerRetryAttempts < PROVIDER_RETRY_MAX_ATTEMPTS) {
				providerRetryAttempts++;
				debugLog("[provider-retry] pipeline backoff retry", { kind: providerKind, attempt: providerRetryAttempts });
				onUpdate?.({
					content: [{ type: "text", text: `${currentFrame()} ↻ ${specialist.name} provider failure (${providerKind}) — retry ${providerRetryAttempts}/${PROVIDER_RETRY_MAX_ATTEMPTS} after backoff` }],
					details: { status: "running", specialist: specialist.name, providerRetry: providerRetryAttempts },
				});
				await new Promise<void>(r => setTimeout(r, providerBackoffDelayMs(providerRetryAttempts - 1)));
				continue;
			}
			break;
		}
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

		// Real metrics derived from the runner's tool-call trail (BUG-1)
		metrics = { ...EMPTY_METRICS, ...(result?.metrics ?? {}) };
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
		// BUG-4: single source of truth — the runner's finalStatus, not output sniffing
		const isAborted = (effectiveSignal?.aborted || false) || result?.status === "aborted" || (result?.output?.startsWith(ABORT_MARKER) ?? false);
		let isError = !result || !result.output || result.output.startsWith(ERROR_MARKER) || result.output.startsWith(ABORT_MARKER)
			|| result?.status === "error" || result?.stopReason === "error"
			// A stall-terminated delegation is NOT a successful completion — the plan
			// step must NOT auto-advance (same semantics as other failures).
			|| result?.stallTerminated === true;
		let hasError = isAborted || isError;

		// ── No-work detection for coder/writer ──
		// BUG-2: heuristic reads REAL metrics + trail, so a coder that did 11 bash
		// calls (backup cp, curl, tar) is no longer falsely failed for lacking
		// `## Completed` deliverable markers.
		const isCodeSpecialist = specialist.name === 'coder' || specialist.name === 'writer';
		const hasMutatingCalls = metrics.editCalls > 0 || metrics.writeCalls > 0 || metrics.bashCalls > 0;
		const hasAnyToolCalls = (result?.toolCallTrail?.length ?? 0) > 0;
		const hasDeliverable = rawSubagentOutput && (
			DELIVERABLE_MARKERS.some(marker => rawSubagentOutput.includes(marker))
		);
		const isNoWork = isCodeSpecialist && !hasMutatingCalls && !hasAnyToolCalls && !hasDeliverable && !hasError;

		if (isNoWork) {
			hasError = true;
			isError = true;
			// BUG-4: no-work must carry a real errorMessage so the failure banner is not
			// "status:unknown — no error message"
			result.errorMessage = `no-work completion — ${specialist.name} returned ok with zero tool calls and no deliverable.`;
			result.stopReason = result.stopReason ?? "no-work";
			result.output = `⚠ ${result.errorMessage} Plan step NOT advanced.`;
		}

		// ── Canonical outcome mapping (see classifyDelegationOutcome) ──
		const outcome = classifyDelegationOutcome({
			status: result?.status,
			stopReason: result?.stopReason,
			errorMessage: result?.errorMessage,
			progressState: result?.progressState,
			providerFailures: result?.providerFailures,
			blocked: pendingQuestions.length > 0,
			timedOut,
			noWork: isNoWork,
			stallTerminated: result?.stallTerminated === true,
		});

		// ── Persist the calibration record (instrumentation; best-effort, non-throwing) ──
		// Read-modify-write into the SAME flight-recorder dump the runner already wrote,
		// keyed by its path — ONE joinable record per delegation, no join key needed.
		writeCalibrationRecord(result?.flightRecorderPath, {
			difficulty: result?.calibration?.difficulty ?? null,
			difficultyPresent: result?.calibration?.difficultyPresent ?? false,
			budget: result?.calibration?.budget ?? EMPTY_BUDGET_STATUS,
			budgetGate: result?.calibration?.budgetGate ?? EMPTY_BUDGET_GATE,
			outcome,
			progress: {
				progressState: result?.progressState,
				providerFailures: result?.providerFailures,
				stallTerminated: result?.stallTerminated === true,
			},
		});

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

		// ── Format result output ──
		let autoAdvancedStep: string | undefined;
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
					undefined, undefined,
					outcome,
				);
			} else if (result?.output) {
				// Error/abort path
				result.output = this.processDelegateResult(
					result.output, metrics, elapsedMs,
					result.toolCallTrail || [], result.turns ?? 0,
					isAborted, isError,
					result?.errorMessage,
					result?.stopReason,
					outcome,
				);
			}

			// Mark plan step
			if (!params.skipStepTracking) {
				if (hasError) {
					errorPlanStep(ctx, isAborted, result?.errorMessage);
				} else {
					autoAdvancedStep = finalizePlanStep(ctx);
				}
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
			outcome,
			progressState: result?.progressState,
			providerFailures: result?.providerFailures,
			stallTerminated: result?.stallTerminated === true ? true : undefined,
			providerRetries: result?.providerRetries,
			toolCalls: result?.toolCallTrail?.length ?? 0,
			lastAssistantMessage: result?.lastAssistantMessage ? result.lastAssistantMessage.slice(0, 500) : undefined,
			planSteps: result?.planSteps,
			autoCompletedSteps: (result?.planSteps ?? []).filter(p => p.autoCompleted).length,
			metrics: result?.metrics,
			partialResults: hasError && !!rawSubagentOutput && !rawSubagentOutput.startsWith(ERROR_MARKER) && !rawSubagentOutput.startsWith(ABORT_MARKER),
			partialMarker: (hasError && !!rawSubagentOutput && !rawSubagentOutput.startsWith(ERROR_MARKER) && !rawSubagentOutput.startsWith(ABORT_MARKER)) ? "⚠ PARTIAL" : undefined,
			autoAdvancedStep: autoAdvancedStep || undefined,
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

			// PRE-CREATE steps for each batch entry (sequential, not concurrent)
			const stepIndices: number[] = [];
			for (const entry of chunk) {
				const stepLabel = buildBatchStepLabel(entry.specialist, entry.task, entry.label);
				const idx = startDelegationStep(stepLabel, ctx, { isBatch: true });
				stepIndices.push(idx);
			}

			// Run all concurrently, suppressing inner step tracking
			const chunkResults = await Promise.allSettled(
				chunk.map(async (entry, i) => {
					const entryStart = Date.now();
					try {
						const result = await this.run(
							{
								specialist: entry.specialist,
								task: entry.task,
								skills: entry.skills,
								scope: entry.scope,
								label: entry.label,
								signal,
								parallel: true,
								skipStepTracking: true,
							},
							ctx,
							onUpdate,
						);
						const output = result.content?.[0]?.type === "text" ? result.content[0].text : "";
						return {
							specialist: entry.specialist,
							success: true,
							output,
							stepIndex: stepIndices[i],
							elapsed_ms: Date.now() - entryStart,
						};
					} catch (e) {
						return {
							specialist: entry.specialist,
							success: false,
							output: "",
							error: String(e),
							stepIndex: stepIndices[i],
							elapsed_ms: Date.now() - entryStart,
						};
					}
			})
			);

			// Finalize each entry's pre-created step and collect results
			for (const settled of chunkResults) {
				if (settled.status === 'fulfilled') {
					const { stepIndex, ...rest } = settled.value;
					allResults.push(rest);
					if (rest.success) {
						finalizePlanStep(ctx, stepIndex);
					} else {
						errorPlanStep(ctx, false, rest.error);
					}
				} else {
					allResults.push({
						specialist: 'unknown',
						success: false,
						output: '',
						error: String(settled.reason),
					});
					errorPlanStep(ctx, false, String(settled.reason));
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
				partialResults: false,
				partialMarker: undefined,
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

		let diagnostic = captureDiagnostic({
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
			findingsText: extractFindingsText(result?.output),
		});

		// Always capture diagnostic on abort, even if captureDiagnostic returned null
		if (!diagnostic && result?.output?.startsWith('[aborted]')) {
			diagnostic = captureDiagnostic({
				output: result?.output || '',
				turns: result?.turns || 0,
				toolCallTrail: [],
				elapsedMs: Date.now() - startTime,
				specialist: specialistName,
				task,
				sessionId: ctx.sessionId || 'unknown',
				metrics,
				agentDir: getAgentDir(),
				model: result?.model,
				stopReason: result?.stopReason,
				errorMessage: result?.errorMessage || 'Aborted by user',
				findingsText: extractFindingsText(result?.output),
			});
		}

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
		outcome?: DelegationOutcome,
	): string {
		if (isAborted || isError) {
			return DelegatePipeline.formatErrorAbort(output, toolCallTrail, turns, isAborted, errorMessage, stopReason, outcome);
		}
		// Output hygiene: strip raw JSON tool-result blocks when report exists
		const cleaned = DelegatePipeline.sanitizeOutputForOrchestrator(output);
		return DelegatePipeline.formatSuccess(cleaned, metrics, elapsedMs, toolCallTrail, turns, outcome);
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
		outcome?: DelegationOutcome,
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

		// Prepend difficulty signal (adaptive escalation) — default to neutral when absent
		const difficulty = DelegatePipeline.extractDifficultyFromOutput(result);
		result = formatDifficultySignal(difficulty) + '\n\n' + result;

		// Prepend execution metadata
		const execStatus = result?.startsWith(ERROR_MARKER) ? "error" : "ok";
		const execMeta = [`[Execution: elapsed=${(elapsedMs / 1000).toFixed(1)}s, turns=${turns}, status=${execStatus}]`];
		if (execStatus === "error") {
			execMeta.push(`[Error: ${result.slice(0, 200)}]`);
		}
		if (outcome) {
			execMeta.push(`[Outcome: ${outcome}]`);
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
		outcome?: DelegationOutcome,
	): string {
		const toolCalls = toolCallTrail?.length ?? 0;
		const turnWord = turns === 1 ? "turn" : "turns";
		const toolWord = toolCalls === 1 ? "tool call" : "tool calls";

		let trailStr = "";
		if (toolCallTrail && toolCallTrail.length > 0) {
			trailStr = "\nCompleted tool calls:\n" + toolCallTrail.map(t => `${t.completed ? statusIcon('completed') : getTheme().fg('warning', styledSymbol('status.warning'))} ${t.tool}`).join("\n");
		}

		const outcomeTag = outcome ? ` [outcome: ${outcome}]` : "";
		const statusNote = isAborted
			? `${statusIcon('aborted')} Aborted — ${outcome === DELEGATION_OUTCOME.RESOURCE_LIMIT ? 'resource limit (timeout ceiling)' : 'interrupted by user'} (${turns} ${turnWord}, ${toolCalls} ${toolWord})`
			: `${statusIcon('error')} Error (${turns} ${turnWord}, ${toolCalls} ${toolWord})${outcomeTag}`;

		// Error banner that the orchestrator cannot ignore
		const errorBanner = isAborted
			? `\n⚠ DELEGATION ABORTED — partial results below. Do not trust partial data without verifying.${outcomeTag}\n`
			: `\n⚠ DELEGATION FAILED — status:${stopReason || 'unknown'} — ${errorMessage || 'no error message'}${outcomeTag}\nPartial results exist but may be incomplete or corrupted. Retry or escalate.\n`;

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
	 * Extract the `## Difficulty` block into a structured DifficultySignal.
	 * Returns null when no `## Difficulty` block is present — callers surface the
	 * neutral `[Difficulty: not reported]` fallback via formatDifficultySignal.
	 */
	static extractDifficultyFromOutput(output: string): DifficultySignal | null {
		const diffMatch = output.match(/##\s+Difficulty\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
		if (!diffMatch) return null;
		const block = diffMatch[1];
		// Capture the value up to end-of-line or a trailing `#` comment.
		const extract = (key: string): string => {
			const m = block.match(new RegExp(`-?\\s*${key}:\\s*([^\\n#]+)`, 'i'));
			return m ? m[1].trim() : '';
		};
		return {
			exploration: extract('exploration') as DifficultySignal['exploration'],
			uncertainty: extract('uncertainty') as DifficultySignal['uncertainty'],
			verification: extract('verification') as DifficultySignal['verification'],
			iteration: extract('iteration') as DifficultySignal['iteration'],
			recommend: extract('recommend') as DifficultySignal['recommend'],
		};
	}

	/**
	 * Output hygiene: when a structured report exists in the output, strip raw
	 * JSON tool-result blocks and `[tool result]` markers that burn context tokens.
	 * When no report exists, leave output as-is (already diagnostic/salvaged).
	 */
	static sanitizeOutputForOrchestrator(output: string): string {
		return sanitizeOutputShared(output);
	}

}

// ── Standalone exports for test compatibility ───────────────────────────
// These wrap DelegatePipeline static methods so they can be imported
// directly as functions by tests.

export function extractFindingsFromOutput(output: string) {
	return DelegatePipeline.extractFindingsFromOutput(output);
}

export function extractDifficultyFromOutput(output: string): DifficultySignal | null {
	return DelegatePipeline.extractDifficultyFromOutput(output);
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
	difficulty: DifficultySignal | null;
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

	const metricsLine = formatMetricsLine(metrics);

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

	// Adaptive escalation: surface the subagent's difficulty signal (neutral when absent).
	const difficulty = extractDifficultyFromOutput(output);
	const difficultyStr = `\n\n${formatDifficultySignal(difficulty)}`;

	const audit = null;

	let outputSection = output;
	if (isError) {
		const truncated = output.length > 200 ? output.slice(0, 200) : output;
		outputSection = `[Error: ${truncated}]`;
	}

	const formatted = `${statusLine}\n${metricsLine}${trailStr}${execStr}${findingsStr}${difficultyStr}\n\n${outputSection}`;

	return { formatted, findings, difficulty, audit };
}

export function sanitizeOutputForOrchestrator(output: string) {
	return sanitizeOutputShared(output);
}
