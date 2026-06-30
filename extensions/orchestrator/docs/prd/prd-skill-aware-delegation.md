## Problem Statement

The orchestrator extension has installed skills (`implement`, `tdd`, `review`, `diagnosing-bugs`, `domain-modeling`, `agents-md-writer`, `ask-matt`, etc.) from mattpocock's skills repository. These skills provide structured methodologies for different types of work. However:

1. **Orchestrator cannot read skills.** `setActiveTools(["plan", "delegate"])` in `index.ts` strips the `read` tool from the orchestrator's agent session. The `tool_call` guard blocks all tool calls except `plan`/`delegate`/`fusion`. The `<available_skills>` XML block is never generated in the orchestrator's system prompt because `formatSkillsForPrompt()` checks for the `read` tool. The orchestrator LLM has no awareness of installed skills.

2. **Subagents don't get skills registered.** `subagent-runner.ts` creates a fresh `DefaultResourceLoader` without passing `additionalSkillPaths`. The `skills[]` parameter is only used to inject a text reference list into the system prompt. Skills are never loaded into the resource loader, so `/skill:name` expansion doesn't work and `<available_skills>` XML is never generated in subagent system prompts.

3. **Specialist prompts don't enforce skills.** The specialist definitions in `specialists.ts` list default skills (`coder → implement, tdd`) but their system prompts never reference or mandate following those skill methodologies. The skills exist on disk but are invisible to the agents.

4. **`skills` override replaces defaults.** The `delegate()` `skills` parameter replaces (not appends to) the specialist's default skills. A caller passing `skills: ["review"]` to `coder` loses `implement`/`tdd` entirely.

5. **Missing domain vocabulary.** The `CONTEXT.md` glossary has no terms for skills, skill loading, skill injection, `read_skill`, or the ask-matt routing flow.

6. **Plan lifecycle is brittle.** Once `plan()` is called, the orchestrator cannot add steps mid-plan. When a delegation reveals new work, the orchestrator must abandon the current plan and create a new one. The plan also auto-completes when all steps finish, causing the next `delegate()` to fail with "No active plan" until a new `plan()` is called.

