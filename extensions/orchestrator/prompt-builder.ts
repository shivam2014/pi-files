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
| Review code / diff | reviewer | review |
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
		return `| ${spec.description} | ${name} | ${skills} |`;
	}).join("\n");

	return `
### Task Routing
| Task type | Specialist | Default skills |
|-----------|------------|----------------|
${rows}
`;
}

const FUSION_INSTRUCTION = `### Fusion Tool\nAfter scout/researcher return findings, call:\nfusion({ context: findings, task: "create execution plan", draft_plan: "your preliminary plan" })\nfor multi-model advice. The panel (2-3 different models) critiques your plan, a judge identifies contradictions and blind spots. Use this before delegating to coder for complex, high-stakes decisions.\n\nWhen to use fusion:\n- After gathering research findings, before writing the final plan\n- When the plan has high cost of error (destructive operations, broad file changes)\n- When you need multiple perspectives on architectural decisions\n\nWhen to skip fusion:\n- Simple, tactical tasks with clear solutions\n- After delegation results that are straightforward\n`;

const DELEGATION_INSTRUCTIONS_TEMPLATE = `
## Orchestrator Mode — DELEGATE ONLY

You are an expert coding assistant operating in **orchestrator mode**. In this mode, your role shifts from direct execution to delegation management — you direct specialist agents who do the hands-on work.

### Your tool: delegate(specialist, task)

Your main tool: \`delegate(specialist, task)\`.
Call it once per step. Review the output. Then call it again for the next step.

You do NOT have read, bash, grep, find, edit, or write tools in this mode.
You CANNOT access files or run commands directly.

### Specialist roster:
{{ROSTER}}
{{ROUTING}}{{SKILLS}}

### Workflow:
1. FIRST: Call plan(goal, steps) to declare the overall plan. The goal is a one-line summary. The steps are the actions you will delegate. Example:
   plan("Fix auth bug", ["Read auth middleware", "Fix token validation", "Write tests", "Verify"])

2. SECOND: For each step, call delegate(specialist, task, scope) to execute work. Optionally pass skills: string[] to override the specialist's default skill pack(s) for this delegation.

3. THIRD: Synthesize results.

NOTE: You MUST call plan() before delegate(). delegate() will reject if no active plan exists.

{{FUSION}}

### Scope requirement:
When calling delegate(coder|writer|reviewer, ...), you MUST include a \`scope\` parameter with the files the specialist is allowed to modify/create and any boundaries.
// Scout and researcher are read-only — scope optional

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

You decide next step AFTER seeing previous result. NOT before.

## Skill Routing

Load workflow: \`read_skill("ask-matt")\` at session start.
When you see /skill-name references, call \`read_skill("skill-name")\` to load and follow that skill's methodology.
If a skill references another skill internally, load that too via \`read_skill()\`. Skills form a graph, not a list.

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
 * Deduplicates: if basePrompt already contains `## Orchestrator Mode`, returns it unchanged.
 */
export function buildOrchestratorPrompt(options: {
	basePrompt: string;
	skills?: Array<{ name: string; description?: string }>;
	fusionEnabled?: boolean;
	/** SDK reference for dynamic tool documentation generation */
	pi?: ExtensionAPI;
}): { systemPrompt: string } {
	const { basePrompt, skills, fusionEnabled, pi } = options;

	// Dedup guard: if already has orchestrator mode, return unchanged immediately
	if (basePrompt.includes("## Orchestrator Mode")) {
		return { systemPrompt: basePrompt };
	}

	// Build new intro replacing pi's hardcoded "You are an expert coding assistant..."
	const ORCHESTRATOR_INTRO = `You are an expert AI assistant operating in **orchestrator mode** inside pi coding agent. In this mode, your role shifts from direct execution to delegation management — you direct specialist agents who do the hands-on work for you. You do not read files, edit code, or run commands yourself.

Pi coding agent documentation (available on request):
- Main: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
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
		// No old intro at all — use basePrompt as-is
		baseWithNewIntro = basePrompt;
	}

	// Build dynamic specialist roster
	const rosterLines = listSpecialists().map(name => {
		const spec = SPECIALISTS[name];
		const tools = spec.tools.join(", ");
		const desc = spec.description ? ` ${spec.description}` : "";
		return `  - **${name}** — tools: ${tools}${desc}`;
	}).join("\n");

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
