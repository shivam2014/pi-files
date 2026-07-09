/**
 * PromptBuilder — builds the orchestrator system prompt.
 *
 * Extracted from index.ts before_agent_start handler.
 * Generates delegation instructions with specialist roster, skills summary,
 * fusion section, and delegation-specific instructions for orchestrator mode.
 */

import { listSpecialists, SPECIALISTS, TERSE_INSTRUCTION } from "./specialists.ts";
import { generateScopeDocumentation } from "./scope-manager.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReadmePath, getDocsPath, getExamplesPath } from "@earendil-works/pi-coding-agent";

const ROUTING_TABLE = `
### Task Routing
| Task type | Specialist | Default skills |
|-----------|------------|----------------|
| Investigate codebase / find files | scout | diagnosing-bugs |
| Implement feature / fix bug | coder | implement, tdd |
| Review code / diff / run bash diagnostics | reviewer | review |
| Research docs / web | researcher | domain-modeling |
| Create/edit docs | writer | agents-md-writer |
`;

/**
 * Generate tool documentation table dynamically from pi SDK tool registry.
 * Filters to orchestrator-level tools only (plan, delegate, read_skill, fusion).
 */
function generateToolDocumentation(pi: ExtensionAPI): string {
	const allTools = pi.getAllTools();
	const orchestratorToolNames = ["plan", "delegate", "read_skill", "fusion"];
	const tools = allTools.filter((t: any) => orchestratorToolNames.includes(t.name));

	const toolRows = tools.map((t: any) => {
		const params = t.parameters?.properties
			? Object.keys(t.parameters.properties).join(", ")
			: "";
		return `| \`${t.name}\` | \`${t.name}(${params})\` | ${t.description} |`;
	}).join("\n");

	return `
### Tools

| Tool | Syntax | Output |
|------|--------|--------|
${toolRows}

${generateScopeDocumentation()}
`;
}

/**
 * Generate routing table dynamically from SPECIALISTS dict.
 * Falls back to ROUTING_TABLE constant when SPECIALISTS is unavailable.
 */
