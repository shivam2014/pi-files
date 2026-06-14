# Orchestration TUI — Design Spec

> **Single source of truth.** Code comments may be stale. Always refer here.

## Overview

The orchestrator extension turns Pi into a pure orchestrator. The main agent never touches files directly. It plans, delegates to specialist subagents one at a time, reviews results, and decides the next step.

**One tool: `delegate(specialist, task)`** — called once per step.

---

## Architecture

```
User task
  ↓
before_agent_start
  → Clear old plan panel
  → Show goal + "Planning..." placeholder
  → Strip tools to delegate-only (selectedTools)
  → Inject orchestrator system prompt
  ↓
LLM calls delegate(scout, "investigate ...")
  ↓
delegate execute handler
  → Set up plan panel with specialist step
  → runSubagent(scout, task)
    → Env var guard skips orchestrator registration for subagent
    → Subagent gets full tool access (read, bash, edit, write)
    → Activity feed streams progress
  → Return output to orchestrator
  → Update plan panel: ✓ with duration
  ↓
LLM reviews output, calls delegate(coder, "implement ... based on: [above]")
  ↓
Repeat until done
  ↓
LLM synthesizes final answer
```

---

## Layer 1: Orchestration Plan (Header)

### Location
Replaces Pi's built-in header via `pi.setHeader(factory)`.
Pinned at top. Never scrolls. Visible until next task.

### Lifecycle

| Event | Action |
|-------|--------|
| `before_agent_start` | Clear old plan. Show goal + "Planning..." placeholder. |
| `delegate(specialist, task)` called | Replace placeholder with `✓ Specialist: task` step. Start elapsed timer. |
| Subagent completes | Update step to ✓ with duration. Update progress dots. |
| All steps done | All show ✓. Timer stops. Panel stays visible. |
| User types next task | `before_agent_start` → `setHeader(undefined)` → old plan gone. |

### Visual

```
┌─ Orchestration Plan ──────────────────────────────┐
│ Goal: add browsing to pi with cloakbrowser          │
│  ✓ Scout: Check cloakbrowser API                    │
│  ⠋ Coder: Implement browse integration              │
│  ○ Reviewer: Review implementation                   │
│  ●●● [1/3]      •    Elapsed: 45s                   │
└─────────────────────────────────────────────────────┘
```

### Elements

| Element | Content | Source |
|---------|---------|--------|
| Header | `┌─ Orchestration Plan ──┐` | Static decoration |
| Goal | `Goal: <task description>` | From user prompt (shortened) |
| Steps | `✓ Scout: Check cloakbrowser API` | Specialist name + task, added as each `delegate()` is called |
| Progress dots | `●●● [1/3]` | Filled = completed. Current = spinner. Empty = pending. |
| Elapsed | `Elapsed: 45s` | Live counter via `setInterval(1s)` |

### Step format
Each step shows `<Specialist>: <task description>`.
Specialist name is capitalized. Task is truncated to fit panel width.

### Status Transitions

```
Initial:        ⠋ Planning...                                ○ [0/1]  Elapsed: 0s
Delegate 1:     ✓ Scout: Check API                           ● [1/1]  Elapsed: 14s
Delegate 2:     ✓ Scout: Check API                           ● [1/2]  Elapsed: 16s
                ⠋ Coder: Implement...
Delegate 3:     ✓ Scout: Check API                           ●● [2/3]  Elapsed: 45s
                ✓ Coder: Implement...
                ⠋ Reviewer: Review...
Done:           ✓ Scout: Check API                           ●●● [3/3]  Elapsed: 58s
                ✓ Coder: Implement...
                ✓ Reviewer: Review...
```

---

## Layer 2: Subagent Tool Blocks (Chat History)

### Location
Standard `ToolExecutionComponent` with `renderShell: "self"`.
Renders in chat area below plan panel. Scrollable. Permanent.

### Visual — During execution

```
╭─ Scout ───────────────────────────────────────────────╮
│ ┌─ Task ───────────────────────┐                       │
│ │ Check cloakbrowser API        │                       │
│ └──────────────────────────────┘                       │
│ ●●● [3/3]                                              │
│ ✓ scan pi web tools (8s)                                │
│ ✓ check cloakbrowser api (12s)                          │
│ ⠋ synthesize findings...                                │
╰────────────────────────────────────────────────────────╯
```

### Visual — After completion

```
╭─ Scout ───────────────────────────────────────────────╮
│ ┌─ Task ───────────────────────┐                       │
│ │ Check cloakbrowser API        │                       │
│ └──────────────────────────────┘                       │
│ ●●● [3/3]                                              │
│ ✓ scan pi web tools (8s)                                │
│ ✓ check cloakbrowser api (12s)                          │
│ ✓ synthesize findings (5s)                              │
╰────────────────────────────────────────────────────────╯
```

