/**
 * Delegate controller — thin orchestrator for specialist subagent delegation.
 * Extracted modules: resolve-delegation-scope, apply-scope, handle-diagnostics, delegate-result-processor.
 * No behavioral changes from original monolith.
 */

import type { Specialist, DelegationMetrics, SubagentContext, Scope, SubagentDiagnostic, DelegateControllerContext } from "./types.ts";
import { SPECIALISTS, SPECIALIST_VERBS, getSpecialistSkills } from "./specialists.ts";
import { createAskOrchestratorResolver } from "./ask-resolver.ts";
import { runSubagent, type OrchestratorUi } from "./subagent-runner.ts";
import { hasActivePlan, startDelegationStep, finalizePlanStep, errorPlanStep, incrementDelegationCount, decrementDelegationCount, clearPlanIfComplete, updatePlanStepDetail, recordTimelineFrame } from "./plan-panel.ts";
import { debugLog } from "./debug.ts";
import { hidePeek, clearViewerState } from "./peek-overlay.ts";
import { ScopeManager } from "./scope-manager.ts";
import { SPINNER_FRAMES, getSpinnerIndex } from "./spinner-state.ts";
import { resolveScope } from "./resolve-delegation-scope.ts";
import { applyScope } from "./apply-scope.ts";
import { handleDiagnostics } from "./handle-diagnostics.ts";
import { processDelegateResult } from "./delegate-result-processor.ts";

// Verb mapping now lives in specialists.ts as SPECIALIST_VERBS (SSOT with SPECIALISTS dict)

/** Result type returned by executeDelegate */
export interface ExecuteDelegateResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

/**
 * Execute a delegation to a specialist subagent.
 *
 * @param params - Delegation parameters (specialist, task, optional scope, optional signal)
 * @param ctx - Agent context (cwd, modelRegistry, model, ui, etc.)
 * @param onUpdate - Callback for progress updates during execution
 * @returns Result with content and details
 */
export async function executeDelegate(
	params: { specialist: string; task: string; skills?: string[]; scope?: Scope; signal?: AbortSignal },
	ctx: DelegateControllerContext,
	onUpdate: (update: any) => void,
): Promise<ExecuteDelegateResult> {
	if (!params.specialist || !params.task) {
		const result0: ExecuteDelegateResult = { content: [{ type: "text" as const, text: "Provide specialist+task" }], details: {} }; return result0;
	}

	const key = params.specialist?.toLowerCase().trim();
	const specialist: Specialist | undefined = key && Object.hasOwn(SPECIALISTS, key) ? SPECIALISTS[key] : undefined;
	if (!specialist) {
		const available = Object.keys(SPECIALISTS).join(", ");
		const result1: ExecuteDelegateResult = { content: [{ type: "text" as const, text: `Unknown specialist: "${params.specialist}". Available: ${available}` }], details: {} }; return result1;
	}

	// Read-only specialists (no edit/write tools) don't need strict scope validation
	const isReadOnly = !specialist.tools.includes('edit') && !specialist.tools.includes('write');

	// Normalize specialist name for case-insensitive comparison downstream
	params = { ...params, specialist: specialist.name };

	// Resolve skills: override replaces defaults (issue #42)
	const resolvedSuggestedSkills = getSpecialistSkills(specialist.name, params.skills);

	const { signal } = params;

	// ── Resolve scope (pure) ──
	let scopeToUse: Scope | null = resolveScope(params, specialist, ctx.cwd);

	// Coder without scope → error
	if (params.specialist === "coder" && !scopeToUse) {
		const result2: ExecuteDelegateResult = {
			content: [{
				type: "text" as const,
				text: `⛔ **Scope required for coder.**

You must pass a \`scope\` parameter when calling coder.

\`\`\`
delegate("coder", "fix the auth middleware", {
    scope: {
        filesToModify: ["src/auth.ts"],
        filesToCreate: [],
        directories: ["src/"],
        maxFiles: 10
    }
})
\`\`\`

The scope tells the coder exactly which files it's allowed to touch.`
			}],
			details: {},
		}; return result2;
	}

	// ── Apply scope (side-effectful: gate check + write) ──
	const scopeResult = applyScope(scopeToUse, params.task, specialist.name, isReadOnly, ctx.cwd);
	if (!scopeResult.proceed) {
		const result: ExecuteDelegateResult = {
			content: [{ type: "text", text: `⚠️ Scope is vague. Orchestrator must clarify scope before delegating to ${specialist.name}.\n\nTask: ${params.task}\n\nPlease provide a clearer task description or explicit scope, then retry.` }],
			details: { specialist: specialist.name, task: params.task, status: "scope_vague", turns: 0 },
		};
		return result;
	}

	// ── Plan panel check ──
	const specName = specialist.name.charAt(0).toUpperCase() + specialist.name.slice(1);
	const stepLabel = `${specName}: ${params.task}`;

	if (!hasActivePlan(ctx)) {
		return {
			content: [{ type: "text", text: "No active plan. Call plan(goal, steps) first with a goal and step descriptions before delegating work." }],
			details: {},
		};
	}
	startDelegationStep(stepLabel, ctx);

	onUpdate?.({
		content: [{ type: "text", text: `${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} ${specialist.name}...` }],
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
		scopeViolations: 0,
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
	const parentCtx: SubagentContext = {
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		onAskOrchestrator: createAskOrchestratorResolver(ctx),
	};

	const result = await runSubagent(
		specialist, params.task, ctx.cwd,
		parentCtx,
		signal, wrappedOnUpdate, scopeToUse, orchestratorUi, resolvedSuggestedSkills,
		ctx, // orchestratorCtx: thread session context to plan-panel calls
	);
	const elapsedMs = Date.now() - startTime;

	// Dynamic status: subagent completed
	try {
		if (orchestratorUi) {
			orchestratorUi.setWorkingMessage('Sending to orchestrator...');
		}
	} catch {}

	// ── Check for errors/abort ──
	const isAborted = (signal?.aborted || false) || (result?.output?.startsWith("[aborted]") ?? false);
	let isError = !result || !result.output || result.output.startsWith("[error]") || result.output.startsWith("[aborted]");
	if (!isError && result?.stopReason === "error") {
		isError = true;
	}
	const hasError = isAborted || isError;

	// ── Handle diagnostics (capture + persist, no UI) ──
	const diagnostic = handleDiagnostics(result, specialist.name, params.task, ctx, metrics, startTime);

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

			result.output = processDelegateResult(
				result.output, metrics, elapsedMs,
				result.toolCallTrail || [], result.turns || 0,
				false, false,
			);
		} else if (result?.output) {
			// Error/abort path
			result.output = processDelegateResult(
				result.output, metrics, elapsedMs,
				result.toolCallTrail || [], result.turns ?? 0,
				isAborted, isError,
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
		new ScopeManager(ctx.cwd).clearScope();
		// Dynamic status: clear on completion
		try {
			if (orchestratorUi) {
				orchestratorUi.setWorkingMessage();
			}
		} catch {}
	}

	const result3: ExecuteDelegateResult = {
		content: [{ type: "text", text: result?.output || "[error] Subagent returned no output" }],
		details: {
			specialist: specialist.name,
			task: params.task,
			status: "done",
			turns: result?.turns || 0,
			outputLength: result?.output?.length || 0,
		},
	}; return result3;
}
