/**
 * Delegate tool registration — the primary tool orchestrator agents use.
 * Extracted from orchestrator.ts during refactoring.
 *
 * Registers the `delegate(specialist, task)` tool with:
 * - renderCall: shows "delegate SpecialistName: task" inline
 * - renderResult: shows live spinner during execution, ✓ done after
 * - execute: calls runSubagent(), updates plan panel
 */

import { Type } from "typebox";
import { shortenLabel } from "../token-saver.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Specialist } from "./types.ts";
import { SPECIALISTS } from "./specialists.ts";
import { runSubagent, type OrchestratorUi } from "./subagent-runner.ts";
import { createOrchestratorActivity, addOrchestratorStep, completeOrchestratorStep } from "./activity-feed.ts";
import { hasActivePlan, setupPlanPanel, startDelegationStep, completePlanStep, errorPlanStep, incrementDelegationCount, decrementDelegationCount } from "./plan-panel.ts";
import type { Scope } from "./types.ts";
import { debugLog } from "./debug.ts";
import { hidePeek, unregisterPeekFeed } from "./peek-overlay.ts";
import { SPINNER_FRAMES, getSpinnerIndex } from "./spinner-state.ts";

// Shared spinner — imported from spinner-state.ts
let _orchestratorActivity: ReturnType<typeof createOrchestratorActivity> | null = null;

// Verb mapping for working loader messages during delegation lifecycle
const PRESENT_PARTICIPLE: Record<string, string> = {
	scout: 'Scouting',
	coder: 'Coding',
	reviewer: 'Reviewing',
	researcher: 'Researching',
	writer: 'Writing',
};

// Scope caching: after a scout/researcher outputs scope info, store it for the next coder call
let _cachedScope: Scope | null = null;

function extractFindingsFromOutput(output: string): { summary: string; key_files: string[]; issues: string[]; recommendation: string } | null {
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
        return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };
    return {
        summary: extract('summary') || '',
        key_files: extractList('key_files'),
        issues: extractList('issues'),
        recommendation: extract('recommendation') || '',
    };
}

function extractAuditFromOutput(output: string): { problems: string[]; resolution: string[]; scope_stayed: boolean; scope_notes: string } | null {
    const auditMatch = output.match(/##\s+Audit\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
    if (!auditMatch) return null;
    const block = auditMatch[1];
    const extractList = (key: string): string[] => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*\\[?(.+?)\\]?\\s*$`, 'im'));
        if (!m) return [];
        return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };
    const extract = (key: string): string => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*(.+)`, 'i'));
        return m ? m[1].trim() : '';
    };
    const scopeStayed = extract('scope_stayed').toLowerCase();
    return {
        problems: extractList('problems'),
        resolution: extractList('resolution'),
        scope_stayed: scopeStayed === 'yes' || scopeStayed === 'true',
        scope_notes: extract('scope_notes') || '',
    };
}

/**
 * Register the delegate tool on the pi extension API.
 */