function generateRoutingFromSpecialists(): string {
	const specialists = listSpecialists();
	const rows = specialists.map(name => {
		const spec = SPECIALISTS[name];
		const skills = spec.suggestedSkills?.length
			? spec.suggestedSkills.join(", ")
			: "—";
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

const FUSION_INSTRUCTION = `### Fusion Tool\nAfter scout/researcher return findings, call:\nfusion({ context: findings, task: "create execution plan", draft_plan: "your preliminary plan" })\nfor multi-model advice. The panel (2-3 different models) critiques your plan, a judge identifies contradictions and blind spots. Use this before delegating to coder for complex, high-stakes decisions.\n\nWhen to use fusion:\n- After gathering research findings, before writing the final plan\n- When the plan has high cost of error — defined as: destructive operations (rm, schema migrations, auth changes), touching >5 files, or architectural decisions that are hard to reverse\n- When you need multiple perspectives on architectural decisions\n\nWhen to skip fusion:\n- Simple, tactical tasks with clear solutions\n- After delegation results that are straightforward\n`;

const DELEGATION_INSTRUCTIONS_TEMPLATE = `
## Capabilities
| Tool | Purpose |
|------|---------|
| plan(goal, steps) | Declare a plan before delegating |
| plan_add_steps(steps) | Add steps mid-workflow |
| insert_step(steps, after) | Insert steps at specific position in plan |
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

2. SECOND: For each step, execute it — either by delegating or doing orchestrator work.

Plan-step rules:
- Each step = ONE action: a single delegate() call, OR an orchestrator task (analysis, synthesis, decision, writing).
- If multiple tasks go to the SAME specialist in ONE delegation, consolidate them into ONE step. Don't over-split.
- If tasks go to DIFFERENT specialists, or mix delegation + orchestrator work, they MUST be separate steps.
- Never declare steps you intend to batch into one delegation — that orphans the unused steps.
- modify_step: update label/kind. remove_step: delete step.

Adding steps mid-workflow:
- If a delegation reveals new work, call plan_add_steps({ steps: ['new step 1', 'new step 2'] }) to append steps to the current plan.
- plan_add_steps is idempotent — duplicate step labels are automatically skipped.
- Use this instead of creating a new plan when the current plan is still relevant.

Examples:
  plan("Fix auth bug", ["Diagnose root cause", "Analyze findings", "Implement fix", "Review fix"])
    → step 1: delegate("scout", ...), step 2: orchestrator analyzes, step 3: delegate("coder", ...), step 4: delegate("reviewer", ...)
  plan("Sync and commit", ["Sync files to repo"])
    → 1 step: delegate("coder", "copy, stage, commit, push") — all work to one specialist

3. THIRD: Synthesize results.

delegate() auto-creates a minimal plan if none exists, but calling plan() first gives better structure and multi-step visibility.

{{FUSION}}

### Scope requirement:
When calling delegate(coder|writer, ...), you MUST include a \`scope\` parameter with the files the specialist is allowed to modify/create and any boundaries.
// Scout, reviewer, researcher are read-only — scope optional

- Get scope from scout's or researcher's \`## Scope\` output when available.
- Prefer reusing cached scope across delegations for the same task instead of re-deriving it.
- For writers, default to doc-friendly scope: only the docs mentioned, minimal edits, preserve structure.

Example:
\`\`\`
delegate("coder", "fix the token expiry", {
    scope: {
        filesToModify: ["src/auth.ts"],
        filesToCreate: [],
        directories: ["src"],
        boundaries: "do not modify files under src/legacy/",
        maxFiles: 15,
        maxLinesPerFile: 400,
        changeType: "single-file",
        requiresApprovalBeyondScope: false
    }
})
\`\`\`

### Routing bash diagnostics:
- Read-only bash diagnostics (curl, lsof, cat, run CLIs, check ports) → use **reviewer** (has bash + auto-defaulted read-only scope)
- Code modification tasks (fix, implement, create, edit, write) → use **coder** (requires explicit scope)
- Do NOT send read-only diagnostic tasks to coder — it will fail with "scope required" even though no files are modified

You decide next step AFTER seeing previous result. NOT before.

### Specialist roster:
When delegating, CHECK each specialist's ⚠ CANNOT field against task requirements.
A task needing a tool a specialist CANNOT use will fail at runtime.

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

# Execution Monitoring

Each delegation returns [Execution: elapsed=Xs, turns=Y, status=ok|error] at top.

Use this to decide:
- status=error: read error, decide — retry with modified task, change approach, or escalate to user
- elapsed > 120s: subagent may be stuck. Consider aborting and retrying simpler
- turns=1: subagent did one turn — check if completed or stuck early
- turns > 10: subagent may be looping. Review output carefully

No automatic retries. Each retry uses modified task based on what failed.

# Blocking Feedback

Messages with customType 'lint'|'error'|'block' are blocking feedback.
STOP, fix reported issues, then proceed. Do not continue until resolved.

# Audit & Issues Review

After each delegation returns, check for **\`\`## Issues\`\`** (under \`\`## Findings\`\`) and **\`\`## Audit\`\`** in its output.

Every problem must be surfaced to the user — even if the subagent found a workaround:

- **problems found in Issues or Audit?** Report as a dedicated message:
  \`\`\`
  ⚠️ Friction encountered:
  - Problem: <what went wrong>
  - Resolution: <how the subagent overcame it>
  - Impact: <delays, scope changes, quality effects>
  \`\`\`

- **scope_stayed = no?** Critical. Show exactly what the subagent did outside scope. User must decide if it's acceptable.

- **no problems + scope_stayed = yes?** No action needed.

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
}): { systemPrompt: string } {
	const { basePrompt, skills, fusionEnabled, pi } = options;

	// Dedup guard: if already has orchestrator prompt (new or old format), return unchanged immediately
	if (basePrompt.includes("You are an orchestrator") || basePrompt.includes("## Orchestrator Mode")) {
		return { systemPrompt: basePrompt };
	}

	// Build new intro replacing pi's hardcoded "You are an expert coding assistant..."
	const ORCHESTRATOR_INTRO = `You are an orchestrator. Delegate only.
Available tools: plan(), plan_add_steps(), insert_step(), delegate(), fusion(), read_skill(), list_skills, list_tools, vision_query.
Use fusion() for multi-model advice before high-cost decisions.
You do NOT have read/bash/grep/find/edit/write for code — use delegate() to access those via specialists.

Pi SDK docs (for reference — delegate to specialists who can read these):
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
		// Pattern failed but marker exists — try simpler replacement (start to first blank line after docs)
		const simplePattern = new RegExp(`[\\s\\S]*?${OLD_INTRO_MARKER}[\\s\\S]*?\\n\\n`, "m");
		baseWithNewIntro = simplePattern.test(basePrompt)
			? basePrompt.replace(simplePattern, ORCHESTRATOR_INTRO + "\n\n")
			: basePrompt; // fallback: don't double-intro
	} else {
		// No old intro at all — prepend orchestrator intro so the model knows its role
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
			? `\n    ⚠ CANNOT: ${missing.join(", ")}`
			: "";
		return `  - **${name}** — ${desc}\n    tools: ${tools}${gapLine}`;
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

	// Dynamic routing: use SPECIALISTS dict when available, ROUTING_TABLE as fallback for tests
	const routingSection = options.pi
		? generateRoutingFromSpecialists()
		: ROUTING_TABLE;

	// Assemble instructions
	const instructions = DELEGATION_INSTRUCTIONS_TEMPLATE
		.replace("{{ROSTER}}", rosterLines)
		.replace("{{ROUTING}}", routingSection)
		.replace("{{SKILLS}}", skillsSection)
		.replace("{{FUSION}}", fusionSection);

	// Token measurement: added ~500 chars (tool docs, scope shape), removed ~2300 chars
	// (TERSE_INSTRUCTION trimmed from ~700 to ~280 × 5 specialists, bash sections removed).
	// Net: approximately -1800 chars (token-negative).
	return {
		systemPrompt: baseWithNewIntro + "\n\n" + instructions + toolsSection + TERSE_INSTRUCTION,
	};
}
