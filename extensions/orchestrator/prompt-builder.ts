/**
 * PromptBuilder — builds the orchestrator system prompt.
 *
 * Extracted from index.ts before_agent_start handler.
 * Generates delegation instructions with specialist roster, skills summary,
 * fusion section, and delegation-specific instructions for orchestrator mode.
 */

import { listSpecialists, SPECIALISTS } from "./specialists.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROUTING_TABLE = `
### Task Routing
| Task type | Specialist | Default skills |
|-----------|------------|----------------|
| Investigate codebase / find files | scout | diagnosing-bugs |
| Implement feature / fix bug | coder | implement, tdd |
| Review code / diff | reviewer | review |
| Research docs / web | researcher | domain-modeling |
| Create/edit docs | writer | agents-md-writer |
| Triage issues | — (inline) | triage |
| Plan refactor / design | — (inline) | grill-with-docs |
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

**ScopeObject shape:**
\`\`\`
{
    filesToModify: ["src/auth.ts"],
    filesToCreate: ["tests/**/*.test.ts"],
    directories: ["src"],
    boundaries?: "do not modify src/legacy"
}
\`\`\`
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

You have ONE tool: \`delegate(specialist, task)\`.
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

{{FUSION}}### Scope requirement:
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

At session start, call read_skill("ask-matt") to determine the workflow for this request. When you encounter /skill-name references in instructions or results, call read_skill("skill-name") to load and follow that skill's methodology.

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

	// Dedup check
	if (basePrompt.includes("## Orchestrator Mode")) {
		return { systemPrompt: basePrompt };
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

	return {
		systemPrompt: basePrompt + "\n\n" + instructions + toolsSection,
	};
}
