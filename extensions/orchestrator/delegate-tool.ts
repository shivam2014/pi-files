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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Specialist, DelegationMetrics, SubagentContext } from "./types.ts";
import { SPECIALISTS } from "./specialists.ts";
import { createAskOrchestratorResolver } from "./ask-resolver.ts";

export { createAskOrchestratorResolver };
import { runSubagent, type OrchestratorUi } from "./subagent-runner.ts";

import { hasActivePlan, setupPlanPanel, startDelegationStep, finalizePlanStep, errorPlanStep, incrementDelegationCount, decrementDelegationCount, clearPlanIfComplete } from "./plan-panel.ts";
import type { Scope } from "./types.ts";
import { debugLog } from "./debug.ts";
import { ScopeManager } from "./scope-manager.ts";
import { extractFindingsFromOutput, extractAuditFromOutput } from "./delegate-output-formatter.ts";
import { hidePeek, unregisterPeekFeed } from "./peek-overlay.ts";
import { SPINNER_FRAMES, getSpinnerIndex } from "./spinner-state.ts";
import { Text } from "@earendil-works/pi-tui";

// Shared spinner — imported from spinner-state.ts
// (orchestratorActivity is now a local variable in execute())

// Verb mapping for working loader messages during delegation lifecycle
const PRESENT_PARTICIPLE: Record<string, string> = {
	scout: 'Scouting',
	coder: 'Coding',
	reviewer: 'Reviewing',
	researcher: 'Researching',
	writer: 'Writing',
};



/**
 * Parse a `## Scope` block from scout/researcher subagent output into the
 * canonical `Scope` type. Returns `null` if the block is missing or malformed.
 */
export function extractScopeFromOutput(output: string): Scope | null {
    const scopeMatch = output.match(/##\s+Scope\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
    if (!scopeMatch) return null;
    const block = scopeMatch[1];

    const entries: Record<string, unknown> = {};
    const lineRe = /^\s*[-*]\s*(\w+)\s*:\s*(.*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(block)) !== null) {
        const key = m[1];
        const raw = m[2].trim();
        if (raw.startsWith('[') && raw.endsWith(']')) {
            const inner = raw.slice(1, -1).trim();
            entries[key] = inner ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
        } else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
            entries[key] = raw.slice(1, -1);
        } else if (/^\d+$/.test(raw)) {
            entries[key] = parseInt(raw, 10);
        } else if (raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes') {
            entries[key] = true;
        } else if (raw.toLowerCase() === 'false' || raw.toLowerCase() === 'no') {
            entries[key] = false;
        } else {
            entries[key] = raw;
        }
    }

    const scopeKeys = ['filesToModify', 'filesToCreate', 'directories', 'changeType', 'maxLinesPerFile', 'maxFiles', 'requiresApprovalBeyondScope', 'gateMode'];
    if (!scopeKeys.some(k => k in entries)) return null;

    const changeType = entries.changeType === 'single-file' ? 'single-file' : 'multi-file';
    const scope: Scope = {
        filesToModify: Array.isArray(entries.filesToModify) ? entries.filesToModify as string[] : [],
        filesToCreate: Array.isArray(entries.filesToCreate) ? entries.filesToCreate as string[] : [],
        directories: Array.isArray(entries.directories) ? entries.directories as string[] : [],
        maxFiles: typeof entries.maxFiles === 'number' ? entries.maxFiles : 10,
        requiresApprovalBeyondScope: typeof entries.requiresApprovalBeyondScope === 'boolean' ? entries.requiresApprovalBeyondScope : true,
        changeType,
        maxLinesPerFile: typeof entries.maxLinesPerFile === 'number' ? entries.maxLinesPerFile : 400,
        gateMode: entries.gateMode === 'relaxed' || entries.gateMode === 'strict'
            ? entries.gateMode
            : (changeType === 'single-file' ? 'relaxed' : 'strict'),
    };
    return scope;
}

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


/**
 * Register the delegate tool on the pi extension API.
 */
export function registerDelegateTool(pi: ExtensionAPI): void {
	// Scope is now managed by ScopeManager on per-delegation basis — no module-level cache

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
				directories: Type.Optional(Type.Array(Type.String(), {
					description: "Directory-level scope boundaries",
				})),
				maxFiles: Type.Optional(Type.Number({
					description: "Max files allowed across all directories",
				})),
				requiresApprovalBeyondScope: Type.Optional(Type.Boolean({
					description: "If true, user must approve scope deviations",
				})),
				boundaries: Type.Optional(Type.String({
					description: "Free-text scope boundaries the specialist must respect",
				})),
			}, {
				description: "Structured scope constraints. REQUIRED when specialist=coder. Get this from scout's ## Scope output or declare it yourself based on your analysis.",
			})),
		}),

		// ── Render: what shows when tool is invoked ──
		renderCall(args: any, theme: any, context: any) {
			// Store args so renderResult can show the delegate header exactly once.
			// Rendering the header here would duplicate it with the result feed.
			const state = context.state || (context.state = {});
			state.delegateArgs = { specialist: args.specialist, task: args.task };

			const comp = context.lastComponent ?? new Text("", 0, 0);
			comp.setText("");
			return comp;
		},

		// ── Render: what shows during/after execution ──
		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			const state = context.state as any;
			const details = result.details as any;
			const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";

			if (isPartial && !state.interval) {
					context.invalidate(); // first paint so spinner shows before ✓
					state.interval = setInterval(() => {
						getSpinnerIndex(); // tick shared spinner
						context.invalidate();
					}, 80);
			}
			if (!isPartial && state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}

			const comp = context.lastComponent ?? new Text("", 0, 0);

			const delegateArgs = state.delegateArgs || {};
			const rawName = delegateArgs.specialist || details?.specialist || "";
			const rawTask = delegateArgs.task || details?.task || "";
			const name = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : "";
			const task = rawTask ? rawTask.slice(0, 60) : "";
			const prefix = name
				? theme.fg("toolTitle", theme.bold(`delegate ${name}`)) +
				  (task ? theme.fg("dim", `: ${task}`) : "")
				: "";

			if (isPartial) {
				if (text) state.lastFeedText = text;
				const feedText = text
					? theme.fg("warning", text)
					: theme.fg("warning", `${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} working...`);
				comp.setText(prefix ? `${prefix}\n${feedText}` : feedText);
			} else {
				const feedText = state.lastFeedText || text || "✓ done";
				comp.setText(prefix ? `${prefix}\n${theme.fg("success", feedText)}` : theme.fg("success", feedText));
			}

			return comp;
		},

		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			if (!params.specialist || !params.task) {
				return { content: [{ type: "text" as const, text: "Provide specialist+task" }], details: {} } as any;
			}

				const specialist: Specialist | undefined = SPECIALISTS[params.specialist];
			if (!specialist) {
				const available = Object.keys(SPECIALISTS).join(", ");
				return { content: [{ type: "text" as const, text: `Unknown specialist: "${params.specialist}". Available: ${available}` }], details: {} } as any;
			}

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
					return {
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
					} as any;
				}
			} else if (params.specialist === "writer") {
				scopeToUse = explicitScope ?? getDefaultWriterScope(ctx.cwd);
			} else {
				scopeToUse = explicitScope ?? null;
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
				signal, wrappedOnUpdate, scopeToUse, orchestratorUi,
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
