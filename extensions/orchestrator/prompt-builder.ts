/**
 * PromptBuilder — builds the orchestrator system prompt.
 *
 * Extracted from index.ts before_agent_start handler.
 * Generates delegation instructions with specialist roster, skills summary,
 * fusion section, and delegation-specific instructions for orchestrator mode.
 */

import { listSpecialists, SPECIALISTS, COMMUNICATION_INSTRUCTION } from "./specialists.ts";
import { generateScopeDocumentation } from "./scope-manager.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReadmePath, getDocsPath, getExamplesPath } from "@earendil-works/pi-coding-agent";

/**
 * Generate tool documentation table dynamically from pi SDK tool registry.
 * Filters to orchestrator-level tools only (plan, delegate, read_skill, fusion, interactive_shell).
 * Adds hardcoded entries for tools not in the SDK registry.
 */
function generateToolDocumentation(pi: ExtensionAPI): string {
	const allTools = pi.getAllTools();
	const orchestratorToolNames = ["plan", "delegate", "read_skill", "fusion", "interactive_shell"];
	const tools = allTools.filter((t: any) => orchestratorToolNames.includes(t.name));

	const toolRows = tools.map((t: any) => {
		const params = t.parameters?.properties
			? Object.keys(t.parameters.properties).join(", ")
			: "";
		return `| \`${t.name}\` | \`${t.name}(${params})\` | ${t.description} |`;
	}).join("\n");

	// Hardcoded entries for tools not in SDK registry
	const hardcodedTools = [
		{ name: "interactive_shell", syntax: "interactive_shell(query, images?)", description: "Route questions with optional base64 images through configured vision model. Also launches interactive CLI coding agents (Claude Code, Cursor CLI, Gemini CLI, Codex) via overlay. Use for image analysis, diagrams, screenshots, and delegating to interactive TUI agents." },
	];
	const missingHardcoded = hardcodedTools.filter(ht => !tools.some((t: any) => t.name === ht.name));
	const hardcodedRows = missingHardcoded.map(ht =>
		`| \`${ht.name}\` | \`${ht.syntax}\` | ${ht.description} |`
	).join("\n");

	return `
### Tools

| Tool | Syntax | Output |
|------|--------|--------|
${toolRows}${hardcodedRows ? "\n" + hardcodedRows : ""}
`;
}

/**
 * Generate routing table dynamically from SPECIALISTS dict.
 */
function generateRoutingFromSpecialists(): string {
	const specialists = listSpecialists();
	const rows = specialists.map(name => {
		const spec = SPECIALISTS[name];
		const skills = spec.suggestedSkills?.length
			? spec.suggestedSkills.join(", ")
			: "\u2014";
		const taskType = spec.routingLabel || spec.description?.split('.')[0] || name;
		return `| ${taskType} | ${name} | ${skills} |`;
	}).join("\n");

	return `
### Task Routing
| Task type | Specialist | Default skills |
|-----------|------------|----------------|
${rows}
`;
}

const FUSION_INSTRUCTION = `### Fusion Tool\nAfter scout/researcher return findings, call:\nfusion({ context: findings, task: "create execution plan", draft_plan: "your preliminary plan" })\nfor multi-model advice. The panel (2-3 different models) critiques your plan, a judge identifies contradictions and blind spots. Use this before delegating to coder for complex, high-stakes decisions.\n\nWhen to use fusion:\n- After gathering research findings, before writing the final plan\n- When the plan has high cost of error \u2014 defined as: destructive operations (rm, schema migrations, auth changes), touching >5 files, or architectural decisions that are hard to reverse\n- When you need multiple perspectives on architectural decisions\n\nWhen to skip fusion:\n- Simple, tactical tasks with clear solutions\n- After delegation results that are straightforward\n\nNote: If some panel models fail, fusion returns partial results with a "### Failed" section. Check for this and adjust trust accordingly.\n`;

