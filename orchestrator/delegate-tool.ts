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
import { runSubagent } from "./subagent-runner.ts";
import { createOrchestratorActivity } from "./activity-feed.ts";
import { hasActivePlan, setupPlanPanel, startDelegationStep, completePlanStep, errorPlanStep } from "./plan-panel.ts";
import type { Scope } from "./types.ts";
import { debugLog } from "./debug.ts";

// Local spinner state for renderResult animation
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spinnerIndex = 0;
let _orchestratorActivity: ReturnType<typeof createOrchestratorActivity> | null = null;

// Scope caching: after a scout/researcher outputs scope info, store it for the next coder call
let _cachedScope: Scope | null = null;

/**
 * Parse subagent output for structured scope information.
 * Looks for:
 *   ## Scope
 *   {"filesToModify": [...], "filesToCreate": [...]}
 *
 * Returns Scope object if found, null otherwise.
 */
function extractScopeFromOutput(output: string): Scope | null {
	// Try JSON block first: look for ```json ... ``` or standalone JSON object
	const jsonMatch = output.match(/```(?:json)?\s*(\{[\s\S]*?(?:"filesToModify"|"filesToCreate")[\s\S]*?\})/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			if (parsed.filesToModify !== undefined || parsed.filesToCreate !== undefined) {
				const filesToModify: string[] = parsed.filesToModify || [];
				const filesToCreate: string[] = parsed.filesToCreate || [];
				const extractedScope = {
					filesToModify,
					filesToCreate,
					changeType: (filesToModify.length + filesToCreate.length) <= 1 ? "single-file" : "multi-file",
					maxLinesPerFile: parsed.maxLinesPerFile || 400,
				};
				debugLog("extractScopeFromOutput: scope extracted successfully", extractedScope);
				return extractedScope;
			}
		} catch (e) {
			debugLog("extractScopeFromOutput: JSON.parse failed", { error: String(e), input: jsonMatch[1]?.slice(0, 200) });
		}
	}
	debugLog("extractScopeFromOutput: JSON parser failed or no JSON scope found");

	// Try ## Scope section with simple key: value format
	const scopeSection = output.match(/## Scope\n([\s\S]*?)(?:\n##|$)/);
	if (scopeSection) {
		const section = scopeSection[1];
		const filesToModify: string[] = [];
		const filesToCreate: string[] = [];
		let maxLinesPerFile = 400;

		// Parse filesToModify line
		const modifyMatch = section.match(/-?\s*\*{0,2}filesToModify\*{0,2}:\s*\[([^\]]*)\]/);
		const foundModifyKey = !!modifyMatch;
		if (modifyMatch && modifyMatch[1].trim()) {
			filesToModify.push(...modifyMatch[1].split(",").map((s: string) => s.trim().replace(/^["'`]|["'`]$/g, "")));
		}

		// Parse filesToCreate line
		const createMatch = section.match(/-?\s*\*{0,2}filesToCreate\*{0,2}:\s*\[([^\]]*)\]/);
		const foundCreateKey = !!createMatch;
		if (createMatch && createMatch[1].trim()) {
			filesToCreate.push(...createMatch[1].split(",").map((s: string) => s.trim().replace(/^["'`]|["'`]$/g, "")));
		}

		// Parse maxLinesPerFile
		const linesMatch = section.match(/-?\s*maxLinesPerFile:\s*(\d+)/);
		if (linesMatch) {
			maxLinesPerFile = parseInt(linesMatch[1], 10);
		}

		if (foundModifyKey || foundCreateKey) {
			const extractedScope = {
				filesToModify,
				filesToCreate,
				changeType: (filesToModify.length + filesToCreate.length) <= 1 ? "single-file" : "multi-file",
				maxLinesPerFile,
			};
			debugLog("extractScopeFromOutput: scope extracted successfully", extractedScope);
			return extractedScope;
		}
		debugLog("extractScopeFromOutput: ## Scope section found but failed to parse files lists", { section });
	}

	debugLog("extractScopeFromOutput: no scope found in output");
	return null;
}

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
					_spinnerIndex++;
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
					: theme.fg("warning", `${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} working...`));
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

			// === ADAPTIVE GATING: block coder without prior scope ===
			if (params.specialist === "coder" && !_cachedScope) {
				return {
					content: [{
						type: "text" as const,
						text: `⛔ **Scope required before coding.**

No structured scope was found. This means either:
1. \`delegate(scout, ...)\` was not called first, or
2. Scout ran but its scope output couldn't be parsed (check debug logs at /tmp/pi-debug/)

The scout must output a \`## Scope\` section with \`filesToModify\` or \`filesToCreate\` arrays.

\`\`\`
delegate(scout, "analyze the auth system")
// scout must output:
// ## Scope
// - filesToModify: ["src/auth.ts"]
delegate(coder, "fix the token expiry")
\`\`\``
					}],
					details: {},
				} as any;
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
				_orchestratorActivity = createOrchestratorActivity();
				setupPlanPanel(shortenLabel(params.task), [stepLabel], ctx);
			} else {
				startDelegationStep(stepLabel);
			}

			onUpdate?.({
				content: [{ type: "text", text: `${SPINNER_FRAMES[_spinnerIndex % SPINNER_FRAMES.length]} ${specialist.name}...` }],
				details: { status: "running", specialist: specialist.name },
			});

			// Determine scope: for coder, use cached scope from previous subagent output
			const scopeToUse = params.specialist === "coder" ? _cachedScope : null;

			const result = await runSubagent(
				specialist,
				params.task,
				ctx.cwd,
				{ modelRegistry: ctx.modelRegistry, model: ctx.model },
				signal,
				onUpdate,
				_orchestratorActivity ?? undefined,
				scopeToUse,
			);

			// After ANY subagent completes, try to extract scope from its output
			// This allows scout → scope → coder flow: scout outputs ## Scope, system captures it
			if (result.output) {
				const extractedScope = extractScopeFromOutput(result.output);
				if (extractedScope) {
					_cachedScope = extractedScope;
				} else if (params.specialist === "scout") {
					// Scout ran but scope extraction failed — warn user
					debugLog("delegate-tool: scope extraction failed after scout run", { output: result.output?.slice(0, 500) });
					// Don't block here — let the coder gate handle it with a better message
				}
			}

			const findings = extractFindingsFromOutput(result.output);
			if (findings && findings.summary) {
				const summaryParts = [`[Findings: ${findings.summary}]`];
				if (findings.key_files.length > 0) summaryParts.push(`Files: ${findings.key_files.join(', ')}`);
				if (findings.issues.length > 0 && findings.issues[0] !== 'none') summaryParts.push(`Issues: ${findings.issues.join('; ')}`);
				if (findings.recommendation) summaryParts.push(`Next: ${findings.recommendation}`);
				result.output = summaryParts.join('\n') + '\n\n' + result.output;
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

			// NOTE: scope stays cached after coder runs (not cleared) so user can
			// re-iterate on same files without re-calling scout.
			// Scope is cleared on session reset (before_agent_start).

			if (result.output?.startsWith("[error]")) {
				errorPlanStep(ctx);
			} else {
				completePlanStep(ctx);
			}

			return {
				content: [{ type: "text", text: result.output }],
				details: {
					specialist: specialist.name,
					task: params.task,
					status: "done",
					turns: result.turns,
					outputLength: result.output.length,
				},
			};
		},
	});
}
