/**
 * Delegate controller — extracted execute logic from delegate-tool.ts.
 * Provides a standalone executeDelegate() function.
 */

import type { Specialist, DelegationMetrics, SubagentContext, Scope } from "./types.ts";
import { SPECIALISTS, getSpecialistSkills } from "./specialists.ts";
import { createAskOrchestratorResolver, resolve } from "./ask-resolver.ts";
import { runSubagent, type OrchestratorUi } from "./subagent-runner.ts";
import { hasActivePlan, setupPlanPanel, startDelegationStep, finalizePlanStep, errorPlanStep, incrementDelegationCount, decrementDelegationCount, clearPlanIfComplete } from "./plan-panel.ts";
import { debugLog } from "./debug.ts";
import { ScopeManager } from "./scope-manager.ts";
import { extractFindingsFromOutput, extractAuditFromOutput } from "./delegate-output-formatter.ts";
import { hidePeek, unregisterPeekFeed } from "./peek-overlay.ts";
import { SPINNER_FRAMES, getSpinnerIndex } from "./spinner-state.ts";

// Verb mapping for working loader messages during delegation lifecycle
const PRESENT_PARTICIPLE: Record<string, string> = {
	scout: 'Scouting',
	coder: 'Coding',
	reviewer: 'Reviewing',
	researcher: 'Researching',
	writer: 'Writing',
};