const DELEGATION_INSTRUCTIONS_TEMPLATE = `
## Session-Start Protocol

When this session starts, BEFORE responding to the user:
1. Read docs/MASTER-PLAN.md (use the read tool)
2. Find the first unchecked ticket (\`- [ ]\`) that has no blocked dependencies
3. Declare a plan using plan() with that ticket's goal and steps
4. Begin delegating the first step

If no unchecked tickets remain, inform the user all tickets are complete.
If the user provides a specific task, follow their instruction instead of the master plan.

## Capabilities
| Tool | Purpose |
|------|---------|
| plan(goal, steps) | Declare a plan. Steps can be strings or objects with kind |
| plan_add_steps(steps) | Add steps mid-workflow |
| insert_step(steps, after) | Insert steps at specific position in plan |
| advance_plan_step() | Mark orchestrator step complete, advance to next |
| delegate(specialist, task, scope?) | Delegate to a specialist |
| fusion(context, task, draft_plan?) | Multi-model analysis |
| read_skill(name) | Load skill instructions |
| list_skills | List available skills |
| list_tools | List available tools |

### Workflow:
1. FIRST: Call plan(goal, steps) to declare the overall plan. The goal is a one-line summary. Step items MUST be one-line descriptions (5-10 words each). Full task specs go in delegate() task parameter. Examples:
   plan("Fix login bug", ["diagnose", "implement fix", "test"])
   plan("Research auth options", ["search docs", "read findings", "summarize"])
   plan("Write API docs", ["read source", "draft", "review"])

Step input format:
- String: "do something" \u2192 step label. Orchestrator decides at runtime whether to delegate() or handle it as an orchestrator task.
- Object: { label, kind, ... } \u2192 structured step with explicit kind
  - kind: "delegation" \u2192 forces delegate() call
  - kind: "orchestrator" \u2192 forces self-owned task (analysis, synthesis, decision)
  - kind: "loop_until" \u2192 repeats until criterion met. Load "loop-until" skill for full syntax, behavior docs, and examples.

2. SECOND: For each step, execute it \u2014 either by delegating or doing orchestrator work.

Plan-step rules:
- Each step = ONE action: a single delegate() call, OR an orchestrator task (analysis, synthesis, decision, writing).
- If multiple tasks go to the SAME specialist in ONE delegation, consolidate them into ONE step. Don't over-split.
- If tasks go to DIFFERENT specialists, or mix delegation + orchestrator work, they MUST be separate steps.
- Never declare steps you intend to batch into one delegation \u2014 that orphans the unused steps.
- modify_step: update label/kind. remove_step: delete step.

Adding steps mid-workflow:
- If a delegation reveals new work, call plan_add_steps({ steps: ['new step 1', 'new step 2'] }) to append steps to the current plan.
- plan_add_steps is idempotent \u2014 duplicate step labels are automatically skipped.
- Use this instead of creating a new plan when the current plan is still relevant.

Examples:
  plan("Fix auth bug", ["Diagnose root cause", "Analyze findings", "Implement fix", "Review fix"])
    \u2192 step 1: delegate("scout", ...), step 2: orchestrator analyzes, step 3: delegate("coder", ...), step 4: delegate("reviewer", ...)
  plan("Sync and commit", ["Sync files to repo"])
    \u2192 1 step: delegate("coder", "copy, stage, commit, push") \u2014 all work to one specialist

3. THIRD: Synthesize results.

delegate() auto-creates a minimal plan if none exists, but calling plan() first gives better structure and multi-step visibility.

### Step Advancement (dual path):
Plan steps advance differently depending on their kind:

- **Delegation steps** (kind="delegation" or string steps delegated via delegate()): The delegate() pipeline automatically advances the step after the specialist completes. Do NOT call advance_plan_step() for these.
- **Orchestrator steps** (kind="orchestrator"): You own these \u2014 analysis, synthesis, decision, writing. When you finish the work, call advance_plan_step() to mark the step complete and activate the next pending step. Without this call, the plan stalls.
- **Loop steps** (kind="loop_until"): Managed entirely by the loop mechanism. Do NOT call advance_plan_step() for loop steps.

Summary: only call advance_plan_step() for orchestrator-owned steps.

{{FUSION}}

### Scope requirement:
When calling delegate(coder|writer, ...), include \`scope\`: { filesToModify, filesToCreate, directories, maxFiles, maxLinesPerFile, changeType, boundaries, requiresApprovalBeyondScope }.
Get scope from scout's or researcher's \`## Scope\` output. Reuse cached scope across delegations for the same task.
Writers: default to doc-friendly scope (only mentioned docs, minimal edits, preserve structure).

Include ALL file paths the specialist will touch \u2014 not just repo files. If the task involves writing to /tmp, temp directories, or any non-repo path, include those paths in filesToModify or filesToCreate. Scope is a safety net, not a repo-only filter.

### Routing bash diagnostics:
- Read-only bash diagnostics (curl, lsof, cat, run CLIs, check ports) \u2192 use **reviewer** (has bash + auto-defaulted read-only scope)
- Code modification tasks (fix, implement, create, edit, write) \u2192 use **coder** (requires explicit scope)
- Do NOT send read-only diagnostic tasks to coder \u2014 it will fail with "scope required" even though no files are modified

You decide next step AFTER seeing previous result. NOT before.

### Specialist roster:
When delegating, CHECK each specialist's \u26a0 CANNOT field against task requirements.
A task needing a tool a specialist CANNOT use will fail at runtime.

## Delegation Mode: {{DELEGATION_MODE}}

{{ROSTER}}
{{ROUTING}}{{SKILLS}}

## Skills
| Condition | Action |
|-----------|--------|
| Task matches a skill's description | read_skill("matching-skill") for full instructions |
| Task explicitly names a skill | read_skill("named-skill") |
| Loaded skill references another | read_skill() to load that too |
| No match | Proceed without |

# Recalibration

After each delegation returns:
1. Read [Findings: ...] summary at top of output
2. Assess: does this change remaining steps?
3. If yes: update approach. Spawn new delegations as needed.
4. If no: proceed with next step.

Can: add steps mid-workflow, skip unnecessary steps, re-order based on findings.

Loop steps manage their own iteration cycle. Do not try to advance or recalibrate a running loop step \u2014 it handles evaluation and feedback internally. After a loop completes, assess its output during recalibration like any other delegation result.

# Execution Monitoring

Each delegation returns [Execution: elapsed=Xs, turns=Y, status=ok|error] at top.

Use this to decide:
- status=error: read error, decide \u2014 retry with modified task, change approach, or escalate to user
- elapsed > 120s: subagent may be stuck. Consider aborting and retrying simpler
- turns=1: subagent did one turn \u2014 check if completed or stuck early
- turns > 10: subagent may be looping. Review output carefully

No automatic retries. Each retry uses modified task based on what failed.

# Delegation Error Protocol

When a delegation returns with status=error in details:

1. **Stop and assess** \u2014 do NOT silently continue with partial results
2. **Check the error banner**: \`⚠ DELEGATION FAILED \u2014 status:... \u2014 ...\`
3. **Categorize the error**:
   - **Model error** (stopReason=error): subagent's model failed. Re-delegate with simpler task or different specialist.
   - **Aborted** (status=aborted): subagent was interrupted. User or timeout. Check if partial results exist and whether they're useful.
   - **Tool error** (output starts with \`[error]\`): tool in subagent failed. Read error message, adjust task to avoid that tool.
4. **Retry decision**:
   - If error is transient (network, rate limit): retry same task once
   - If error is structural (wrong specialist, scope too broad): re-delegate with modified task
   - If partial results exist and are useful: acknowledge partial results explicitly, then continue remaining work
   - If no useful results: escalate to user with context
5. **Never pretend a failed delegation succeeded.** Partial results from an error must be explicitly marked as partial in your reasoning.

The delegation result includes these structured fields:
- \`details.status\`: "done" | "error" | "aborted"
- \`details.stopReason\`: model's stop reason
- \`details.errorMessage\`: error description
- \`details.partialResults\`: true if error occurred but output exists

# Blocking Feedback

Messages with customType 'lint'|'error'|'block' are blocking feedback.
STOP, fix reported issues, then proceed. Do not continue until resolved.

# Audit & Issues Review

After each delegation returns, check for **\`\`## Issues\`\`** (under \`\`## Findings\`\`) and **scopeNotes** in the delegation result details.

Every problem must be surfaced to the user \u2014 even if the subagent found a workaround:

- **problems found in Issues or Audit?** Report as a dedicated message:
  \`\`\`
  ⚠️ Friction encountered:
  - Problem: <what went wrong>
  - Resolution: <how the subagent overcame it>
  - Impact: <delays, scope changes, quality effects>
  \`\`\`

- **scopeNotes.deviation?** Check blocked tools in \`metrics.scopeNotes.blockedTools[]\`. If the model tried to access files clearly outside the task (rogue), escalate. If it tried to access files the task legitimately needs but forgot to include in scope (oversight), re-delegate with corrected scope.

- **no scopeNotes + no problems?** No action needed.

Never silently discard problems. Every tool error, permission issue, file-not-found, or workaround is data for improving the system.
`;

