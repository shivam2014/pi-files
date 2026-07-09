# Specialists & Skills

The orchestrator delegates work to **specialists** — pre-defined roles with specific tool access and system prompts. **Skills** are modular instruction sets that can be loaded into any specialist's context.

## Specialist Roster

Defined in `specialists.ts` as the `SPECIALISTS` constant:

| Specialist | Purpose | Tools |
|-----------|---------|-------|
| **scout** | Read-only investigation | `read`, `grep`, `find`, `ls`, `git-read`, `gh` |
| **coder** | Full implementation | `read`, `bash`, `edit`, `write`, `lint`, `grep`, `find` |
| **reviewer** | Code review | `read`, `bash`, `grep`, `find` |
| **researcher** | Web research | `web_search`, `fetch_content`, `ls`, `grep` |
| **writer** | Documentation | `read`, `write`, `edit`, `ls`, `find` |

### Specialist Structure

Each specialist defines:
- `name`: Identifier (matches tool parameter)
- `tools`: Allowed tool names
- `suggestedSkills`: Default skills to load
- `systemPrompt`: Base prompt for the specialist

### Tool Access

Tool access is enforced at the SDK level — only registered tools are available to the subagent. The orchestrator filters tools before creating the subagent session.

### Scope Defaults

- **coder**: Requires explicit scope (mandatory)
- **writer**: Gets doc-friendly default scope from `scope-policy.ts`
- **scout, reviewer, researcher**: Read-only default scope

## Skill System

Skills are modular instruction sets stored in `~/.pi/agent/skills/<name>/SKILL.md`.

### Skill Resolution

`skill-resolver.ts` → `resolveSkill(name)`:
1. Validates skill name (lowercase, letters/digits/hyphens only)
2. Resolves path: `~/.pi/agent/skills/{name}/SKILL.md`
3. Reads file, parses frontmatter for:
   - `name`: Display name
   - `description`: Brief description
   - `disable-model-invocation`: Whether to disable model invocation
4. Returns `SkillResult` with skill body or error

### Skill Loading

`read-skill-tool.ts` registers the `read_skill` tool:
- Blocks path traversal (`..`, `/`, `\`)
- Sandbox check: ensures path stays under `skillsDir`
- Returns full SKILL.md contents

### Skill Discovery

`introspection-tools.ts` registers `list_skills`:
- Scans `~/.pi/agent/skills/` for subdirectories
- Reads frontmatter for names/descriptions
- Returns bulleted list

### Per-Delegation Skills

Skills can be loaded per-delegation via the `skills` parameter on `delegate()`:
```
delegate({ specialist: "coder", task: "...", skills: "lint-typescript security-audit" })
```

Skills are resolved and injected into the subagent prompt as additional instructions.

## Prompt Construction

`specialists.ts` → `buildSkillSection()`:
- Generates skill instructions for subagent prompts
- Includes skill body content
- Injected into the specialist's system prompt

`prompt-builder.ts` → `buildOrchestratorPrompt()`:
- Replaces base agent prompt with delegation-focused instructions
- Includes specialist roster documentation
- Includes activity feed instructions
- Includes scope violation guidance

## Activity Feed Instructions

Subagents receive instructions for the activity feed system:

```
ACTIVITY_FEED_INSTRUCTION:
- Use planSteps() to declare what you'll do
- Use advanceStep() to move to next step
- Use reportFinding() to report discoveries
```

## Terse Response Guidelines

`TERSE_INSTRUCTION` provides caveman-style response guidelines:
- Short, direct responses
- No unnecessary explanation
- Focus on tool calls and results

## What to Watch Out For

- **Specialist names are case-sensitive**: Must match exactly (lowercase)
- **Coder scope is mandatory**: No scope = blocked delegation
- **Skills are ephemeral**: Loaded per-delegation, not persisted
- **Tool documentation is dynamic**: `updateToolDocs()` refreshes from SDK registry at runtime
- **Skill name validation**: Only lowercase letters, digits, and hyphens allowed
- **Skill path sandboxing**: `read_skill` blocks path traversal

## Related Files

- `/specialists.ts` — Roster, prompt construction, tool docs
- `/skill-resolver.ts` — Skill resolution logic
- `/read-skill-tool.ts` — `read_skill` tool
- `/introspection-tools.ts` — `list_skills`, `list_tools`
- `/prompt-builder.ts` — Orchestrator prompt injection
- `/specialists.test.ts` — Specialist tests
- `/specialist-skills.test.ts` — Skill tests
- `/skill-resolver.test.ts` — Resolver tests
- `/read-skill-tool.test.ts` — Tool tests
- `/docs/agents/domain.md` — Domain documentation
- `/docs/prd/prd-skill-aware-delegation.md` — Skill-aware delegation PRD