**Key rule: Activity feed NEVER collapses.** During and after: same layout.
- During: current step shows `⠋` spinner
- After: all steps show `✓` with durations

### Elements

| Element | Content | Source |
|---------|---------|--------|
| Header | `╭─ Scout ──╮` | Specialist name (NOT "delegate") |
| Task box | `┌─ Task ──┐ / │ Check... │ / └──┘` | From subagent activity feed |
| Progress dots | `●●● [3/3]` | From activity feed |
| Steps | `✓ scan pi web tools (8s)` | From activity feed |
| Spinner | `⠋` on current step | From activity feed |

---

## Full Terminal Layout

```
┌─ Orchestration Plan ──────────────────────────────┐  ← PINNED (setHeader)
│ Goal: add browsing to pi with cloakbrowser          │    NEVER scrolls
│  ✓ Scout: Check cloakbrowser API                    │
│  ✓ Coder: Implement browse integration              │
│  ○ Reviewer: Review implementation                   │
│  ●●○ [2/3]      •    Elapsed: 45s                   │
├─────────────────────────────────────────────────────┤
│                                                     │  ← Chat area
│ ╭─ Scout ────────────────────────────────────────╮  │    Scrolls below plan
│ │ ┌─ Task ───────────────┐                       │  │
│ │ │ check cloakbrowser    │                       │  │
│ │ └──────────────────────┘                       │  │
│ │ ●●● [3/3]                                      │  │
│ │ ✓ scan pi web tools (8s)                        │  │
│ │ ✓ check cloakbrowser api (12s)                  │  │
│ │ ✓ synthesize findings (5s)                      │  │
│ ╰────────────────────────────────────────────────╯  │
│                                                     │
│ ╭─ Coder ────────────────────────────────────────╮  │
│ │ ┌─ Task ───────────────┐                       │  │
│ │ │ implement browse      │                       │  │
│ │ └──────────────────────┘                       │  │
│ │ ●○ [1/2]                                       │  │
│ │ ✓ read cloakbrowser files (3s)                  │  │
│ │ ⠋ write integration code...                     │  │
│ ╰────────────────────────────────────────────────╯  │
│                                                     │
│ ✓ Orchestrator synthesized: The best way to add...  │
├─────────────────────────────────────────────────────┤
│ > _                                                 │  ← Editor bar
└─────────────────────────────────────────────────────┘
```

---

## Orchestrator Enforcement

Two layers prevent the main agent from doing work directly:

### 1. System Prompt (soft)
`before_agent_start` injects instructions:
```
Your tool: delegate(specialist, task)
You have ONE tool. Call it once per step. Review output. Call again.
```

### 2. selectedTools (prompt-level)
`event.systemPromptOptions.selectedTools = ["delegate"]`
Removes all other tools from the "Available tools" section the LLM sees.

### 3. tool_call block (hard)
`tool_call` handler blocks any tool that isn't `delegate`:
```js
if (event.toolName !== "delegate") {
    return { block: true, reason: "Orchestrator mode: use delegate()" };
}
```

---

## Subagent Isolation

Subagents must NOT get orchestrator restrictions. They need full tool access.

### Problem
Pi loads extensions via jiti (fresh module scope per `DefaultResourceLoader.reload()`).
Module-level `_batchLoadSubagent` counter doesn't survive reloads.

### Solution
`process.env.PI_ORCHESTRATOR_SUBAGENT = "1"` set before `loader.reload()`.
Checked at extension entry point — survives jiti module reloads.

### Flow
```
runSubagent():
  process.env.PI_ORCHESTRATOR_SUBAGENT = "1"   ← SET
  DefaultResourceLoader.reload()                 ← loads orchestrator.ts fresh
    → isSubagentContext() checks env var
    → returns early (no orchestrator handlers registered)
  delete process.env.PI_ORCHESTRATOR_SUBAGENT   ← CLEARED (finally block)
  createAgentSession({ tools: specialist.tools })
    → Subagent has: read, bash, edit, write (specialist tools)
    → Subagent does NOT have: orchestrator blocking
```

---

## Specialist Roster

| Specialist | Tools | Use for |
|-----------|-------|---------|
| scout | read, bash | Fast codebase investigation |
| coder | read, bash, edit, write | Implementation |
| reviewer | read, bash | Code review |
| researcher | read, bash | Question answering |
| writer | read, write, edit | Documentation |

Each specialist has a focused system prompt with `ACTIVITY_FEED_INSTRUCTION` that tells it to output `## Goal` / `## Steps` for the activity feed parser.

---

## State Management

```typescript
// Module-level state, reset per orchestration
let orchestratorActivity: OrchestratorActivity | null = null;
let orchestratorGoal: string = "";
let planState: {
    goal: string;
    steps: Array<{ label: string; completed: boolean; active: boolean; errored?: boolean }>;
    startTime: number;
} | null = null;
let planContainer: Container | null = null;
let planTimer: ReturnType<typeof setInterval> | null = null;
let planTUI: TUI | null = null;
```

