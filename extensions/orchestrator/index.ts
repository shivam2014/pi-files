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
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { isSubagentContext, _batchLoadSubagent, SUBAGENT_ENV_KEY, isPlanParsed } from "./subagent-runner.ts";
import { clearPlanPanel } from "./plan-panel.ts";
import { showPeek, hidePeek, isPeekOpen } from "./peek-overlay.ts";
import { debugLog } from "./debug.ts";
import { traceToolCallEntry, traceMark } from "./debug-path-trace.ts";
import { loadFusionConfig } from "./fusion-tool.ts";
import { ScopeManager } from "./scope-manager.ts";
import { handleSubagentToolCall } from "./subagent-tool-guard.ts";
import { buildOrchestratorPrompt } from "./prompt-builder.ts";
import { registerAllTools } from "./registration-hub.ts";
import { createReadSkillTool } from "./read-skill-tool.ts";
import { SPECIALISTS, updateToolDocs } from "./specialists.ts";
import { join } from "node:path";

export { getBashToolReplacement } from "./bash-interceptor.ts";

function resolveCwd(ctx?: { cwd?: string }): string {
	return ctx?.cwd ?? process.cwd();
}

export default function (pi: ExtensionAPI) {
	// ── Guard: Skip full orchestrator registration when loading for a subagent session ──
	if (_batchLoadSubagent > 0 || isSubagentContext()) {
		debugLog("SKIPPING orchestrator registration (subagent context)", {
			batchLoad: _batchLoadSubagent,
			envGuard: process.env[SUBAGENT_ENV_KEY],
		});
		pi.on("tool_call", (event, ctx) => {
			traceToolCallEntry('index:subagent-tool_call', event, ctx);
			const cwd = resolveCwd(ctx);
			const fusionConfig = loadFusionConfig(cwd);
			const result = handleSubagentToolCall(event, fusionConfig.enabled, ctx);
			traceMark('index:subagent-tool_call.result', { tool: event.toolName, input_path: (event.input as any)?.path, result });
			return result;
		});
		return;
	}

	// ── Freeze active tools at session_start for prefix-cache stability ──
	// MUST be in session_start (not before_agent_start) because:
	//   - init: setActiveTools not yet bound (throws "Extension runtime not initialized")
	//   - before_agent_start: causes 1-turn lag — turn 1 sees ALL tools, turn 2+ sees
	//     narrowed set → "Available tools:" section differs → prefix cache broken
	//   - session_start: runtime bound, fires before first createTurnState()
	//     → prompt stable from turn 1 onward
	//
	// ⚠ TESTING NOTE: Tests must trigger "session_start" before "before_agent_start"
	//    to exercise this handler. See fusion-toggle.test.ts for the pattern:
	//      await pi.trigger("session_start", {}, { cwd })
	//      await pi.trigger("before_agent_start", event, ctx)
	//    Without this, setActiveTools never fires and getActiveToolsHistory() returns undefined.
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx?.cwd ?? process.cwd();
		const fusionConfig = loadFusionConfig(cwd);
		const activeTools: string[] = ["plan", "delegate"];
		if (fusionConfig.enabled) {
			activeTools.push("fusion");
		}
		activeTools.push("read_skill");
		activeTools.push("list_skills");
		activeTools.push("list_tools");
		activeTools.push("vision_query");
		pi.setActiveTools(activeTools);
	});

	// ── System Prompt: Tell the agent to ALWAYS delegate ──
	pi.on("before_agent_start", async (event, ctx) => {
		new ScopeManager(resolveCwd(ctx)).clearScope();
		clearPlanPanel(ctx);

		const fusionConfig = loadFusionConfig(ctx.cwd);
		const parentSkills = event.systemPromptOptions?.skills;
		return buildOrchestratorPrompt({
			basePrompt: event.systemPrompt ?? "",
			skills: parentSkills,
			fusionEnabled: fusionConfig.enabled,
			pi,
		});
	});

	// ── Resources: Register ask-matt skills for SDK skill discovery (issue #41) ──
	pi.on("resources_discover", async (event, ctx) => {
		// getAgentDir() returns ~/.pi/agent — skills live under that directory
		const skillsDir = join(getAgentDir(), "skills");
		// Dynamically resolve skill paths from the specialist roster
		const skillPaths: string[] = [];
		for (const specialist of Object.values(SPECIALISTS)) {
			for (const skillName of specialist.suggestedSkills ?? []) {
				skillPaths.push(join(skillsDir, skillName, "SKILL.md"));
			}
		}
		return { skillPaths };
	});

	// ── Safety net: Block non-delegation tool calls ──
	pi.on("tool_call", async (event, ctx) => {
		traceToolCallEntry('index:orchestrator-tool_call', event, ctx);
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
		if (event.toolName !== "delegate" && event.toolName !== "plan" && event.toolName !== "plan_add_steps" && event.toolName !== "fusion" && event.toolName !== "read_skill" && event.toolName !== "list_skills" && event.toolName !== "list_tools" && event.toolName !== "vision_query") {
			return { block: true, reason: `Orchestrator mode: use plan() or delegate() instead of ${event.toolName}` };
		}
	});

	// ── Agent end: flush timeline recording to disk ──
	pi.on("agent_end", async (event, ctx) => {
		try {
			clearPlanPanel(ctx);
		} catch (err) {
			debugLog("agent_end: failed to dump timeline", err);
		}
	});

	// ── Session shutdown: clear plan panel instances for this session ──
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			clearPlanPanel(ctx);
		} catch (err) {
			debugLog("session_shutdown: failed to clear plan panel", err);
		}
	});

	// Lint-guard dependency check
	debugLog("lint-guard: expected to be loaded as required dependency. If lint/typecheck tools missing, check extension loading.");

	// ── Register tools, commands, and shortcuts ──
	registerAllTools(pi, resolveCwd());
	pi.registerTool(createReadSkillTool());
	updateToolDocs(pi);

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
