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
import type { Scope } from "./types.ts";
export { createAskOrchestratorResolver } from "./ask-resolver.ts";
import { SPINNER_FRAMES, getSpinnerIndex } from "./spinner-state.ts";
import { Text } from "@earendil-works/pi-tui";
import { executeDelegate } from "./delegate-controller.ts";






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
			return executeDelegate(
				{ specialist: params.specialist, task: params.task, scope: params.scope, signal },
				ctx,
				onUpdate,
			);
		},
	});
}
