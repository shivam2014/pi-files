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

/**
 * Regex to strip the auto-generated "Available tools:" / "In addition to..." / "Guidelines:"
 * sections from the system prompt. The prompt is already built by the framework before
 * this handler runs, so setting selectedTools = ["delegate"] doesn't retroactively clean
 * the string — we must remove the contradictory sections ourselves.
 *
 * The default prompt structure is:
 *   <intro>
 *   Available tools:\n<list>\n\nIn addition to...\n\nGuidelines:\n<list>\n\nPi documentation...
 *
 * This regex matches from "Available tools:" up to (exclusive) the blank line before
 * "Pi documentation", removing all tool listings and guidelines.
 * For custom prompts (no "Available tools:" section), it's a no-op.
 */
const TOOLS_SECTION_REGEX = /Available tools:\n[\s\S]*?(?=\n\n(?:Pi documentation|$))/;
import { isSubagentContext, _batchLoadSubagent, SUBAGENT_ENV_KEY } from "./subagent-runner.ts";
import { clearPlanPanel, generatePlanFromPrompt, setupPlanPanel } from "./plan-panel.ts";
import { shortenLabel } from "../token-saver.ts";
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

		// Strip the auto-generated tools list + guidelines from the already-built prompt
		// string (they contradict the "DELEGATE ONLY" instructions below).
		// Note: systemPromptOptions is read-only inspection per pi docs; modifying it
		// has no effect on the already-built prompt string, so we strip via regex instead.
		const cleanedPrompt = event.systemPrompt.replace(TOOLS_SECTION_REGEX, "");

		// Generate and show the full plan upfront from the user's prompt
		const prompt = event.prompt || "";
		if (prompt) {
			const steps = generatePlanFromPrompt(prompt);
			setupPlanPanel(shortenLabel(prompt), steps, ctx);
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
2. Call delegate(scout, "investigate ...") — read output
3. Call delegate(coder, "implement ... based on: [scout output]") — read output
4. Call delegate(reviewer, "review ... based on: [coder output]") — read output
5. Synthesize all results into final answer

You decide next step AFTER seeing previous result. NOT before.`;

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