/** Default scope for writer specialist when no explicit scope is provided */
function getDefaultWriterScope(cwd: string): Scope {
    return {
        filesToModify: [],
        filesToCreate: [],
        directories: [cwd],
        maxFiles: 20,
        requiresApprovalBeyondScope: true,
        changeType: 'multi-file',
        maxLinesPerFile: 400,
        gateMode: 'strict',
        boundaries: `Doc-friendly default scope. You may create and modify:\n- *.md files in the current working directory\n- files under docs/ recursively\n- common documentation filenames such as README, AGENTS.md, CLAUDE.md, LICENSE, CONTRIBUTING.md, CHANGELOG.md, CODE_OF_CONDUCT.md, and SECURITY.md`,
    };
}

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
	ctx: any,
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

	// Normalize specialist name for case-insensitive comparison downstream
	params = { ...params, specialist: specialist.name };

	// Resolve skills: override replaces defaults (issue #42)
	const resolvedSkills = getSpecialistSkills(specialist.name, params.skills);

	const { signal } = params;

	// Normalize explicit orchestrator scope (no cache)
	let explicitScope: Scope | null = null;
	if (params.scope) {
		explicitScope = {
			...params.scope,
			filesToModify: params.scope.filesToModify ?? [],
			filesToCreate: params.scope.filesToCreate ?? [],
			directories: params.scope.directories ?? [],
			maxFiles: params.scope.maxFiles ?? 10,
			requiresApprovalBeyondScope: params.scope.requiresApprovalBeyondScope ?? true,
			changeType: params.scope.changeType ?? "multi-file",
			maxLinesPerFile: params.scope.maxLinesPerFile ?? 400,
			gateMode: params.scope.gateMode,
			boundaries: params.scope.boundaries,
		};
	}

	// Determine scope for this delegation (coder requires explicit scope, writer has doc-friendly defaults)
	let scopeToUse: Scope | null = null;
	if (params.specialist === "coder") {
		scopeToUse = explicitScope;
		if (!scopeToUse) {
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
	} else if (params.specialist === "writer") {
		scopeToUse = explicitScope ?? getDefaultWriterScope(ctx.cwd);
	} else {
		scopeToUse = explicitScope ?? null;
	}


	// AskResolver gate - check if scope is clear before delegating
	// If "ask", escalate to the orchestrator instead of asking the user
	if (scopeToUse !== undefined && scopeToUse !== null) {
		const gateResult = resolve(params.task, scopeToUse);
		if (gateResult === "ask") {
			throw new Error(
				`Scope is vague. Orchestrator must clarify scope before delegating. Task: ${params.task}`
			);
		}
	}

	// Write scope for scope-guard enforcement before delegation
	if (scopeToUse) {
		new ScopeManager(ctx.cwd).writeScope(scopeToUse);
	}

	// Set up plan panel — consume or append a step for each delegation
	const specName = specialist.name.charAt(0).toUpperCase() + specialist.name.slice(1);
	const stepLabel = `${specName}: ${params.task}`;

	if (!hasActivePlan()) {
		// Auto-create a 1-step plan from the delegation task (plan tool may have failed to register)
		const autoGoal = params.task;
		const autoSteps = [params.specialist + ": " + params.task];
		setupPlanPanel(autoGoal, autoSteps, ctx);
		startDelegationStep(stepLabel);
	} else {
		startDelegationStep(stepLabel);
	}

	onUpdate?.({
		content: [{ type: "text", text: `${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} ${specialist.name}...` }],
		details: { status: "running", specialist: specialist.name },
	});

	// Dynamic status: delegating
	const orchestratorUi: OrchestratorUi | undefined = ctx?.ui ? ctx.ui : undefined;
	const verb = PRESENT_PARTICIPLE[specialist.name] || 'Working';
	try {
		if (orchestratorUi) {
			orchestratorUi.setWorkingMessage(`Sending to ${specialist.name}...`);
		}
	} catch {}

	incrementDelegationCount();
	// Per-delegation metrics tracking
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

	const parentCtx: SubagentContext = {
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		onAskOrchestrator: createAskOrchestratorResolver(ctx),
	};

	const result = await runSubagent(
		specialist, params.task, ctx.cwd,
		parentCtx,
		signal, wrappedOnUpdate, scopeToUse, orchestratorUi, resolvedSkills,
	);
	const elapsedMs = Date.now() - startTime;

	// Dynamic status: subagent completed, sending result back
	try {
		if (orchestratorUi) {
			orchestratorUi.setWorkingMessage('Sending to orchestrator...');
		}
	} catch {}

	// === Check for errors/abort BEFORE any parsing ===
	const isAborted = (signal?.aborted || false) || (result?.output?.startsWith("[aborted]") ?? false);
	const isError = !result || !result.output || result.output.startsWith("[error]") || result.output.startsWith("[aborted]");
	const hasError = isAborted || isError;

	try {
		// Only do analysis if no error
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

			const findings = extractFindingsFromOutput(result.output);
			if (findings && findings.summary) {
				const summaryParts = [`[Findings: ${findings.summary}]`];
				if (findings.key_files.length > 0) summaryParts.push(`Files: ${findings.key_files.join(', ')}`);
				if (findings.issues.length > 0 && findings.issues[0] !== 'none') summaryParts.push(`Issues: ${findings.issues.join('; ')}`);
				if (findings.recommendation) summaryParts.push(`Next: ${findings.recommendation}`);
				result.output = summaryParts.join('\n') + '\n\n' + result.output;
			}

			// Prepend execution metadata for orchestrator visibility
			const execStatus = result.output?.startsWith("[error]") ? "error" : "ok";
			const execMeta = [`[Execution: elapsed=${(elapsedMs / 1000).toFixed(1)}s, turns=${result.turns || 0}, status=${execStatus}]`];
			if (execStatus === "error") {
				execMeta.push(`[Error: ${result.output.slice(0, 200)}]`);
			}
			result.output = execMeta.join('\n') + '\n\n' + result.output;

			// Prepend tool call trail for orchestrator visibility
			if (result.toolCallTrail && result.toolCallTrail.length > 0) {
				const trail = result.toolCallTrail.map(t =>
					`${t.completed ? '✓' : '⚠'} ${t.tool}${t.outputPreview ? ` → ${t.outputPreview}` : ''}`
				).join('\n');
				result.output = `[Tool Calls (${result.toolCallTrail.length}):
${trail}
]

` + result.output;
			}

			// Extract audit trail
			const audit = extractAuditFromOutput(result.output);
			if (audit) {
				const auditParts = [];
				if (audit.problems.length > 0 && audit.problems[0] !== 'none') {
					auditParts.push(`Problems: ${audit.problems.join('; ')}`);
					auditParts.push(`Resolution: ${audit.resolution.join('; ')}`);
				}
				if (!audit.scope_stayed) {
					auditParts.push(`Scope deviation: ${audit.scope_notes}`);
					metrics.scopeViolations++;
				}
				if (auditParts.length > 0) {
					result.output = `[Audit: ${auditParts.join(' | ')}]\n` + result.output;
				}
			}

			// Prepend metrics line
			const metricsLine = `[Metrics: read=${metrics.readCalls}, grep=${metrics.grepCalls}, find=${metrics.findCalls}, edit=${metrics.editCalls}, write=${metrics.writeCalls}, bash=${metrics.bashCalls}, ls=${metrics.lsCalls}, scopeViolations=${metrics.scopeViolations}]`;
			result.output = metricsLine + '\n' + result.output;

			// Build status note — first line of returned text so orchestrator sees outcome at a glance
			const turns = result.turns || 0;
			const toolCalls = result.toolCallTrail?.length || 0;
			const turnWord = turns === 1 ? "turn" : "turns";
			const toolWord = toolCalls === 1 ? "tool call" : "tool calls";
			const statusNote = `✓ Completed (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;
			result.output = `${statusNote}\n${result.output}`;
		} else if (result?.output) {
			// Error/Abort path: include tool call trail + status note
			const trail = result.toolCallTrail;
			const turns = result.turns ?? 0;
			const toolCalls = trail?.length ?? 0;
			const turnWord = turns === 1 ? "turn" : "turns";
			const toolWord = toolCalls === 1 ? "tool call" : "tool calls";

			let trailStr = "";
			if (trail && trail.length > 0) {
				trailStr = "\nCompleted tool calls:\n" + trail.map(t => `${t.completed ? '✓' : '⚠'} ${t.tool}`).join("\n");
			}

			const statusNote = isAborted
				? `■ Aborted — interrupted by user (${turns} ${turnWord}, ${toolCalls} ${toolWord})`
				: `✗ Error (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;

			result.output = `${statusNote}${trailStr}\n\n${result.output}`;
		}

		// Mark plan step — now always runs correctly
		if (hasError) {
			errorPlanStep(ctx, isAborted);
		} else {
			finalizePlanStep(ctx);
		}
	} finally {
		decrementDelegationCount();
		clearPlanIfComplete(ctx);  // Clear widget if all steps done (count is now 0)
		hidePeek();
		unregisterPeekFeed();
		// Clear scope after delegation completes
		new ScopeManager(ctx.cwd).clearScope();
		// Dynamic status: clear on completion (even if extraction/parsing throws)
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
