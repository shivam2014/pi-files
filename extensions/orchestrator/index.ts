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
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { isSubagentContext, _batchLoadSubagent, SUBAGENT_ENV_KEY, isPlanParsed } from "./subagent-runner.ts";
import { clearPlanPanel } from "./plan-panel.ts";
import { registerDelegateTool } from "./delegate-tool.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { registerCommands } from "./commands.ts";
import { registerFusionCommands } from "./fusion-commands.ts";
import { showPeek, hidePeek, isPeekOpen } from "./peek-overlay.ts";
import { debugLog } from "./debug.ts";
import { SPECIALISTS, listSpecialists } from "./specialists.ts";
import { registerFusionTool, loadFusionConfig } from "./fusion-tool.ts";

function firstCommandName(command: string): { name: string; rest: string } | null {
	const segment = command.split(/[&|;]+/)[0]?.trim() ?? "";
	if (!segment) return null;
	const tokens = segment.split(/\s+/);
	let i = 0;
	while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === "export")) i++;
	const raw = tokens[i];
	if (!raw) return null;
	const name = raw.replace(/.*\//, "").toLowerCase();
	return { name, rest: tokens.slice(i + 1).join(" ") };
}

function hasFileWriteIndicator(text: string): boolean {
	return /\s>>?\s/.test(text) ||
		/\bopen\s*\([^)]*['"](w|a|x)['"]/i.test(text) ||
		/fs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/i.test(text) ||
		/\b(writeFile|appendFile)(Sync)?\s*\(/i.test(text);
}

function isMutatingEditor(name: string, text: string): boolean {
	if ((name === "sed" || name === "perl") && /(^|\s)-i/.test(text)) return true;
	return hasFileWriteIndicator(text);
}

export function getBashToolReplacement(command: string | undefined, override?: boolean): string | null {
	if (override || !command) return null;
	const cmd = firstCommandName(command);
	if (!cmd) return null;
	const { name, rest } = cmd;
	const text = `${name} ${rest}`;
	switch (name) {
		case "cat": return "read";
		case "grep":
		case "rg": return "grep";
		case "find": return "find";
		case "ls": return "ls";
		case "sed":
		case "awk":
		case "perl":
			return isMutatingEditor(name, text) ? "edit" : null;
		case "mkdir":
		case "touch": return "write";
		case "python":
		case "python3":
		case "node":
			return hasFileWriteIndicator(text) ? "edit" : null;
		default: return null;
	}
}

function handleSubagentToolCall(event: any) {
	if (_batchLoadSubagent > 0 && !isPlanParsed()) {
		if (event.toolName !== "planSteps") {
			return { block: true, reason: `Call planSteps({ goal, steps }) first before using ${event.toolName}.` };
		}
	}
	if (_batchLoadSubagent > 0) return;
	if (event.toolName !== "bash") return;
	const command = isToolCallEventType("bash", event) ? event.input.command : event.input?.command;
	const override = event.input?.override === true;
	const replacement = getBashToolReplacement(command, override);
	if (replacement) {
		return { block: true, reason: `Use ${replacement} instead of bash (${command?.trim().split(/\s+/)[0]}). Set override:true to force bash.` };
	}
}

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
		clearPlanPanel(ctx);
		const fusionConfig = loadFusionConfig(ctx.cwd);
		const activeTools = ["plan", "delegate"];
		// Register fusion tool if config enables it
		registerFusionTool(pi, ctx.cwd);
		if (fusionConfig.enabled && pi.getAllTools().some((t: any) => t.name === "fusion")) {
			activeTools.push("fusion");
		}
		pi.setActiveTools(activeTools);

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

		const fusionSection = fusionConfig.enabled
			? `### Fusion Tool\nAfter scout/researcher return findings, call:\nfusion({ context: findings, task: "create execution plan", draft_plan: "your preliminary plan" })\nfor multi-model advice. The panel (2-3 different models) critiques your plan, a judge identifies contradictions and blind spots. Use this before delegating to coder for complex, high-stakes decisions.\n\nWhen to use fusion:\n- After gathering research findings, before writing the final plan\n- When the plan has high cost of error (destructive operations, broad file changes)\n- When you need multiple perspectives on architectural decisions\n\nWhen to skip fusion:\n- Simple, tactical tasks with clear solutions\n- After delegation results that are straightforward\n`
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

${fusionSection}### Scope requirement:
When calling delegate(coder|writer|reviewer|researcher|scout, ...), you MUST include a \`scope\` parameter with the files the specialist is allowed to modify/create and any boundaries.

- Get scope from scout's or researcher's \`## Scope\` output when available.
- Prefer reusing cached scope across delegations for the same task instead of re-deriving it.
- For writers, default to doc-friendly scope: only the docs mentioned, minimal edits, preserve structure.

Example:
\`\`\`
delegate("coder", "fix the token expiry", {
    scope: {
        filesToModify: ["src/auth.ts"],
        filesToCreate: [],
        allowedDirectories: ["src"],
        maxFiles: 15,
        maxLinesPerFile: 400,
        changeType: "single-file",
        requiresApproval: false
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

# Auto-lint Feedback

When you see a message with customType 'lint', treat it as blocking feedback.
If the lint failed, stop and fix the reported issues before calling any further tools.
Do not proceed with edits or delegation until lint passes.

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
	registerDelegateTool(pi);
	registerPlanTool(pi);
	registerCommands(pi);
	registerFusionCommands(pi);

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