7. **Orchestrator has no active introspection.** The `<available_skills>` XML is passive (model sees it but can't query). There is no `list_skills()` or `list_tools()` tool for the orchestrator to dynamically discover what's available at runtime.

## Solution

1. **Add `read_skill` tool to orchestrator.** A scoped tool that reads `SKILL.md` files by name (`read_skill("ask-matt")` → `~/.pi/agent/skills/ask-matt/SKILL.md`). Path-sandboxed to the skills directory. This gives the orchestrator skill access without allowing arbitrary file reads (preserving scout's role for codebase investigation).

2. **Register `read_skill` in active tools.** Add `"read_skill"` to `setActiveTools()` and whitelist it in the `tool_call` guard in `index.ts`. This causes `formatSkillsForPrompt()` to generate the `<available_skills>` XML in the orchestrator's system prompt for all installed skills.

3. **Orchestrator uses ask-matt for routing.** Update the orchestrator's system prompt to instruct: *"Always start by reading `read_skill("ask-matt")` and follow the ask-matt methodology to determine the correct flow, then call `plan()` and `delegate()` accordingly."*

4. **Register skills in subagent resource loader.** In `subagent-runner.ts`, resolve skill names from the `skills[]` parameter to their `SKILL.md` file paths and pass them via `additionalSkillPaths` to `DefaultResourceLoader`. This enables `<available_skills>` XML in subagent system prompts and makes `/skill:name` expansion work.

5. **Update specialist system prompts.** Each specialist's `systemPrompt` gets a skill enforcement section generated dynamically from their `skills[]` array. For `coder`: *"You MUST read and follow the `implement` and `tdd` skills using the `read` tool before starting work. Do not skip steps."*

6. **Fix `skills` override to merge.** Change `getSpecialistSkills()` to merge the override array with defaults (deduped) instead of replacing. Add a `disableDefaults` flag for callers that want full replacement.

7. **Update CONTEXT.md.** Add domain terms: Skill File, Skill Name, Skill Registration, Skill-Forced Delegation, `read_skill` tool, ask-matt routing, Skill Enforcement.

## User Stories

1. As the orchestrator, I want to read the `ask-matt` skill, so that I can determine the correct workflow for each user request.
2. As the orchestrator, I want skills listed in my system prompt as `<available_skills>`, so that I know what skills are available without guessing.
3. As a coder subagent, I want the `implement` and `tdd` skills registered in my resource loader, so that I can read their methodologies via the `read` tool.
4. As a coder subagent, I want my system prompt to tell me to follow the `implement` and `tdd` skills, so that I have a structured methodology enforced.
5. As a scout subagent, I want the `diagnosing-bugs` skill registered in my resource loader, so that I can follow its bug diagnosis loop.
6. As a reviewer subagent, I want the `review` skill registered in my resource loader, so that I can follow its review methodology.
7. As a researcher subagent, I want the `domain-modeling` skill registered in my resource loader, so that I can follow its domain modeling approach.
8. As a writer subagent, I want the `agents-md-writer` skill registered in my resource loader, so that I can follow its documentation methodology.
9. As a developer calling `delegate("coder", task, { skills: ["review"] })`, I want the coder to retain its default `implement` and `tdd` skills PLUS `review`, so that existing behavior isn't silently lost.
10. As a developer calling `delegate("coder", task, { skills: ["review"], disableDefaults: true })`, I want the defaults to be replaced, so that I can narrow the subagent's scope when needed.
11. As the orchestrator, I want to read a skill only when needed via `read_skill(name)`, so that full skill content isn't bloating my system prompt.
12. As a developer updating a skill on disk, I want the next invocation of `read_skill` or `read` tool to pick up the changes immediately, so that I don't need to restart sessions.
13. As a maintainer, I want the orchestrator's tool set to remain minimal (`plan`, `delegate`, `fusion`, `read_skill` only), so that the orchestrator doesn't bypass scout for codebase investigation.
14. As a maintainer, I want the `read_skill` tool path-sandboxed to `~/.pi/agent/skills/`, so that it cannot be used to read arbitrary files.
15. As a developer, I want the orchestrator's system prompt to explicitly say "use ask-matt for routing," so that the structured flow is enforced at the top level.
16. As a developer, I want the `CONTEXT.md` updated with new skill-related domain terms, so that the project vocabulary stays consistent.

17. As an orchestrator, I want to delegate simple read-only tasks to scout without specifying filesToModify/filesToCreate in scope, so that I'm not blocked by scope validation for non-modification tasks.

18. As an orchestrator, I want to add new steps to an active plan mid-execution, so that I can adapt to new findings without restarting the plan.
19. As an orchestrator, I want the plan to stay active after all steps finish, so that I can delegate additional work without re-declaring the plan.
20. As an orchestrator, I want to list all available skills at runtime via a tool call, so that I can dynamically discover what skills are available.
21. As an orchestrator, I want to list all available tools at runtime via a tool call, so that I can decide which tools to use without hardcoding.

## Implementation Decisions

### read_skill tool (index.ts)

- Registered in the orchestrator's `registerTools()` call in `index.ts`.
- Takes a single `name` parameter (string).
- Resolves the path as `join(getAgentDir(), "skills", name, "SKILL.md")`.
- Returns `readFileSync` content as text.
- Returns error message for unknown/non-existent skills.
- Path-sandboxed: the resolution logic ensures only the skills directory is accessible. Directory traversal via `../` in the name is prevented by the join resolution.
- Added to `setActiveTools(["plan", "delegate", "read_skill"])`.
- Whitelisted in the `tool_call` guard alongside `delegate`, `plan`, `fusion`.

### Subagent resource loader (subagent-runner.ts)

- After resolving skill names via `getSpecialistSkills()`, resolve each name to `join(getAgentDir(), "skills", name, "SKILL.md")`.
- Filter to only paths that exist on disk.
- Pass the array as `additionalSkillPaths` in the `DefaultResourceLoader` constructor.
- Remove the manual "Available Skills" text reference injection — the SDK's `formatSkillsForPrompt()` now handles this automatically.

### Specialist system prompt enforcement (specialists.ts)

- Each specialist's `systemPrompt` gains a skill enforcement section at the end.
- The section is generated from the specialist's `skills[]` array:
  ```
  CRITICAL: You MUST read and follow these skills using the read tool:
    - /path/to/skill/name/SKILL.md
  
  Read each skill now before starting work. Do not skip steps.
  ```
- This is NOT hardcoded per specialist. It's generated from the `skills[]` array so it stays in sync automatically.

### skills override merge (delegate-controller.ts)

- `getSpecialistSkills()` in `specialists.ts` changes: when an override is provided, merge with defaults (deduped).
- New parameter `disableDefaults` on `delegate()`: if true, override replaces defaults (current behavior).
- Backward-compatible: existing callers that pass `skills: []` will still get all defaults.

### Delegation scope friction for read-only tasks

- Scout, reviewer, and researcher are read-only specialists (no `edit`/`write` tools), but the `scope` parameter requires `filesToModify` and `filesToCreate` fields.
- This causes delegation failures when the orchestrator tries to delegate simple `gh` or `read` tasks — scout refuses with "Scope is vague" because the orchestrator can't provide meaningful file lists for a read-only investigation.
- The scope validation in `delegate-controller.ts` should distinguish between read-only toolsets (scout/reviewer/researcher) and modification-capable toolsets (coder/writer). For read-only specialists, `filesToModify: []` and `filesToCreate: []` should be the default, not a required explicit field.
- Resolution path: detect the specialist's tool set. If the specialist lacks `edit`/`write` tools, relax the scope requirement to allow empty file lists.

### Plan lifecycle management

- After all declared steps complete, the plan should remain active (not auto-complete) so the orchestrator can continue delegating.
- The orchestrator should be able to add new steps to an active plan via a `plan_add_steps` tool or similar mechanism.
- The plan's progression is driven by the orchestrator's `advanceStep` calls, not by step completion count.
- Backward compatible: existing plans continue to work, the change is in how completion is detected.

### Orchestrator introspection tools

- Add a `list_skills` tool: returns names and descriptions of all installed skills in `~/.pi/agent/skills/`.
- Add a `list_tools` tool: returns the orchestrator's currently active tool set.
- These are complementary to the passive `<available_skills>` XML — the model can query dynamically when needed.
- Implementation: `list_skills` scans `~/.pi/agent/skills/` for SKILL.md files and parses frontmatter for name + description. `list_tools` returns `setActiveTools` array.

### Domain glossary (CONTEXT.md)

- Add terms: Skill File, Skill Name, Skill Registration, Skill-Forced Delegation, `read_skill` tool, ask-matt routing, Skill Enforcement.
- Each term follows the existing glossary format (purpose, boundaries, relationships).

## Testing Decisions

### High seam: subagent-runner.test.ts

- Test that `DefaultResourceLoader` receives `additionalSkillPaths` with resolved SKILL.md paths when `skills[]` is provided.
- Test that no skill paths are passed when `skills[]` is empty.
- Test that non-existent skill paths are filtered out.

### read_skill tool test

- Test that valid skill name returns SKILL.md content.
- Test that unknown skill name returns error message.
- Test that path traversal attempts (e.g., `read_skill("../src/index.ts")`) are blocked.

### index.ts tool registration test

- Test that `setActiveTools` includes `read_skill`.
- Test that the `tool_call` guard allows `read_skill`.

### specialist prompt test

- Test that each specialist's system prompt includes the skill enforcement section.
- Test that the enforcement section references the correct skill names from the specialist's `skills[]` array.

### CONTEXT.md test

- Test that new domain terms exist in the glossary.

## Out of Scope

- Modifying the original `SKILL.md` files from mattpocock's repository.
- Adding new skills or modifying skill methodology.
- Full auto-injection of skill content into system prompt (uses on-demand `read` tool instead).
- Changes to the pi SDK itself (all changes are within the orchestrator extension).
- Changes to the `/skill:name` user-side expansion in pi SDK (it's a user shortcut, not relevant to model-side skill access).

## Further Notes

- Skills are read from disk on every invocation (`read_skill` and `read` tool both use `readFileSync`). No caching. Updates to skills are picked up immediately.
- The `read_skill` tool is narrow by design: only `SKILL.md` files under `~/.pi/agent/skills/` can be read. All codebase investigation still goes through `delegate("scout", ...)`.
- Subagents retain full system tool access (`read`, `bash`, `grep`, etc.) — only the orchestrator has restricted tools.
- The ask-mart skill is installed at `~/.pi/agent/skills/ask-matt/SKILL.md`. When the orchestrator reads it, it gets the full flow definition (main flow: idea→ship, on-ramps for bugs, standalone skills). The orchestrator follows this flow to determine whether to grill, implement, triage, etc.
- ADR 0004 should be created to document the skill-aware delegation architecture decision.
