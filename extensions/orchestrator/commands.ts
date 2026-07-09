/**
 * Slash commands for the orchestrator extension.
 * Extracted from orchestrator.ts during refactoring.
 *
 * Commands:
 * - /orchestrate <task> — manual orchestration trigger
 * - /specialists — list available specialists
 * - /delegate-mode — toggle sequential/parallel delegation mode
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setDebugEnabled, isDebugEnabled, debugLog } from "./debug.ts";
import { isPeekOpen } from "./peek-overlay.ts";
import { loadOrchestratorConfig, saveOrchestratorConfig, getSessionMode, setSessionMode } from "./orchestrator-config";
import { SPECIALISTS, listSpecialists } from "./specialists.ts";
import type { SessionContext } from "./types.ts";

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
				plan: inspectPlanState(ctx as SessionContext),
				timestamp: Date.now(),
			};
			const json = JSON.stringify(state, null, 2);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-inspect.json", json, "utf-8");
			} catch (e) { debugLog("[commands] write failed:", e); }
			ctx.ui.notify(`Inspect: ${json.slice(0, 200)}...`, "info");
		},
	});

	pi.registerCommand("render", {
		description: "Capture current TUI render output to /tmp/orchestrator-render.txt",
		handler: async (_args, ctx) => {
			const { snapshotPlanRender } = await import("./plan-panel.ts");
			const text = snapshotPlanRender(ctx as SessionContext);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-render.txt", text ?? "", "utf-8");
			} catch (e) { debugLog("[commands] write failed:", e); }
			ctx.ui.notify(`Render captured → /tmp/orchestrator-render.txt (${text?.length ?? 0} chars)`, "info");
		},
	});

	pi.registerCommand("timeline", {
		description: "Write render timeline to /tmp/orchestrator-timeline.json",
		handler: async (_args, ctx) => {
			const { getTimeline } = await import("./plan-panel.ts");
			const tl = getTimeline(ctx as SessionContext);
			const json = JSON.stringify(tl, null, 2);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-timeline.json", json, "utf-8");
			} catch (e) { debugLog("[commands] write failed:", e); }
			ctx.ui.notify(`Timeline: ${tl?.length ?? 0} frames → /tmp/orchestrator-timeline.json`, "info");
		},
	});

	pi.registerCommand("timeline-diff", {
		description: "Write timeline diff to /tmp/orchestrator-timeline-diff.json",
		handler: async (_args, ctx) => {
			const { getTimelineDiff } = await import("./plan-panel.ts");
			const diff = getTimelineDiff(ctx as SessionContext);
			const json = JSON.stringify(diff, null, 2);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-timeline-diff.json", json, "utf-8");
			} catch (e) { debugLog("[commands] write failed:", e); }
			ctx.ui.notify(`Timeline diff: ${diff?.count ?? 0} transitions → /tmp/orchestrator-timeline-diff.json`, "info");
		},
	});

	pi.registerCommand("debug-orchestrator", {
		description: "Show orchestrator debug snapshot and toggle debug logging (/debug-orchestrator [on|off|status])",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "on") {
				setDebugEnabled(true);
				ctx.ui.notify("Orchestrator debug logging enabled → /tmp/orchestrator-debug/", "info");
				return;
			}
			if (trimmed === "off") {
				setDebugEnabled(false);
				ctx.ui.notify("Orchestrator debug logging disabled", "info");
				return;
			}

			const snapshot = await snapshotOrchestratorState(ctx);
			const json = JSON.stringify(snapshot, null, 2);
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync("/tmp/orchestrator-snapshot.json", json, "utf-8");
			} catch (e) {
				debugLog("[commands] snapshot write failed:", e);
			}
			ctx.ui.notify(`Orchestrator snapshot → /tmp/orchestrator-snapshot.json\n${json.slice(0, 200)}...`, "info");
		},
	});

	pi.registerCommand("delegate-mode", {
		description: "Toggle sequential/parallel delegation mode",
		handler: async (args: string, ctx: any) => {
			const config = loadOrchestratorConfig();

			if (args === "sequential") {
				config.delegation.mode = "sequential";
				saveOrchestratorConfig(config);
				setSessionMode(ctx, "sequential");
				ctx.ui.notify("🔄 Delegation: sequential", "info");
				return;
			}

			if (args === "parallel") {
				config.delegation.mode = "parallel";
				saveOrchestratorConfig(config);
				setSessionMode(ctx, "parallel");
				ctx.ui.notify("⚡ Delegation: parallel", "info");
				return;
			}

			if (args === "status") {
				const mode = getSessionMode(ctx);
				ctx.ui.notify(`Current mode: ${mode}`, "info");
				return;
			}

			// Default: toggle
			const currentMode = getSessionMode(ctx);
			const newMode = currentMode === "sequential" ? "parallel" : "sequential";
			config.delegation.mode = newMode;
			saveOrchestratorConfig(config);
			setSessionMode(ctx, newMode);
			ctx.ui.notify(`Delegation: ${newMode}`, "info");
		},
		getArgumentCompletions: (prefix: string) => [
			{ value: "sequential", label: "Sequential (default)" },
			{ value: "parallel", label: "Parallel" },
			{ value: "status", label: "Show current mode" },
		],
	});
}

/**
 * Build a snapshot of orchestrator runtime state for /debug-orchestrator status.
 */
export async function snapshotOrchestratorState(ctx?: { cwd?: string }): Promise<object> {
	const { inspectPlanState } = await import("./plan-panel.ts");
	const { loadFusionConfig } = await import("./fusion-tool.ts");
	const { existsSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");

	const cwd = ctx?.cwd ?? process.cwd();
	const plan = inspectPlanState(ctx as SessionContext);
	const fusionConfig = loadFusionConfig(cwd);

	return {
		debugEnabled: isDebugEnabled(),
		plan,
		feed: { peekOpen: isPeekOpen() },
		activeDelegations: plan?.activeDelegations ?? 0,
		fusion: {
			enabled: fusionConfig.enabled,
			panelModelCount: fusionConfig.panel.length,
			hasJudge: !!fusionConfig.judge,
			projectConfigExists: existsSync(join(cwd, ".pi", "fusion.json")),
			globalConfigExists: existsSync(join(getAgentDir(), "fusion.json")),
		},
		timestamp: Date.now(),
	};
}
