/**
 * ORCHESTRATOR EXTENSION — Entry point.
 *
 * Refactored from monolithic orchestrator.ts (1663 lines) into modular structure.
 * Design spec: ORCHESTRATION-UI-DESIGN.md
 * Refactoring plan: ORCHESTRATION-REFACTOR.md
 *
 * This file is the wiring hub. It:
 * - Guards against subagent re-registration (env var check)
 * - Registers before_agent_start handler (injects system prompt, strips tools)
 * - Registers tool_call handler (blocks non-delegate calls)
 * - Delegates tool registration to delegate-tool.ts
 * - Delegates command registration to commands.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isSubagentContext, _batchLoadSubagent, SUBAGENT_ENV_KEY, isPlanParsed } from "./subagent-runner.ts";
import { clearPlanPanel } from "./plan-panel.ts";
import { showPeek, hidePeek, isPeekOpen } from "./peek-overlay.ts";
import { debugLog } from "./debug.ts";
import { loadFusionConfig } from "./fusion-tool.ts";
import { ScopeManager } from "./scope-manager.ts";
import { handleSubagentToolCall } from "./subagent-tool-guard.ts";
import { buildOrchestratorPrompt } from "./prompt-builder.ts";
import { registerAllTools } from "./registration-hub.ts";

export { getBashToolReplacement } from "./bash-interceptor.ts";

export default function (pi: ExtensionAPI) {
	// ── Guard: Skip full orchestrator registration when loading for a subagent session ──
	if (_batchLoadSubagent > 0 || isSubagentContext()) {
		debugLog("SKIPPING orchestrator registration (subagent context)", {
			batchLoad: _batchLoadSubagent,
			envGuard: process.env[SUBAGENT_ENV_KEY],
		});
		pi.on("tool_call", handleSubagentToolCall);
		return;
	}

	// ── System Prompt: Tell the agent to ALWAYS delegate ──
	pi.on("before_agent_start", async (event, ctx) => {
		new ScopeManager(process.cwd()).clearScope();
		clearPlanPanel(ctx);
		const fusionConfig = loadFusionConfig(ctx.cwd);
		const activeTools = ["plan", "delegate"];
		if (fusionConfig.enabled && pi.getAllTools().some((t: any) => t.name === "fusion")) {
			activeTools.push("fusion");
		}
		pi.setActiveTools(activeTools);

		const parentSkills = event.systemPromptOptions?.skills;
		return buildOrchestratorPrompt({
			basePrompt: event.systemPrompt ?? "",
			skills: parentSkills,
			fusionEnabled: fusionConfig.enabled,
		});
	});

	// ── Safety net: Block non-delegation tool calls ──
	pi.on("tool_call", async (event, ctx) => {
		// Subagent: enforce planSteps-first before any other tool
		if (_batchLoadSubagent > 0 && !isPlanParsed()) {
			if (event.toolName !== "planSteps") {
				return { block: true, reason: `Call planSteps({ goal, steps }) first before using ${event.toolName}.` };
			}
		}
		if (_batchLoadSubagent > 0) return; // Don't block other subagent tools
		if (event.toolName === "fusion" && !pi.getAllTools().some((t: any) => t.name === "fusion")) {
			return { block: true, reason: "Fusion is disabled. Enable it in .pi/fusion.json" };
		}
		if (event.toolName !== "delegate" && event.toolName !== "plan" && event.toolName !== "fusion") {
			return { block: true, reason: `Orchestrator mode: use plan() or delegate() instead of ${event.toolName}` };
		}
	});

	// ── Agent end: flush timeline recording to disk ──
	pi.on("agent_end", async (event, ctx) => {
		try {
			const { clearPlanPanel } = await import("./plan-panel.ts");
			clearPlanPanel(ctx);
		} catch (err) {
			debugLog("agent_end: failed to dump timeline", err);
		}
	});

	// Lint-guard dependency check
	debugLog("lint-guard: expected to be loaded as required dependency. If lint/typecheck tools missing, check extension loading.");

	// ── Register tools, commands, and shortcuts ──
	registerAllTools(pi, process.cwd());

	// ── Ctrl+Q: Peek overlay (Layer 3, mnemonic "quick peek") ──
	pi.registerShortcut("ctrl+q", {
		description: "Peek inside the current subagent conversation",
		handler: (ctx) => {
			if (isPeekOpen()) {
				hidePeek();
				return;
			}
			if (ctx.mode !== "tui") return;
			showPeek(ctx);
		},
	});
}