### Reset points
- `before_agent_start`: clears all state, sets up fresh plan
- `delegate` execute: adds step to plan, runs subagent, marks complete

---

## Data Flow

```
before_agent_start
  → clearPlanPanel()
  → setupPlanPanel(goal, ["Planning..."])
  → selectedTools = ["delegate"]
  → inject system prompt

delegate(scout, "investigate X")
  → planState adds step: "Scout: investigate X"
  → runSubagent(scout, task)
    → session.subscribe() → activity feed updates
    → onUpdate() → tool block renders in chat
  → completePlanStep() → step shows ✓

delegate(coder, "implement Y based on: [above]")
  → planState adds step: "Coder: implement Y..."
  → runSubagent(coder, task)
  → completePlanStep()

LLM synthesizes final answer
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Single delegate | Plan shows 1 step. Resolves when done. |
| User interrupt (Ctrl+C) | Plan freezes. Next task restores header. |
| Subagent error | Step shows `✗`. Plan continues to next step. |
| Long task names | Truncated to fit panel width with `...`. |
| New task mid-orchestration | `before_agent_start` → `setHeader(undefined)` → old plan gone. |
| No orchestration running | Built-in header shows normally. |

---

## Files

| File | Role |
|------|------|
| `orchestrator.ts` | Extension: tools, handlers, plan panel, activity feed |
| `ORCHESTRATION-UI-DESIGN.md` | This file. Single source of truth for design. |
| `token-saver.ts` | Token compression (separate concern) |
| `lint-guard.ts` | Auto-lint (separate concern) |

---

## Design Intent: Why Orchestrator-by-Default

### Context Window Protection

The orchestrator extension is enforced by default for every Pi session. This is intentional.

**Problem:** Without orchestration, the main LLM accumulates raw data in its context:
- File contents from `read` tool
- Command output from `bash` tool
- Grep results, find results, diffs
- Every tool invocation adds tokens

**Solution:** The coordinator model never touches raw data. It only sees:
- User task description
- Compressed specialist output (capped at 30KB per subagent)
- Its own synthesis/summary

**Result:** Coordinator context stays lean. Subagents handle the messy work.

### Token Economics

| Model role | Context contents | Token cost |
|-----------|-----------------|------------|
| Coordinator (main) | Task + compressed results only | Low |
| Specialist (subagent) | Task + full tool output | High, but isolated |

The coordinator runs on the cheap model (e.g., deepseek-v4-flash). Subagents can use the same or different models. Each subagent's context is disposable after completion.

### Why Not Opt-In

Making orchestrator opt-in would defeat the purpose:
- Users would forget to enable it
- Context would bloat silently
- Token costs would spike without awareness

Enforcement-by-default = protection-by-default.

### Escape Hatch

If a user needs direct tool access:
1. Temporarily move `orchestrator.ts` out of `~/.pi/agent/extensions/`
2. Or add a `/direct` command that temporarily disables enforcement
3. Or use `pi -e ./my-task.ts` to run a script without extensions

---

## Adaptive Gating (v2)

### Problem
Orchestrator agents often skip the planning phase and call `delegate(coder, ...)` directly, bypassing codebase analysis. This leads to hallucinated file paths, missing dependencies, and architectural inconsistencies.

### Solution: Scope-First Enforcement
The `delegate()` tool enforces a **scope-first gate**: `delegate(coder, ...)` is blocked unless a prior `delegate(scout, ...)` call has established a structured `## Scope` output.

Flow:
```
User request
  → delegate(scout, "investigate ...")
    → scout reads codebase, outputs ## Scope with:
      - filesToModify: string[]
      - filesToCreate: string[]
      - changeType: "single-file" | "multi-file"
      - maxLinesPerFile: number
  → delegate(coder, "implement ...")
    → ALLOWED only if scope exists. Coder locked to scope's file list.
  → delegate(reviewer, "review ...")
    → ALLOWED (read-only, no scope check)
```

### Gate Modes
| Mode | Trigger | Enforcement |
|------|---------|-------------|
| `strict` | changeType: "multi-file" | Full scope enforcement + maxLinesPerFile limit |
| `relaxed` | changeType: "single-file" | Files allowed only. Line limit skipped. |

### Scope Cache Lifecycle
- **Set**: When scout subagent completes and `## Scope` is extracted from output
- **Persisted**: Across multiple coder calls (supports debugging iteration)
- **Cleared**: On `before_agent_start` event (new session)

### Self-Correction Flow
When the LLM calls `delegate(coder, ...)` without prior scout:
1. Tool returns block message: "Scope required before coding"
2. LLM sees the message, calls `delegate(scout, ...)` instead
3. Scout outputs scope
4. LLM retries `delegate(coder, ...)` — now allowed

This is a single-turn self-correction, not a hard crash.
