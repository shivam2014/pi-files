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
import { registerDelegateTool } from "./delegate-tool.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { registerCommands } from "./commands.ts";
import { showPeek, hidePeek, isPeekOpen } from "./peek-overlay.ts";
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
		pi.setActiveTools(["plan", "delegate"]);

		const cleanedPrompt = event.systemPrompt;

		// Wait for orchestrator to declare plan via the plan() tool

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
1. FIRST: Call plan(goal, steps) to declare the overall plan. The goal is a one-line summary. The steps are the actions you will delegate. Example:
   plan("Fix auth bug", ["Read auth middleware", "Fix token validation", "Write tests", "Verify"])

2. SECOND: For each step, call delegate(specialist, task, scope) to execute work.

3. THIRD: Synthesize results.

NOTE: delegate() auto-creates a plan if plan() was not called first. Call plan() first for multi-step work.

### Scope requirement:
When calling delegate(coder, ...), you MUST include a \`scope\` parameter with the files the coder is allowed to modify/create. Get this from scout's \`## Scope\` output, or declare it yourself based on your analysis.

Example:
\`\`\`
delegate("coder", "fix the token expiry", {
    scope: {
        filesToModify: ["src/auth.ts"],
        filesToCreate: []
    }
})
\`\`\`

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

# Execution Monitoring

Each delegation returns [Execution: elapsed=Xs, turns=Y, status=ok|error] at top.

Use this to decide:
- status=error: read error, decide — retry with modified task, change approach, or escalate to user
- elapsed > 120s: subagent may be stuck. Consider aborting and retrying simpler
- turns=1: subagent did one turn — check if completed or stuck early
- turns > 10: subagent may be looping. Review output carefully

No automatic retries. Each retry uses modified task based on what failed.

# Audit Review

After each delegation returns, check for [Audit: ...] prefix:
- If problems reported: assess if they affect the plan. Adjust if needed.
- If scope_deviation reported: this is critical. Review what the subagent did outside its scope. Decide if the deviation was acceptable or if you need to correct it.
- If no audit issues: proceed normally.

Scope deviations are serious. If a subagent wrote files it wasn't supposed to, or ran commands outside its task, you MUST flag this to the user.

# Clarification

If task ambiguous before starting:
- Ask user ONE clear question
- Wait for answer before delegating
- Don't guess — clarifying upfront saves context window`;

		const basePrompt = event.systemPrompt ?? "";
		const marker = "## Orchestrator Mode";
		if (basePrompt.includes(marker)) {
			return { systemPrompt: basePrompt };
		}
		return {
			systemPrompt: basePrompt + "\n\n" + delegationInstructions,
		};
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
		if (event.toolName !== "delegate" && event.toolName !== "plan") {
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
	registerDelegateTool(pi);
	registerPlanTool(pi);
	registerCommands(pi);

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
