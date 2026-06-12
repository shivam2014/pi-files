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

import { isSubagentContext, _batchLoadSubagent, SUBAGENT_ENV_KEY } from "./subagent-runner.ts";
import { clearPlanPanel, generatePlanFromPrompt, setupPlanPanel, summarizeGoal } from "./plan-panel.ts";
import { registerDelegateTool } from "./delegate-tool.ts";
import { registerCommands } from "./commands.ts";
import { debugLog } from "./debug.ts";
import { SPECIALISTS, listSpecialists } from "./specialists.ts";

export default function (pi: ExtensionAPI) {
	// ── Guard: Skip registration when loading for a subagent session ──
	if (_batchLoadSubagent > 0 || isSubagentContext()) {
		debugLog("SKIPPING orchestrator registration (subagent context)", {
			batchLoad: _batchLoadSubagent,
			envGuard: process.env[SUBAGENT_ENV_KEY],
		});
		return;
	}

	// ── System Prompt: Tell the agent to ALWAYS delegate ──
	pi.on("before_agent_start", async (event, ctx) => {
		clearPlanPanel(ctx);
		pi.setActiveTools(["delegate"]);

		const cleanedPrompt = event.systemPrompt;

		// Generate and show the full plan upfront from the user's prompt
		const prompt = event.prompt || "";
		if (prompt) {
			const steps = generatePlanFromPrompt(prompt);
			setupPlanPanel(summarizeGoal(prompt), steps, ctx);
		}

		// Build dynamic specialist roster
		const rosterLines = listSpecialists().map(name => {
			const spec = SPECIALISTS[name];
			const tools = spec.tools.join(", ");
			const desc = spec.description ? ` ${spec.description}` : "";
			return `  - **${name}** — tools: ${tools}${desc}`;
		}).join("\n");

		// Build skills summary available to subagents (from parent context)
		const parentSkills = event.systemPromptOptions?.skills;
		const skillsSection = parentSkills && parentSkills.length > 0
			? `\n\nAvailable skills (pass relevant ones in task descriptions):\n${parentSkills.map(s => `  - **${s.name}**: ${s.description}`).join("\n")}`
			: "";

		const delegationInstructions = `
## Orchestrator Mode — DELEGATE ONLY

You are an expert coding assistant operating in **orchestrator mode**. In this mode, your role shifts from direct execution to delegation management — you direct specialist agents who do the hands-on work.

### Your tool: delegate(specialist, task)

You have ONE tool: \`delegate(specialist, task)\`.
Call it once per step. Review the output. Then call it again for the next step.

You do NOT have read, bash, grep, find, edit, or write tools in this mode.
You CANNOT access files or run commands directly.

### Specialist roster:
${rosterLines}
${skillsSection}

### Workflow:
1. Analyze the request
2. If task is investigation or CLI execution → delegate(scout, ...)
3. If task involves file changes → delegate(scout, ...) first for scope, then delegate(coder, ...)
4. If task is code review → delegate(reviewer, ...)
5. Synthesize all results into final answer

You decide next step AFTER seeing previous result. NOT before.

# Communication: Caveman Mode

Respond terse like smart caveman. All technical substance stay. Only fluff die.

ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.
Pattern: [thing] [action] [reason]. [next step].

Drop caveman for: security warnings, destructive ops, multi-step ambiguity, user asks clarify. Resume after clear part done.

Code/commits/PRs: write normal. "stop caveman" or "normal mode": revert. Think short too. No verbose CoT.

# Recalibration

After each delegation returns:
1. Read [Findings: ...] summary at top of output
2. Assess: does this change remaining steps?
3. If yes: update approach. Spawn new delegations as needed.
4. If no: proceed with next step.

Can: add steps mid-workflow, skip unnecessary steps, re-order based on findings.

# Clarification

If task ambiguous before starting:
- Ask user ONE clear question
- Wait for answer before delegating
- Don't guess — clarifying upfront saves context window`;

		return {
			systemPrompt: cleanedPrompt + delegationInstructions,
		};
	});

	// ── Safety net: Block non-delegation tool calls ──
	pi.on("tool_call", async (event, ctx) => {
		if (_batchLoadSubagent > 0) return; // Don't block subagent tools
		if (event.toolName !== "delegate") {
			return { block: true, reason: `Orchestrator mode: use delegate() instead of ${event.toolName}` };
		}
	});

	// ── Register tools and commands ──
	registerDelegateTool(pi);
	registerCommands(pi);
}