/**
 * Build the orchestrator system prompt with delegation instructions.
 * Deduplicates: if basePrompt already contains the orchestrator prompt, returns it unchanged.
 */
export function buildOrchestratorPrompt(options: {
	basePrompt: string;
	skills?: Array<{ name: string; description?: string }>;
	fusionEnabled?: boolean;
	/** SDK reference for dynamic tool documentation generation */
	pi?: ExtensionAPI;
	/** Delegation mode: 'parallel' or 'sequential' */
	mode?: string;
}): { systemPrompt: string } {
	const { basePrompt, skills, fusionEnabled, pi, mode } = options;

	// Dedup guard: if already has orchestrator prompt (new or old format), return unchanged immediately
	if (basePrompt.includes("You are an orchestrator") || basePrompt.includes("## Orchestrator Mode")) {
		return { systemPrompt: basePrompt };
	}

	// Build new intro replacing pi's hardcoded "You are an expert coding assistant..."
	const ORCHESTRATOR_INTRO = `You are an orchestrator. Delegate only.
Available tools: plan(), plan_add_steps(), insert_step(), delegate(), fusion(), read_skill(), list_skills, list_tools, vision_query, interactive_shell.
Use fusion() for multi-model advice before high-cost decisions.
You do NOT have read/bash/grep/find/edit/write for code \u2014 use delegate() to access those via specialists.

Pi SDK docs (for reference \u2014 delegate to specialists who can read these):
- Main: ${getReadmePath()}
- Docs: ${getDocsPath()}
- Examples: ${getExamplesPath()}`;

	// Replace old pi intro with orchestrator intro using robust pattern with fallback
	const OLD_INTRO_MARKER = "You are an expert coding assistant operating inside pi";
	const oldIntroPattern = new RegExp(`[\\s\\S]*?${OLD_INTRO_MARKER}[\\s\\S]*?\\n- [A-Z]\\w+ [a-z]+: [^\\n]+\\n`, "m");

	let baseWithNewIntro: string;
	if (oldIntroPattern.test(basePrompt)) {
		baseWithNewIntro = basePrompt.replace(oldIntroPattern, ORCHESTRATOR_INTRO + "\n\n");
	} else if (basePrompt.includes(OLD_INTRO_MARKER)) {
		// Pattern failed but marker exists \u2014 try simpler replacement (start to first blank line after docs)
		const simplePattern = new RegExp(`[\\s\\S]*?${OLD_INTRO_MARKER}[\\s\\S]*?\\n\\n`, "m");
		baseWithNewIntro = simplePattern.test(basePrompt)
			? basePrompt.replace(simplePattern, ORCHESTRATOR_INTRO + "\n\n")
			: basePrompt; // fallback: don't double-intro
	} else {
		// No old intro at all \u2014 prepend orchestrator intro so the model knows its role
		baseWithNewIntro = basePrompt
			? basePrompt
			: ORCHESTRATOR_INTRO;
	}

	// Build dynamic specialist roster
	const allTools = [...new Set(Object.values(SPECIALISTS).flatMap(s => s.tools))];
	const rosterLines = listSpecialists().map(name => {
		const spec = SPECIALISTS[name];
		const desc = spec.description || "";
		const tools = spec.tools.join(", ");
		const missing = allTools.filter(t => !spec.tools.includes(t));
		const gapLine = missing.length > 0
			? `\n    \u26a0 CANNOT: ${missing.join(", ")}`
			: "";
		return `  - **${name}** \u2014 ${desc}\n    tools: ${tools}${gapLine}`;
	}).join("\n\n");

	// Build skills summary
	const skillsSection = skills && skills.length > 0
		? `\n\nAvailable skills (pass relevant ones in task descriptions):\n${skills.map(s => `  - **${s.name}**: ${s.description}`).join("\n")}`
		: "";

	const fusionSection = fusionEnabled ? FUSION_INSTRUCTION : "";

	// Dynamic tool documentation from SDK (with fallback for tests)
	const toolsSection = options.pi
		? generateToolDocumentation(options.pi)
		: "";

	// Dynamic routing: always use SPECIALISTS dict
	const routingSection = generateRoutingFromSpecialists();

	// Build mode section
	const modeSection = mode === "parallel"
		? `You are in **parallel delegation mode**. You can use the \`batch\` parameter on delegate() to run multiple independent delegations concurrently. This is useful for:\n- Investigating multiple files or systems simultaneously\n- Running independent research tasks in parallel\n- Reviewing different parts of the codebase at once\n\nUse batch ONLY for independent tasks. Tasks with dependencies must be sequential.\n\nExample:\ndelegate({ batch: [\n  { specialist: "scout", task: "investigate auth system" },\n  { specialist: "scout", task: "investigate database layer" }\n]})`
		: `You are in **sequential delegation mode**. One delegation at a time. Use delegate() with specialist and task for each step.`;

	// Assemble instructions
	const instructions = DELEGATION_INSTRUCTIONS_TEMPLATE
		.replace("{{ROSTER}}", rosterLines)
		.replace("{{ROUTING}}", routingSection)
		.replace("{{SKILLS}}", skillsSection)
		.replace("{{FUSION}}", fusionSection)
		.replace("{{SCOPE_SHAPE}}", generateScopeDocumentation())
		.replace("{{DELEGATION_MODE}}", modeSection);

	// Token measurement: added ~500 chars (tool docs, scope shape), removed ~2300 chars
	// (COMMUNICATION_INSTRUCTION trimmed from ~700 to ~280 x 5 specialists, bash sections removed).
	// Net: approximately -1800 chars (token-negative).
	return {
		systemPrompt: baseWithNewIntro + "\n\n" + instructions + toolsSection + COMMUNICATION_INSTRUCTION,
	};
}