export function registerDelegateTool(pi: ExtensionAPI): void {
	// Clear scope cache on session reset so new conversations start fresh
	pi.on("before_agent_start", () => {
		_cachedScope = null;
	});

	pi.registerTool({
		name: "delegate",
		label: "delegate",
		description: "Delegate work to a specialist subagent. Provides specialist name and task.",
		parameters: Type.Object({
			specialist: Type.String({
				description: "Specialist: scout, coder, reviewer, researcher, writer",
			}),
			task: Type.String({
				description: "Task description for the specialist to execute",
			}),
			scope: Type.Optional(Type.Object({
				filesToModify: Type.Array(Type.String(), {
					description: "Existing files the specialist may modify",
				}),
				filesToCreate: Type.Array(Type.String(), {
					description: "New files the specialist may create",
				}),
				boundaries: Type.Optional(Type.String({
					description: "Free-text scope boundaries the specialist must respect",
				})),
			}, {
				description: "Structured scope constraints. REQUIRED when specialist=coder. Get this from scout's ## Scope output or declare it yourself based on your analysis.",
			})),
		}),

		// ── Render: what shows when tool is invoked ──
		renderCall(args: any, theme: any, context: any) {
			const comp = context.lastComponent ?? new (require("@earendil-works/pi-tui").Text)("", 0, 0);
			const name = (args.specialist || "").charAt(0).toUpperCase() + (args.specialist || "").slice(1);
			const task = args.task ? args.task.slice(0, 60) : "";
			const content = theme.fg("toolTitle", theme.bold(`delegate ${name}`)) +
				(task ? theme.fg("dim", `: ${task}`) : "");
			comp.setText(content);
			return comp;
		},

		// ── Render: what shows during/after execution ──
		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			const state = context.state as any;
			const details = result.details as any;
			const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";

			if (isPartial && !state.interval) {
					state.interval = setInterval(() => {
						getSpinnerIndex(); // tick shared spinner
						context.invalidate();
					}, 80);
			}
			if (!isPartial && state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}

			const comp = context.lastComponent ?? new (require("@earendil-works/pi-tui").Text)("", 0, 0);

			if (isPartial) {
				if (text) state.lastFeedText = text;
				comp.setText(text
					? theme.fg("warning", text)
					: theme.fg("warning", `${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} working...`));
			} else {
				const feedText = state.lastFeedText || text || "✓ done";
				comp.setText(theme.fg("success", feedText));
			}

			return comp;
		},

		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			if (!params.specialist || !params.task) {
				return { content: [{ type: "text" as const, text: "Provide specialist+task" }], details: {} } as any;
			}

			// === SCOPE VALIDATION: require scope for coder ===
			if (params.specialist === "coder") {
				if (!params.scope || (!params.scope.filesToModify?.length && !params.scope.filesToCreate?.length)) {
					return {
						content: [{
							type: "text" as const,
							text: `⛔ **Scope required for coder.**

You must pass a \`scope\` parameter when calling coder. Get this from scout's output or declare it yourself.

\`\`\`
delegate("coder", "fix the auth middleware", {
    scope: {
        filesToModify: ["src/auth.ts"],
        filesToCreate: []
    }
})
\`\`\`

The scope tells the coder exactly which files it's allowed to touch.`
						}],
						details: {},
					} as any;
				}
				// Use scope from params — no text parsing needed
				_cachedScope = params.scope;
			}

			const specialist: Specialist | undefined = SPECIALISTS[params.specialist];
			if (!specialist) {
				const available = Object.keys(SPECIALISTS).join(", ");
				return { content: [{ type: "text" as const, text: `Unknown specialist: "${params.specialist}". Available: ${available}` }], details: {} } as any;
			}

			// Set up plan panel — consume or append a step for each delegation
			const specName = specialist.name.charAt(0).toUpperCase() + specialist.name.slice(1);
			const stepLabel = `${specName}: ${shortenLabel(params.task)}`;

			if (!hasActivePlan()) {
				// Auto-create a 1-step plan from the delegation task (plan tool may have failed to register)
				const autoGoal = params.task.length > 80 ? params.task.slice(0, 77) + "..." : params.task;
				const autoSteps = [params.specialist + ": " + (params.task.length > 60 ? params.task.slice(0, 57) + "..." : params.task)];
				setupPlanPanel(autoGoal, autoSteps, ctx);
				startDelegationStep(stepLabel);
			} else {
				startDelegationStep(stepLabel);
			}

			onUpdate?.({
				content: [{ type: "text", text: `${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} ${specialist.name}...` }],
				details: { status: "running", specialist: specialist.name },
			});

			// Determine scope: for coder, use cached scope from previous subagent output
			const scopeToUse = params.specialist === "coder" ? _cachedScope : null;

			// Dynamic status: delegating
			const orchestratorUi: OrchestratorUi | undefined = ctx?.ui ? ctx.ui : undefined;
			const verb = PRESENT_PARTICIPLE[specialist.name] || 'Working';
			try {
				if (orchestratorUi) {
					orchestratorUi.setWorkingMessage(`Sending to ${specialist.name}...`);
				}
			} catch {}

			const stepName = specialist.name + ": " + params.task.substring(0, 60);
			_orchestratorActivity = createOrchestratorActivity(stepName);
			incrementDelegationCount();
			const startTime = Date.now();

			// Dynamic status: subagent session starting
			try {
				if (orchestratorUi) {
					orchestratorUi.setWorkingMessage(`${verb}...`);
				}
			} catch {}

			const result = await runSubagent(
				specialist, params.task, ctx.cwd,
				{ modelRegistry: ctx.modelRegistry, model: ctx.model },
				signal, onUpdate, _orchestratorActivity ?? undefined, scopeToUse, orchestratorUi,
			);
			const elapsedMs = Date.now() - startTime;

			// Dynamic status: subagent completed, sending result back
			try {
				if (orchestratorUi) {
					orchestratorUi.setWorkingMessage('Sending to orchestrator...');
				}
			} catch {}

			// === Check for errors/abort BEFORE any parsing ===
			const isAborted = signal?.aborted || false;
			const isError = !result || !result.output || result.output.startsWith("[error]");
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
						}
						if (auditParts.length > 0) {
							result.output = `[Audit: ${auditParts.join(' | ')}]\n` + result.output;
						}
					}

					// Build status note — first line of returned text so orchestrator sees outcome at a glance
					const turns = result.turns || 0;
					const toolCalls = result.toolCallTrail?.length || 0;
					const outcomeStatus = result.output?.startsWith("[error]") ? "error" : "ok";
					const aborted = signal?.aborted || false;
					const turnWord = turns === 1 ? "turn" : "turns";
					const toolWord = toolCalls === 1 ? "tool call" : "tool calls";
					let statusNote = "";
					if (outcomeStatus === "error") {
						statusNote = `✗ Error (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;
					} else if (aborted) {
						statusNote = `■ Aborted (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;
					} else {
						statusNote = `✓ Completed (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;
					}
					result.output = `${statusNote}\n${result.output}`;
				}

				// Mark plan step — now always runs correctly
				if (hasError) {
					errorPlanStep(ctx);
				} else {
					completePlanStep(ctx);
				}
			} finally {
				completeOrchestratorStep(_orchestratorActivity);
				decrementDelegationCount();
				_orchestratorActivity = null;
				hidePeek();
				unregisterPeekFeed();
				// Dynamic status: clear on completion (even if extraction/parsing throws)
				try {
					if (orchestratorUi) {
						orchestratorUi.setWorkingMessage();
					}
				} catch {}
			}

			return {
				content: [{ type: "text", text: result?.output || "[error] Subagent returned no output" }],
				details: {
					specialist: specialist.name,
					task: params.task,
					status: "done",
					turns: result?.turns || 0,
					outputLength: result?.output?.length || 0,
				},
			};
		},
	});
}
