# Delegation Workflow

The delegation system is the core of the orchestrator — it's how the central AI agent breaks down complex tasks and dispatches work to specialized subagents with controlled tool access and file scope.

## Entry Point

The orchestrator calls the `delegate()` tool:

```
delegate({
  specialist: "scout",
  task: "Investigate the auth middleware for token expiry bugs",
  scope: { filesToModify: ["src/auth/*.ts"], changeType: "multi-file" }
})
```

**Tool definition**: `/delegate-tool.ts` — defines the `delegate` tool schema and parameter validation.

## Delegation Pipeline

The full pipeline runs through `DelegatePipeline` in `/delegate-pipeline.ts`:

### 1. Validation
- Specialist name must exist in the `SPECIALISTS` registry
- Both `specialist` and `task` are required
- Tilde paths (`~`) expanded in scope file lists
- Read-only specialists (no edit/write tools) skip strict scope validation

### 2. Scope Resolution
- If explicit scope provided → normalized via `ScopeManager.normalizeExplicitScope()`
- If no scope → per-specialist defaults from `scope-policy.ts`:
  - **Coder**: requires explicit scope (returns null → error)
  - **Writer**: default doc-friendly scope (cwd directory, *.md, docs/)
  - **Read-only specialists** (scout/reviewer/researcher): minimal read-only scope
- Scope written to `.pi/scope.json` via `ScopeManager.writeScope()`

### 3. Plan Panel Setup
- Creates plan step for this delegation in Layer 1 widget
- Increments active delegation counter
- Activates the step (shows spinner)

### 4. Subagent Session Creation
`SubagentRunner` in `/subagent-runner.ts` creates an isolated agent session:

- Builds system prompt from specialist definition + skill sections
- Filters tools to specialist's allowed set
- Registers `planSteps`, `advanceStep`, `reportFinding`, `ask_orchestrator` tools
- Sets `PI_ORCHESTRATOR_SUBAGENT` env var to prevent recursive orchestrator registration
- Loads skill packs (SKILL.md files) if available
- Creates session via `createAgentSession()` from the SDK

### 5. Subagent Execution
The subagent runs with:
- **Tool guard** (`subagent-tool-guard.ts`): enforces plan-first, scope, and bash interception
- **Activity feed** (`activity-feed.ts`): renders tool calls as Layer 2 chat blocks
- **Peek overlay** (`peek-overlay.ts`): streams conversation to Ctrl+Q viewer
- **Ask resolver** (`ask-resolver.ts`): handles `ask_orchestrator` calls

### 6. Result Processing
- Output parsed for structured sections (Findings, Audit, Completed, etc.)
- Metrics captured: read/grep/find/edit/write/bash/ls calls, scope violations
- Diagnostic snapshot saved if enabled (turns, tool calls, elapsed time, crash status)

### 7. Cleanup
- Plan step finalized (completed or errored)
- Active delegation counter decremented
- Peek viewer cleared
- Plan auto-cleared if all steps complete

## Tool Guard System

**File**: `/subagent-tool-guard.ts`

The tool guard intercepts every tool call inside a subagent session:

```
tool_call received
  │
  ├─ Plan-first check: if planSteps not called yet → block
  │
  ├─ Bash interception: cat/grep/find/ls → redirect to SDK tools
  │
  ├─ Scope check (for edit/write): read .pi/scope.json, check path
  │   ├─ Allowed → proceed
  │   └─ Blocked → return { block: true, reason: "Scope violation: ..." }
  │
  └─ Fusion check: if fusion tool disabled → block fusion calls
```

### Bash Interception

**File**: `/bash-interceptor.ts`

When a subagent tries to use `bash cat`, `bash grep`, `bash find`, or `bash ls`, the interceptor redirects to the equivalent SDK tool:
- `cat file` → `read({ path: file })`
- `grep pattern` → `grep({ pattern })`
- `find . -name "*.ts"` → `find({ pattern: "*.ts" })`
- `ls dir` → `ls({ path: dir })`

This wastes a turn (the subagent sees the block message and must retry with the right tool) but prevents the common LLM habit of using bash for everything.

## Ask Resolver

**File**: `/ask-resolver.ts`

When a subagent calls `ask_orchestrator({ question, context })`, the resolver attempts auto-resolution before escalating:

1. **File references**: If the question mentions file paths, read those files
2. **Project docs**: Check `docs/` directory for relevant documentation
3. **Conversation context**: Extract answer from recent conversation
4. **Orchestrator escalation**: If none of the above resolves, pause the subagent and forward to the orchestrator

Resolution order ensures most clarifications are handled without human intervention.

## Subagent Diagnostics

**File**: `/subagent-diagnostics.ts`

After each delegation completes (or crashes), a diagnostic snapshot is captured:
- Schema version, session ID, timestamp
- Specialist name, task description
- Turn count, tool call count, elapsed time
- Crash status, output preview
- Per-tool call metrics (read, grep, find, edit, write, bash, ls, scope violations)
- Diagnostic ID, kind (silent_failure or crash)

Diagnostics are persisted to `/diagnostics/<date>/` directory with JSON files.

## Concurrency

Multiple delegations can run concurrently. The plan panel tracks `activeDelegations` counter. Each delegation gets its own:
- Subagent session
- Activity feed state
- Peek viewer state
- Scope file (overwrites `.pi/scope.json` — last writer wins)

**Important caveat**: Because scope is stored in a single `.pi/scope.json` file, concurrent delegations with different scopes can conflict. This is a known limitation.

## Error Handling

| Error | Behavior |
|-------|----------|
| Unknown specialist name | Throws with list of available specialists |
| Missing specialist/task | Throws with usage example |
| Scope violation | Blocked (doesn't crash), subagent continues |
| Subagent crash | Diagnostic captured, plan step marked errored |
| Scope file missing/malformed | All writes blocked (fail-closed) |
| Tool not in specialist's set | Blocked by tool guard |

## Key Source Files

| File | Role |
|------|------|
| `/delegate-tool.ts` | Tool definition, parameter schema |
| `/delegate-controller.ts` | Validation, abort handling |
| `/delegate-pipeline.ts` | End-to-end orchestration |
| `/subagent-runner.ts` | Session creation, tool registration |
| `/subagent-tool-guard.ts` | Tool call interception |
| `/bash-interceptor.ts` | Bash command redirection |
| `/ask-resolver.ts` | Clarification pipeline |
| `/subagent-diagnostics.ts` | Post-run diagnostics |
| `/delegate-feed-builder.ts` | Activity feed integration |
| `/delegate-output-formatter.ts` | Result parsing |
