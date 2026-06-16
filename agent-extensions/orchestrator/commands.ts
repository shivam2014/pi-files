/**
 * Slash commands for the orchestrator extension.
 * Extracted from orchestrator.ts during refactoring.
 *
 * Commands:
 * - /orchestrate <task> — manual orchestration trigger
 * - /specialists — list available specialists
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SPECIALISTS, listSpecialists } from "./specialists.ts";

/**
 * Register slash commands on the pi extension API.
 */
export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("orchestrate", {
		description: "Run an orchestrated task with multiple specialists",
		handler: async (args, ctx) => {
			if (!args || args.trim().length === 0) {
				ctx.ui.notify("Usage: /orchestrate <task description>", "warning");
				return;
			}

			const task = args.trim();
			ctx.ui.notify(`Starting orchestrated task: ${task}`, "info");
			pi.sendUserMessage(task, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("specialists", {
		description: "List available specialists and their capabilities",
		handler: async (_args, ctx) => {
			const lines = Object.entries(SPECIALISTS).map(([key, spec]) => {
				return `${key}: ${spec.tools.join(", ")}`;
			});
			ctx.ui.notify(`Specialists:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("inspect", {
		description: "Dump orchestrator state as JSON for debugging",
		handler: async (_args, ctx) => {
			// Dynamic import to avoid circular deps at module load time
			const { inspectPlanState } = await import("./plan-panel.ts");
			const { inspectFeedState } = await import("./activity-feed.ts");

			const state = {
				plan: inspectPlanState(),
				timestamp: Date.now(),
			};
			const json = JSON.stringify(state, null, 2);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-inspect.json", json, "utf-8");
			} catch (e) { console.error("[commands] write failed:", e); }
			ctx.ui.notify(`Inspect: ${json.slice(0, 200)}...`, "info");
		},
	});

	pi.registerCommand("render", {
		description: "Capture current TUI render output to /tmp/orchestrator-render.txt",
		handler: async (_args, ctx) => {
			const { snapshotPlanRender } = await import("./plan-panel.ts");
			const text = snapshotPlanRender();
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-render.txt", text, "utf-8");
			} catch (e) { console.error("[commands] write failed:", e); }
			ctx.ui.notify(`Render captured → /tmp/orchestrator-render.txt (${text.length} chars)`, "info");
		},
	});

	pi.registerCommand("timeline", {
		description: "Write render timeline to /tmp/orchestrator-timeline.json",
		handler: async (_args, ctx) => {
			const { getTimeline } = await import("./plan-panel.ts");
			const tl = getTimeline();
			const json = JSON.stringify(tl, null, 2);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-timeline.json", json, "utf-8");
			} catch (e) { console.error("[commands] write failed:", e); }
			ctx.ui.notify(`Timeline: ${tl.length} frames → /tmp/orchestrator-timeline.json`, "info");
		},
	});

	pi.registerCommand("timeline-diff", {
		description: "Write timeline diff to /tmp/orchestrator-timeline-diff.json",
		handler: async (_args, ctx) => {
			const { getTimelineDiff } = await import("./plan-panel.ts");
			const diff = getTimelineDiff();
			const json = JSON.stringify(diff, null, 2);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-timeline-diff.json", json, "utf-8");
			} catch (e) { console.error("[commands] write failed:", e); }
			ctx.ui.notify(`Timeline diff: ${diff.length} transitions → /tmp/orchestrator-timeline-diff.json`, "info");
		},
	});
}
