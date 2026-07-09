# Delegation Workflow

The `delegate` tool is the primary mechanism for the orchestrator to dispatch work to specialist subagents. This page traces the full lifecycle from tool call to result.

## Flow Overview

```
User request
    │
    ▼
Orchestrator decides specialist + task
    │
    ▼
delegate({ specialist, task, skills?, scope? })
    │
    ├── 1. Validation (specialist exists, scope paths valid)
    ├── 2. Scope Resolution (ScopeManager.resolveScope)
    ├── 3. Scope Application (write .pi/scope.json)
    ├── 4. Plan Panel Setup (auto-create if missing)
    ├── 5. Subagent Execution (SubagentRunner.run)
    │       ├── Session creation + environment setup
    │       ├── Activity feed wiring
    │       ├── Tool guard enforcement
    │       └── Tool interception (bash → native tools)
    ├── 6. Diagnostics (detect failures, persist to /diagnostics/)
    ├── 7. Result Formatting (findings, audit, metrics)
    └── 8. Cleanup (clear scope, plan panel, peek overlay)
```

## Step-by-Step

### 1. Tool Registration & Guard

`delegate-tool.ts` registers the `delegate` tool with parameters:
- `specialist` (required): one of `scout`, `coder`, `reviewer`, `researcher`, `writer`
- `task` (required): natural language task description
- `skills` (optional): space-separated skill names
- `scope` (optional): explicit scope manifest (filesToCreate, filesToModify, directories, etc.)

The tool guard in `index.ts` blocks all non-delegation tools at the orchestrator level. Only `delegate`, `plan*`, `fusion`, `read_skill`, `list_skills`, `list_tools`, and `vision_query` pass through.

### 2. Validation & Scope Resolution

In `delegate-pipeline.ts` → `run()`:
1. Validate specialist name exists in roster
2. Validate scope paths are absolute and within cwd
3. Call `ScopeManager.resolveScope()`:
   - If `scope` param provided: normalize to `ResolvedScope`
   - If `specialist` is `coder` and no scope: **block** (coder always needs explicit scope)
   - If `specialist` is read-only: apply read-only default scope
   - Otherwise: proceed without scope

### 3. Scope Application

`ScopeManager.writeScope()` writes `.pi/scope.json` with:
- Schema version for reader validation
- Resolved allowed paths (exact + glob patterns)
- Gate mode derived from `changeType`

**Important:** Scope is cleared (`clearScope()`) after every delegation and in `before_agent_start`, so stale scope never persists.

### 4. Subagent Execution

`subagent-runner.ts` → `runSubagent()`:

1. **Session creation**: Creates isolated SDK session with cleaned environment
2. **Tool filtering**: Only specialist-appropriate tools are registered
3. **Prompt injection**: Builds specialist prompt with:
   - Specialist system prompt
   - Skill instructions (if skills provided)
   - Activity feed instructions (`planSteps()`, `advanceStep()`, `reportFinding()`)
   - Terse response guidelines
   - Scope violation guidance
4. **Activity feed wiring**: Real-time progress updates
5. **Peek overlay**: Live conversation streaming (optional)

### 5. Tool Interception (Inside Subagent)

`subagent-tool-guard.ts` runs inside the subagent session:
- Enforces scope via `ScopeGuard.isPathAllowed()`
- Intercepts bash commands via `bash-interceptor.ts`
  - `cat` → `read`
  - `grep/rg` → `grep`
  - `find` → `find`
  - `ls` → `ls`
  - `sed -i` → `edit`
  - `mkdir/touch` → `write`
  - `rm -rf` → **blocked**
- Plan-first enforcement: subagent must call `planSteps()` before other actions

### 6. Diagnostics

After subagent returns:
- **Silent failure detection**: 0 tool calls or very short output
- **Crash detection**: No output at all
- Failure logs persisted to `/diagnostics/YYYY-MM-DD/{sessionId}/`
- 30-day auto-cleanup

### 7. Result Formatting

`delegate-output-formatter.ts` produces the final output:
- **Findings section**: Extracted from `## Findings` in subagent output
- **Audit trail**: Extracted from `## Audit` section
- **Metrics**: Tool usage counts (read, grep, edit, write, etc.)
- **Duration and token usage**

### 8. Cleanup

- Clear `.pi/scope.json`
- Reset plan panel state
- Close peek overlay

## Ask Flow

For vague or ambiguous requests, `ask-resolver.ts` may route through the `ask_orchestrator` flow:

1. Extract referenced files from the question
2. Search project `docs/` directory
3. Match against recent conversation context
4. If no answer found: escalate to orchestrator for clarification

The resolver returns `"ask"` for vague scopes and `"proceed"` for concrete file specifications.

## Specialist Tool Access

Each specialist gets a different tool set:

| Specialist | Tools |
|-----------|-------|
| **scout** | `read`, `grep`, `find`, `ls`, `git-read`, `gh` |
| **coder** | `read`, `bash`, `edit`, `write`, `lint`, `grep`, `find` |
| **reviewer** | `read`, `bash`, `grep`, `find` |
| **researcher** | `web_search`, `fetch_content`, `ls`, `grep` |
| **writer** | `read`, `write`, `edit`, `ls`, `find` |

See [Specialists & Skills](../domain/specialists-and-skills.md) for full details.

## What to Watch Out For

- **Coder scope is mandatory**: If you delegate to `coder` without a scope, the pipeline blocks. This is intentional.
- **Scope is ephemeral**: `.pi/scope.json` is cleared after every delegation. Don't depend on it persisting.
- **Bash interception is heuristic**: `bash-interceptor.ts` uses heuristics to detect file writes in bash commands. Edge cases exist — check the interception logic if bash commands behave unexpectedly.
- **Metrics tracking**: `delegate-pipeline.ts` wraps the `onUpdate` callback to count tool calls. If you add new tools, the metrics may need updating.
- **Diagnostics directory**: Check `/diagnostics/` for subagent failures. Logs auto-clean after 30 days.
