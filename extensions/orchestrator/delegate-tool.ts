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
export { createAskOrchestratorResolver } from "./ask-resolver.ts";
import { SPINNER_FRAMES, currentFrame } from "./spinner-state.ts";
import { registerChannel, unregisterChannel } from "./render-scheduler.ts";
import { statusIcon, getTheme, formatTokens, formatDuration } from "./orchestrator-theme.ts";

import { Text } from "@earendil-works/pi-tui";
import { executeDelegate } from "./delegate-controller.ts";

/** Monotonic id source for render-scheduler channel keys (one per delegation). */
let _delegateChannelSeq = 0;

/**
 * Register the delegate tool on the pi extension API.
 */
export function registerDelegateTool(pi: ExtensionAPI): void {
	// Scope is now managed by ScopeManager on per-delegation basis — no module-level cache

	pi.registerTool({
		name: "delegate",
		label: "delegate",
		description: "Delegate work to a specialist subagent. Provides specialist name and task. When batch is provided, runs multiple delegations concurrently. Use for independent tasks only.",
		parameters: Type.Object({
			specialist: Type.Optional(Type.String({
				description: "Specialist: scout, coder, reviewer, researcher, writer. Required when batch is not provided.",
			})),
			task: Type.Optional(Type.String({
				description: "Task description for the specialist to execute. Required when batch is not provided.",
			})),
			label: Type.Optional(Type.String({
				description: "Optional short human-readable summary for the plan step label (e.g. 'Health-check orchestrator'). Omit and the framework derives a semantic label from the task.",
			})),
			skills: Type.Optional(Type.Array(Type.String(), {
				description: "Additional skill pack(s) for this delegation (e.g. ['tdd', 'review']). Merges (union) with the specialist's default skills — does not replace them.",
			})),
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
				changeType: Type.Optional(Type.String({
					description: "Type of change: single-file or multi-file",
				})),
				maxLinesPerFile: Type.Optional(Type.Number({
					description: "Max lines per file the specialist may create/modify",
				})),
				boundaries: Type.Optional(Type.String({
					description: "Free-text scope boundaries the specialist must respect",
				})),
			}, {
				description: "Structured scope constraints. REQUIRED when specialist=coder. Get this from scout's ## Scope output or declare it yourself based on your analysis.",
			})),
			batch: Type.Optional(Type.Array(Type.Object({
				specialist: Type.String({ description: "Specialist name for this batch entry" }),
				task: Type.String({ description: "Task description for this batch entry" }),
				label: Type.Optional(Type.String({ description: "Optional short human-readable summary for this entry's plan step label" })),
				skills: Type.Optional(Type.Array(Type.String())),
				scope: Type.Optional(Type.Object({
					filesToModify: Type.Array(Type.String()),
					filesToCreate: Type.Array(Type.String()),
					directories: Type.Optional(Type.Array(Type.String())),
					maxFiles: Type.Optional(Type.Number()),
					requiresApprovalBeyondScope: Type.Optional(Type.Boolean()),
					changeType: Type.Optional(Type.String()),
					maxLinesPerFile: Type.Optional(Type.Number()),
					boundaries: Type.Optional(Type.String()),
				})),
			}), {
				description: "Run multiple delegations concurrently. Each entry has specialist + task. Use for independent tasks only.",
			})),
		}),

		promptGuidelines: [
			"PREREQUISITE: plan() must be called before delegate(). delegate() rejects if no active plan exists.",
			"Single: delegate({ specialist: 'coder', task: 'fix auth', scope: { filesToModify: ['src/auth.ts'] } })",
			"Batch: delegate({ batch: [{ specialist: 'scout', task: 'investigate auth' }, { specialist: 'scout', task: 'investigate db' }] })",
			"Spawns a subagent specialist to do the work",
			"Scope required for coder, writer — optional for scout, researcher, reviewer",
			"Optional skills: delegate({ specialist: 'coder', task: '...', skills: ['tdd'] })",
			"Optional label: delegate({ specialist: 'coder', task: '...', label: 'Health-check orchestrator' })",
			"Prefer calling plan() first with 5-10 word steps; label only controls the auto-created step when no plan exists",
			"Batch runs concurrent delegations — independent tasks only",
            "Output: Returns specialist output with findings, audit trail, and completion status; may include partial streaming updates during execution",
		],

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

		// Dedup: skip if content text unchanged since last render
		if (text && text === state.lastRenderedText && isPartial) return context.lastComponent ?? new Text("", 0, 0);
		if (text) state.lastRenderedText = text;

			if (isPartial && !state.renderChannel) {
				context.invalidate(); // first paint so spinner shows before ✓
				// Route the 80 ms spinner driver through the shared render
				// scheduler so it coalesces with other active drivers instead of
				// arming its own independent interval.
				const channelKey = `delegate:${++_delegateChannelSeq}`;
				state.renderChannel = channelKey;
				registerChannel(channelKey, () => {
					context.invalidate();
				});
			}
			if (!isPartial && state.renderChannel) {
				unregisterChannel(state.renderChannel);
				state.renderChannel = undefined;
			}

			const comp = context.lastComponent ?? new Text("", 0, 0);

			const delegateArgs = state.delegateArgs || {};
			const rawName = delegateArgs.specialist || details?.specialist || "";
			const rawTask = delegateArgs.task || details?.task || "";
			const name = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : "";
			const task = rawTask ? rawTask.slice(0, 60) : "";
			const modelBadge = details?.model
				? theme.fg("dim", ` [${details.model}]`)
				: "";
			const prefix = name
				? theme.fg("toolTitle", theme.bold(`delegate ${name}`)) +
				  modelBadge
				: "";

			if (isPartial) {
				if (text) state.lastFeedText = text;
				const feedText = text
					? theme.fg("warning", text)
					: statusIcon("running") + " working...";
				const inTokens = details?.tokenInput ? `↑${formatTokens(details.tokenInput)}` : "";
				const outTokens = details?.tokenOutput ? `↓${formatTokens(details.tokenOutput)}` : "";
				const cacheTokens = details?.tokenCached ? `⇄${formatTokens(details.tokenCached)}` : "";
				const liveTokens = [inTokens, outTokens, cacheTokens].filter(Boolean).join(" ");
				const liveElapsed = details?.elapsedMs ? formatDuration(details.elapsedMs) : (details?.elapsed ? formatDuration(details.elapsed) : "");
				const liveSuffix = [liveTokens, liveElapsed].filter(Boolean).join(" ");
				const displayLiveSuffix = liveSuffix ? ` ${theme.fg("dim", liveSuffix)}` : "";
				comp.setText(prefix ? `${prefix}\n${feedText}${displayLiveSuffix}` : `${feedText}${displayLiveSuffix}`);
			} else {
				// Build suffix with token and elapsed info
				const tokenParts: string[] = [];
				if (details?.tokenUsage?.input) tokenParts.push(`↑${formatTokens(details.tokenUsage.input)}`);
				if (details?.tokenUsage?.cached) tokenParts.push(`⇄${formatTokens(details.tokenUsage.cached)}`);
				if (details?.tokenUsage?.output) tokenParts.push(`↓${formatTokens(details.tokenUsage.output)}`);
				const elapsed = details?.elapsedMs ? formatDuration(details.elapsedMs) : "";
				const suffix = [...tokenParts, elapsed].filter(Boolean).join(" ");
				const displaySuffix = suffix ? ` ${theme.fg("dim", suffix)}` : "";

				const feedText = state.lastFeedText || text || (statusIcon("completed") + " done" + displaySuffix);
				comp.setText(prefix ? `${prefix}\n${theme.fg("success", feedText)}` : theme.fg("success", feedText));
			}

			return comp;
		},

		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			// Batch mode: delegate to controller which routes to runBatch()
			if (params.batch && params.batch.length > 0) {
				return executeDelegate(
					{ batch: params.batch, signal },
					ctx,
					onUpdate,
				);
			}
			// Single delegation mode
			return executeDelegate(
				{ specialist: params.specialist, task: params.task, skills: params.skills, scope: params.scope, label: params.label, signal },
				ctx,
				onUpdate,
			);
		},
	});
}
