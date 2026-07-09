# Specialists & Skills

## The Five Specialists

The orchestrator routes tasks to one of five built-in specialist roles. Each specialist has a defined tool set, system prompt, and optional skill pack.

**Registry**: `/specialists.ts` — the `SPECIALISTS` record.

### Specialist Roster

| Specialist | Role | Tools | Skills | Writes? |
|-----------|------|-------|--------|---------|
| **Scout** | Read-only codebase investigator | read, grep, find, ls, git-read, gh | diagnosing-bugs | No |
| **Coder** | Implementation specialist | read, bash, edit, write, grep, lint, find, ls | implement, tdd | Yes |
| **Reviewer** | Read-only code reviewer + bash diagnostics | read, bash, grep | code-review | No |
| **Researcher** | Web + docs researcher | read, web_search, fetch_content, ls, grep, git-read, find | domain-modeling | No |
| **Writer** | Documentation specialist | read, write, edit, ls, find, git-read | agents-md-writer | Yes |

### Routing Table

The orchestrator uses this routing table (generated dynamically from `SPECIALISTS` in `prompt-builder.ts`):

| Task type | Specialist | Default skills |
|-----------|------------|----------------|
| Investigate codebase / find files | scout | diagnosing-bugs |
| Implement feature / fix bug | coder | implement, tdd |
| Review code / diff / run bash diagnostics | reviewer | review |
| Research docs / web | researcher | domain-modeling |
| Create/edit docs | writer | agents-md-writer |

## Specialist System Prompts

Each specialist has a comprehensive system prompt assembled from template literals in `/specialists.ts`:

1. **Activity Feed Instruction** (`ACTIVITY_FEED_INSTRUCTION`): Defines the planSteps → execute → advanceStep workflow
2. **Role-specific instructions**: What the specialist does, output format, rules
3. **Findings & Audit template** (`FINDINGS_AUDIT_TEMPLATE`): Structured reporting sections
4. **Tool documentation**: Generated from `generateToolDoc()` or `generateToolDocFromApi()`
5. **Terse instruction** (`TERSE_INSTRUCTION`): "Caveman" response style — completeness without verbosity
6. **Scope violation guidance** (write specialists only): How to handle blocked operations

### Minimal Action Discipline

Injected into Scout and Coder prompts:
> Before each tool call, ask: what is the single smallest action that answers THIS step?
> If you have read more than 3 files without narrowing the question, STOP and call ask_orchestrator.
> Broad exploration is drift, not diligence.

### Goal-Achieved Early Stop

> Once you have achieved the task goal, STOP and report back to the orchestrator. Do NOT execute remaining planned steps just because they were listed.

## Tool Documentation Generation

Two generators exist:

### Legacy: `generateToolDoc()`
Hardcoded syntax maps for SDK built-in tools. Used at module load time before pi instance is available.

### Runtime: `generateToolDocFromApi()`
Reads tool syntax from `parameters` schema and output format from `promptGuidelines` in the live pi tool registry. Called by `updateToolDocs(pi)` at session start.

Both produce markdown lines like:
```
Your available tools:
- `read({ path, offset?, limit? })`
  Returns file content. Text files: content with line numbers...
```

## Skills System

Skills are SKILL.md files loaded at runtime via `read_skill()`. They provide task-specific instructions that complement the specialist's base prompt.

### Skill Resolution

**File**: `/skill-resolver.ts`

Resolves skill names to SKILL.md paths under `~/.pi/agent/skills/<name>/SKILL.md`. Filters out skills whose file doesn't exist on disk.

### Skill Loading

**File**: `/read-skill-tool.ts`

The `read_skill(name)` tool loads a SKILL.md file and returns its contents. Subagents call this at the start of their execution to load relevant skill instructions.

### Skill Assignment

Skills are **task-driven, not role-bound**. The specialist's `suggestedSkills` field provides recommendations, but the subagent selects based on the actual task. The prompt says:
> If your task below explicitly names a skill (e.g., /skill-name), load it via read_skill() and follow its instructions.
> Otherwise, scan the available skills below and pick the best match for your task.

### SDK Skill Discovery

Skills are also registered with the SDK via `resources_discover` event in `index.ts`. This allows the SDK to discover and list available skills.

## Tool Access Matrix

### Scout (Read-Only)
- `read` — examine files
- `grep` — search code contents
- `find` — locate files by name/pattern
- `ls` — list directories
- `git-read` — read files at git refs
- `gh` — GitHub CLI
- ❌ No bash, edit, or write

### Coder (Full Access)
- `read` — examine files
- `bash` — run tests, compilation, gh CLI only
- `edit` — modify files
- `write` — create files
- `grep` — search code
- `lint` — check syntax
- `find` — locate files
- `ls` — list directories
- ⚠️ Never bash+sed/awk/perl/python for file operations

### Reviewer (Read-Only + Bash)
- `read` — examine files
- `bash` — run diagnostic commands (curl endpoints, check ports, read configs, run CLIs)
- `grep` — search code
- ❌ No edit or write
- Gets auto-defaulted read-only scope (no explicit `scope` parameter needed)
- Handles all read-only bash diagnostics — use instead of coder for curl/lsof/cat/CLI tasks

### Researcher (Read-Only + Web)
- `read` — examine files
- `web_search` — search the web
- `fetch_content` — fetch web pages
- `ls`, `grep`, `git-read`, `find` — local investigation
- ❌ No bash, edit, or write

### Writer (Doc-Focused Write)
- `read` — examine files
- `write` — create doc files
- `edit` — modify doc files
- `ls`, `find` — browse directories
- `git-read` — read git history
- ❌ No bash

## Key Source Files

| File | Role |
|------|------|
| `/specialists.ts` | Specialist definitions, system prompts, tool docs |
| `/skill-resolver.ts` | Skill path resolution |
| `/read-skill-tool.ts` | read_skill() tool |
| `/prompt-builder.ts` | Orchestrator prompt with routing table |
