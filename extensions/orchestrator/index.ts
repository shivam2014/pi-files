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

import { SUBAGENT_ENV_KEY } from "./subagent-runner.ts";
import { subagentSessions, type SubagentState } from "./subagent-sessions.ts";
import { clearPlanPanel, PlanPanel } from "./plan-panel.ts";
import { showPeek, hidePeek, isPeekOpen } from "./peek-overlay.ts";
import { debugLog } from "./debug.ts";
import { traceToolCallEntry, traceMark } from "./debug-path-trace.ts";
import { loadFusionConfig } from "./fusion-tool.ts";
import { ScopeManager } from "./scope-manager.ts";
import { handleSubagentToolCall } from "./subagent-tool-guard.ts";
import { buildOrchestratorPrompt } from "./prompt-builder.ts";
import { registerAllTools } from "./registration-hub.ts";
import { PLAN_TOOLS } from "./plan-tool.ts";
import { createReadSkillTool } from "./read-skill-tool.ts";
import { SPECIALISTS } from "./specialists.ts";
import { join } from "node:path";
import { getSessionMode } from "./orchestrator-config";

function resolveCwd(ctx?: { cwd?: string }): string {
	return ctx?.cwd ?? process.cwd();
}

/** Specialist names that have bash but no edit/write — need tool-level readOnly enforcement */
const READ_ONLY_WITH_BASH = new Set(["reviewer"]);

export default function (pi: ExtensionAPI) {
	// ── Defensive: clear stale subagent env var from previous delegations ──
	// The env var is set during subagent extension loading and deleted in finally.
	// But if the process persists between delegations, a stale value would skip
	// all orchestrator registration. Clear it defensively on every entry.
	// (Subagent loads set it AFTER this point, via SubagentRunner.run())
	if (process.env[SUBAGENT_ENV_KEY] === "1" && subagentSessions.size === 0) {
		delete process.env[SUBAGENT_ENV_KEY];
	}

	// ── Subagent context: skip orchestrator-specific handlers, but still register tools ──
	// Tools must always be registered (SDK wipes handlers on loader.reload()).
	// Orchestrator-specific event handlers check env var internally.
	const isSubagentLoad = process.env[SUBAGENT_ENV_KEY] === "1";

	// ── Advisory entry-point detection ──
	/**
	 * Check if current specialist is read-only with bash access.
	 * These specialists have bash but no edit/write — need tool-level enforcement.
	 */
	function isReadOnlySpecialist(sessionId: string): boolean {
		const state = subagentSessions.get(sessionId);
		return !!state && READ_ONLY_WITH_BASH.has(state.specialistName);
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
		if (isSubagentLoad) return;  // Skip orchestrator tool freezing in subagent context
		const cwd = ctx?.cwd ?? process.cwd();
		const fusionConfig = loadFusionConfig(cwd);
		const activeTools: string[] = [...PLAN_TOOLS, "delegate"];
		if (fusionConfig.enabled) {
			activeTools.push("fusion");
		}
		activeTools.push("read_skill");
		activeTools.push("list_skills");
		activeTools.push("list_tools");
		activeTools.push("vision_query");
		activeTools.push("interactive_shell");
		pi.setActiveTools(activeTools);
	});

	// ── System Prompt: Tell the agent to ALWAYS delegate ──
	pi.on("before_agent_start", async (event, ctx) => {
		if (isSubagentLoad) return;  // Skip orchestrator prompt injection in subagent context
		new ScopeManager(resolveCwd(ctx)).clearScope();

		// Don't clear plan panel if a loop is active
		const loopStates = PlanPanel.getLoopStates();
		const hasActiveLoop = Array.from(loopStates.values()).some(
			state => state.status === 'running'
		);
		if (!hasActiveLoop) {
			clearPlanPanel(ctx);
		}

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
		if (isSubagentLoad) return;  // Skip orchestrator skill discovery in subagent context
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

	// ── Unified tool_call handler — routes by per-session Map ──
	pi.on("tool_call", async (event, ctx) => {
		traceToolCallEntry('index:tool_call', event, ctx);
		const sessionId = (ctx as any)?.sessionManager?.getSessionId?.();
		const subagentState: SubagentState | undefined = sessionId ? subagentSessions.get(sessionId) : undefined;

		if (subagentState) {
			// Subagent session — route to subagent enforcement
			const cwd = resolveCwd(ctx);
			const fusionConfig = loadFusionConfig(cwd);
			const result = handleSubagentToolCall(event, fusionConfig.enabled, { ...ctx, readOnly: isReadOnlySpecialist(sessionId) }, subagentState);
			// Mark plan as parsed when planSteps is called
			if (event.toolName === "planSteps" && !subagentState.planParsed) {
				subagentState.planParsed = true;
			}
			traceMark('index:tool_call.result', { tool: event.toolName, input_path: (event.input as any)?.path, result });
			return result;
		}

		// Orchestrator session — apply whitelist
		if (event.toolName === "delegate") {
			const currentMode = getSessionMode(ctx);
			debugLog("[orchestrator] delegate call in mode:", currentMode);
		}

		if (event.toolName === "fusion" && !pi.getAllTools().some((t: any) => t.name === "fusion")) {
			return { block: true, reason: "Fusion is disabled. Enable it in .pi/fusion.json" };
		}

		if (event.toolName !== "delegate" && !PLAN_TOOLS.includes(event.toolName as typeof PLAN_TOOLS[number]) && event.toolName !== "fusion" && event.toolName !== "read_skill" && event.toolName !== "list_skills" && event.toolName !== "list_tools" && event.toolName !== "vision_query" && event.toolName !== "interactive_shell") {
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
