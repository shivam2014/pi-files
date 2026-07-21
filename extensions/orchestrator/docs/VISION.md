# Orchestrator Extension — Vision Document

## Core UX Principle

The orchestrator provides a **three-layer visibility** system. At every moment, the user can see:

1. **What** is being done (plan panel — goal + step list)
2. **How** it's being done (subagent progress — substeps collapsing into completed steps)  
3. **Peek inside** what the subagent is doing right now (conversation viewer)

The goal is **total transparency without clutter**. The user should never wonder "what is it doing right now?"

---

## Core Doctrine: Deterministic Guardrail Workflow

### What This Extension Is

A deterministic guardrail workflow system for delegated agent work. Not a chat UI. Not a transcript viewer. Not a general agent framework.

### Specialists Are Professions

A human cannot be a nuclear engineer, an HR manager, and a politician at once with the same toolbox. Each specialist owns its own tools, skills, system prompt, and deterministic checks. Never generalize a specialist into a do-everything agent.

### Orchestrator Is the Manager, Not the Worker

A relatively expensive model holds the global system view: decomposition, sequencing, interfacing, verification strategy. If the manager does the tasks manually it is (a) expensive, (b) lost in micro-detail, (c) no longer enforcing the global view. This is systems engineering embodied in software.

### Deterministic Checks Are the Guardrails

Cheap subagents make inadvertent errors. Objective, non-subjective checks — lint, scope enforcement, property-based testing (quickcheck-style, available in every language), metric-based loop evaluation — catch those errors and feed them back to the subagent as guidance. Checks verify facts (paths, commands, counts, events, test outcomes), never inferred intent.

### Hard Rule: No Intent Inference from Prose

Deterministic layers must never classify or gate behavior by matching patterns against natural-language task text. Lesson learned (regex capability filters, 2026-07): keyword matching on sentences produced false-positive blocks on valid work and required endless pattern patches. Guards read facts, not sentences.

### CEO–Manager Alignment

The user is the CEO; the orchestrator is the manager they hired. The CEO steers with goals, constraints, and experience-based judgment — and can veto a mechanism class without reading its code. Therefore the manager must never introduce a mechanism silently. Every new guard, check, or workflow feature is announced in plain language — what it watches, what it acts on, what happens when it misfires — before or as it ships. Mechanism class and risk are always visible to the CEO; implementation internals (files, line numbers) are reported only on request. Alignment is continuous, not on-demand.

### 7. Design for the weakest operator
The extension is the mechanical safety net for manager and worker mistakes. A weak model must be unable to wreck the workflow; a strong model must never be slowed or second-guessed by the machinery. Never build model-strength detection — build the floor, not the ceiling.

### 8. Workers get complete truth about their part
Workers have no global context. The manager must hand each worker: its real tools, its real limits, the guards that will block it, and enough scope to deliver its part of the working system.

---

## Design Constraints

### Cache Safety

The orchestrator must **never cache agent outputs** across delegations. Each subagent runs fresh. Rationale:

- Subagents are stateless by design — caching creates hidden state
- Cached outputs become stale as project files change
- The plan panel reflects live execution, not historical runs
- Exception: User explicitly requests a re-run with `--cache` flag (future)

### Token Efficiency

- Plan panel must fit in 9 lines max (hard cap) — see SPEC-UI.md §1
- Substeps collapse under their parent header, never erased. Layer 2 (chat history) keeps all completed substeps fully visible; Layer 1 (plan panel) trims oldest completed steps when over budget — see SPEC-UI.md §13 for the two-tier rule
- Step labels are short (max ~60 chars) — truncated if longer
- No debug-level output in plan panel (that's what the peek is for)
- Status bar is single-line, always visible

---

## Layer 0: Enforcement

Before any delegation occurs, three guard mechanisms enforce invariants across all subagent work:

### lint-guard
Deterministic lint checking after every file edit or write. Runs automatically after `edit`/`write` tool calls. Project-agnostic: auto-detects linter from project config (supports 14 linters across 7 languages). **Extension-aware**: validates file extension against the linter's supported patterns before selecting it — only runs linters on files they actually support. Non-code files (`.md`, `.txt`, `.json`, etc.) are skipped entirely when no linter handles them. Cache-safe: lint results sent via `pi.sendMessage()` without modifying tool output — no side effects on delegation results.

### scope-guard
Path-restricted write enforcement. All writes and edits validated against allowed paths defined in `.pi/scope.json`. Unauthorized modifications blocked before reaching the filesystem. Prevents subagents from drifting outside project boundaries.

### token-saver
Token usage reduction layer. Truncates long tool outputs, summarizes goals to fit constraints, and budget-constrains the plan panel. Keeps total context usage predictable and prevents runaway token consumption on large outputs.

Together, these guards run transparently — subagents never see them, but their outputs stay clean, scoped, and efficient.

### Cardinal Rule: Cache Safety

**Cache breaks are the most expensive mistake in the system.** Every cache invalidation costs tokens, adds latency, and increases cost — often by orders of magnitude for a single misplaced change. A single broken cache can turn a 50k-token session into a 500k-token session.

**Every change must be evaluated against its impact on conversation cache.** Before any edit, delegation, or tool call design decision, ask: *does this preserve the cache?* If the answer is uncertain, the answer is no.

The **pi-cache-optimizer** extension is the authoritative mechanism for maintaining cache safety. It is not optional. It is not a suggestion layer. Any behavior that undermines the cache-optimizer invalidates the entire enforcement stack.

**All enforcement mechanisms must preserve cache integrity.** lint-guard, scope-guard, and token-saver must never introduce side effects that break cache. Specifically:

- **lint-guard**: Lint results sent via `pi.sendMessage()` — no modification of tool output that would alter downstream cache keys.
- **scope-guard**: Path validation is pure/read-only against the filesystem — no write-side effects that change cached state.
- **token-saver**: Truncation and summarization must produce deterministic output for identical input — non-deterministic summarization poisons cache.

If a new guard or enforcement mechanism is added, it must pass the same cache-safety invariant. No exceptions.

---

## Layer 1: Plan Panel (Orchestrator Level)

The plan panel sits above the editor. It shows:

### Goal
- One concise line (few words, no overflow)
- Derived from user's intent (comprehended by the model, not raw prompt text)
- Example: `◆ Investigate auth middleware` — not `◆ Find and fix the auth bug in the middleware code and write tests for it`

### Steps
- List of high-level delegations
- Each step has three states:
  - `✓ Step label (duration)` — completed (collapsed, no substeps shown)
  - `⠇ Step label` — active (expanded, showing current substeps)
  - `○ Step label` — pending (waiting)
- Steps never overflow to multiple lines
- Active step shows live substep progress beneath it

### Example
```
Plan: ◆ Investigate auth middleware  ● 2/4  1m 30s
✓ Scout: Read middleware files (25s)
⠇ Coder: Fix token expiry
  → Reading auth.ts                     ← live substep
  → Reading middleware.ts (✓)           ← completed substep
○ Reviewer: Verify fix
○ Write summary
```

---

## Layer 2: Subagent Activity (Subagent Level)

When a subagent (scout, coder, etc.) is delegated:

1. Subagent outputs its own **goal** (few words) and **steps** as `## Steps`
2. Each subagent step executes with **substeps** (individual tool calls)
3. Completed substeps remain visible under their parent step. They are never removed — see SPEC-UI.md §13 for the two-tier rule (Layer 1 may trim oldest completed steps when over budget)
4. Active step shows live tool calls as substeps beneath it
5. Next step becomes active only after current step fully completes

### Flow
```
Subagent receives: "Read the auth middleware files"
  → Outputs: ## Goal: Read auth files
             ## Steps:
             - Find all auth-related files
             - Read each file
             - Summarize findings

  → During execution:
    ● [1/3]
    ✓ Find auth files (2s)
    ⠇ Read each file
      → Reading auth.ts                  ← currently executing
      → Reading middleware.ts (✓)        ← completed
      → Reading permissions.ts (pending)
    ○ Summarize findings

  → After all substeps complete:
    ✓ Find auth files (2s)
    ✓ Read each file (12s)               ← completed substeps remain visible
    ⠇ Summarize findings
```

Key rule: **substeps collapse into their parent step** when that step completes. This keeps the feed clean while providing real-time granularity.

---

## Layer 3: Subagent Peek (Conversation Viewer)

At any time during delegation, the user can **peek inside** the subagent's conversation to see exactly what it's doing:

### What the viewer shows
- Subagent's reasoning (its chain of thought)
- Every tool call it makes and what it returns
- Results in real-time (streaming)
- Errors immediately visible

### How to access
- Keyboard shortcut (e.g., `Ctrl+Q` to peek — mnemonic "quick peek")
- Opens an overlay showing the subagent's live conversation
- Auto-scrolls as new content arrives
- Two-press `x` to abort the subagent

### Why this matters
Without the peek, the user sees only orchestration-level steps. With the peek, they can verify the subagent is on the right track, catch errors early, or abort a misbehaving subagent.

---

## Visual Layout

```
┌─────────────────────────────────────────────────┐
│ Plan: ◆ Investigate auth middleware  ● 2/4  90s │  ← Layer 1: Plan panel
│ ✓ Scout: Read middleware files (25s)            │
│ ⠇ Coder: Fix token expiry                      │
│   → Reading auth.ts                             │  ← Layer 2: Substeps
│ ○ Reviewer: Verify fix                          │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ [Chat content...]                               │
│                                                 │
│ delegate Coder: Fix the token expiry bug         │
│ ┌─ Task ────────────────────────────────────┐   │
│ │ Coder: Fix token expiry in auth middleware │   │
│ ├──── Steps ────────────────────────────────┤   │
│ │ ● [2/3]                                    │   │
│ │ ✓ Find auth files (2s)                     │   │
│ │ ⠇ Fix token expiry                         │   │
│ │   → Reading auth.ts                        │   │
│ │   ✓ Read middleware.ts (1s)                │   │
│ │ ○ Verify fix                               │   │
│ └────────────────────────────────────────────┘   │
│                                                 │
│ [Peek: Ctrl+Q to see subagent conversation]      │  ← Layer 3 indicator
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ ↑2.7k ↓903 R15k CH84% deepseek-v4-flash-2 • hi │  ← Status bar
└─────────────────────────────────────────────────┘
```

---

## Anti-Patterns (What NOT to do)

1. **Raw prompt as goal**: Never use the user's raw input as the goal. The model must comprehend and summarize.
2. **Tool calls as step labels**: Never show `Running: ls -la` as a step name. Tool calls are substeps, not steps.
3. **Substep clear on completion**: Never erase substep history. Completed substeps collapse cleanly, don't vanish.
4. **Overflowing text**: Never let goal or step labels overflow to multiple lines. Use smart truncation if needed.
5. **Silent execution**: Never leave the user wondering "what is it doing?" Always show:
   - What's currently executing (active step + substep)
   - What's completed
   - What's next
6. **No peek**: Never hide the subagent's activity behind a black box. The peek is essential for trust.
7. **Cache poisoning**: Never reuse a subagent's output from a prior run without explicit user consent.
8. **Token bloat**: Never render full tool output in the plan panel. Full output belongs in the peek overlay.

---

## Non-Goals

- No regex/heuristic classification of task prose in any guard, gate, or validator.

---

## Implementation Status

| Feature | Status | Priority |
|---------|--------|----------|
| Plan panel with goal + steps | ✅ Working | P0 |
| Subagent outputs ## Steps | ✅ Working | P0 |
| Substeps shown under active step | ✅ Working (Layer 2 full; Layer 1 trimmed per budget) | P0 |
| Completed substeps collapse | ✅ Working (two-tier: Layer 1 trims oldest, Layer 2 preserves all) | P0 |
| Smart goal summarization | ✅ Working (summarizeGoal wired into plan-tool.ts) | P0 |
| Cache safety (no cross-delegation caching) | ✅ Working by design | P0 |
| Scope enforcement (scope-guard.ts) | ✅ Working — reads .pi/scope.json directly, fail-closed | P0 |
| Adaptive gating (coder blocked without scout) | ✅ Working — throws if scope is vague | P0 |
| ask_orchestrator (subagent clarification) | ✅ Working — resolves from files/docs/context, escalates to orchestrator | P1 |
| Conversation viewer peek | ✅ Implemented (Layer 3) | P1 |
| Keyboard shortcut for peek | ✅ Ctrl+Q | P1 |
| Fusion tool (panel → judge) | ✅ Working — always registered, visibility via setActiveTools | P1 |
| Fusion toggle (enabled/disabled) | ✅ Working — config + /fusion command | P1 |
| Bash interceptor (cat→read, grep→grep, etc.) | ✅ Working — per-specialist routing | P1 |
| Lint guard (auto-lint after edit/write) | ✅ Working — project-agnostic, cache-safe | P1 |
| Token-efficient rendering (9-line budget) | ⚠️ Partial — some overflow edge cases (PAN-005, PAN-008) | P1 |
| Subagent tool guard (planSteps-first ordering) | ✅ Working | P1 |
| Scope expansion requests | ✅ Working — ScopeExpansionRequest → orchestrator | P1 |
| Subagent event router | ✅ Working — pub/sub for UI modules | P2 |
| Registration hub (all tools at init) | ✅ Working — fusion included, visibility via setActiveTools | P2 |
| Status bar subagent count | ❌ Not implemented | P2 |

## See Also

- [BASH-TOKEN-SAVER-SPEC.md](./BASH-TOKEN-SAVER-SPEC.md) — RTK integration, token-saver compression, per-specialist bash restriction approach
- [SPEC-UI.md](./SPEC-UI.md) — 3-layer UI/UX rendering specification
- [LINT-SPEC.md](./LINT-SPEC.md) — Deterministic lint guard specification

---

## Prompt Design Principles

These principles govern all prompt text in the orchestrator extension. They are permanent; implementations change, principles don't.

### 1. Token economy
Every line in a prompt costs tokens per session. A prompt that runs 100 times/day wastes 100x the tokens of a one-time cost. Prompts must earn their place. If a line doesn't change agent behavior, cut it.

### 2. Cache protection
System prompts are cached. Frequent changes to prompt text invalidate the cache. Keep prompts stable. Behavior changes should come from code (guard logic, tool schemas), not prompt text churn.

### 3. Error prevention through information
Every agent must receive enough context to do its job without triggering guard errors. If a guard blocks an action, the prompt should have explained how to avoid it. Don't make agents guess what files to include, what tools to use, or what format to follow. Show them.

### 4. Plain language
Agents don't know pi internals. They have general knowledge only. Instructions must use plain language. Say "scan the task text for file names" not "leverage task-text analysis for scope derivation." No domain jargon without context.

### 5. Examples over essays
Short, concrete examples beat long explanations. Show the syntax. One example is worth 200 words of theory. But the example must be correct and complete — a partial example teaches wrong patterns.

### 6. Completeness without verbosity
Every tool the agent can use must be mentioned with its constraints. If a tool exists but the agent doesn't know about it, the agent will either not use it or trigger errors. But don't explain what the agent already knows from general training. Focus on what's specific to this system.

### 7. Consistency across agents
Shared instructions (activity feed, terse mode, step mandate) must apply uniformly to all specialists. Specialized instructions (minimal action, scope output format) should only go to the agents that need them. Don't duplicate; use shared blocks.

### 8. Error messages as teaching
Error messages should tell the agent exactly what to do next, not just what went wrong. "Scope required" is not enough. Show the syntax. "File not in scope" is not enough. Show which files are approved. Every error is a teaching moment — use it.

### 9. Plan panel integration
The orchestrator must know how the plan panel works: it shows the current step, completed steps, and streaming activity. The plan is set via plan(goal, steps) and steps advance via the subagent's planSteps/advanceStep tools. The orchestrator doesn't directly control the panel — it declares the plan, subagents fill it.

### 10. Skill chaining
Skills can reference other skills internally. When a skill says "load X skill" or "follow Y methodology", the agent must read those skills too. Don't assume a single skill read is enough. Skills form a graph, not a list.

### 11. Routing accuracy
The routing table must match the actual specialist capabilities. If a specialist can do something the table doesn't mention, the table is wrong. If the table suggests a specialist for a task it can't handle, the table is wrong. Audit the table against real specialist prompts regularly.

### 12. Scope is a contract
Scope declares what the subagent may touch. The orchestrator must scan the task text for every file name, component name, and implied dependency before declaring scope. Glob patterns (e.g., `*.test.ts`) are supported for bulk inclusion. Bare wildcards (`*`, `**`) without a literal directory are rejected. The scope example in the prompt must show both exact paths and glob patterns.

### 13. Tool documentation — syntax, arguments, output
When documenting tools, explain three things: what it does, when to use it, and how to call it. Show the exact syntax with argument types. Show what the output looks like. An agent that knows a tool exists but not how to call it will either not use it or trigger errors. Every tool in the prompt must have: syntax example, argument list, output format.

---

## Architectural Principles

These principles govern how the orchestrator extension is built and maintained.

### 14. Reuse what exists — SDK, modules, patterns
Before building anything, check if it already exists. The pi SDK provides APIs for tool metadata, skill lists, active tools — use them. The codebase has modules for scope management, ask resolution, UI utilities — reuse them. Don't hardcode what the system can derive. Don't reinvent what's already built. The prompt should be a template that fills itself from the system's actual state. Dynamic content stays in sync; static content drifts.

### 15. Modular, single-responsibility
Each file handles one concern. Tool registration in separate files. Pure logic (scope-guard, ask-resolver) separated from pi API coupling. Shared utilities in ui-utils.ts. Registration-hub.ts is the central wiring point.

### 16. Pure logic before pi coupling
Business logic lives in pure functions or classes that don't import pi. Pi API calls happen at the registration layer, not in the logic layer. This makes logic testable without mocking pi.

### 17. Registration pattern
New tools follow the pattern: `registerXTool(pi: ExtensionAPI)` function → export from module → wire in registration-hub.ts → add to active tools in index.ts. Don't skip steps.

### 18. Token-neutral changes
When adding new prompt text, identify what can be removed. Every line costs tokens per session. New features should be token-neutral or token-negative. Measure before committing.

### 19. Verify facts, never infer intent
Deterministic guards operate on observable state (paths, commands, metrics, events, test results). Natural-language classification belongs to the model, not to guard code.

---

## Plan Panel Vision

This section consolidates the full vision for the plan panel — the orchestrator's primary mechanism for tracking and communicating execution progress.

### Core Principle

The plan panel is the orchestrator's **living execution map**. It represents the orchestrator's understanding of how to accomplish the goal, and updates dynamically as new information arrives from subagents. It is not a static checklist — it is a reflection of current knowledge. When knowledge changes, the plan changes.

### Step Types

Each step in the plan is one of two types:

1. **Delegation step** — work delegated to a specialist subagent (scout, coder, reviewer, researcher, writer). The subagent executes the task and the plan panel auto-tracks progress via the activity feed.
2. **Orchestrator step** — work done by the orchestrator itself: analyzing subagent output, synthesizing findings, calling fusion for multi-model advice, making architectural decisions, or planning next moves.

Both types appear in the same step list. The user does not need to distinguish them — the plan shows *what* is happening, not *who* is doing it.

### Step Lifecycle

```
Created (○) → Active (⠋) → Completed (✓) or Errored (✗)
```

- **Created**: Step exists in the plan but has not started.
- **Active**: Step is currently executing. Only one step is active at a time.
- **Completed**: Step finished successfully. Never erased — accumulates as execution trail.
- **Errored**: Step failed. Error details visible in the activity feed or peek overlay.

### Step Management

The orchestrator must be able to:

- **Create** a plan with goal and ordered steps upfront — declared before execution begins
- **Advance** steps (both delegation and own-work) as they complete — single step advances per completion
- **Insert** new steps when subagent output reveals unanticipated work — placed at the correct position
- **Remove** steps that are no longer relevant based on new information — keeps plan accurate
- **Modify** step labels when the understanding of what's needed changes — plan stays truthful
- **Append** steps at the end when the plan scope expands — new work goes at the tail

These operations ensure the plan panel always reflects the orchestrator's current understanding, not its initial guess.

### Dynamic Plan Updates

When a subagent returns findings that change the original plan:

1. The orchestrator assesses what changed and what it means for remaining steps
2. It modifies the plan: insert, remove, modify, or append steps as needed
3. The plan panel reflects these changes immediately
4. Execution continues with the updated plan

This is the plan panel's key differentiator from a static checklist. The plan is a **hypothesis** that gets refined as evidence arrives.

### Design Rules

1. Steps are planned in advance — the orchestrator declares its intent before executing
2. Each step has a clear label describing the work (not a tool name or command)
3. The plan panel is always visible (9-line budget, widget above editor)
4. Progress is shown via status icons: ✓ completed, ⠋ active (spinner), ○ pending, ✗ error
5. Completed steps are never erased — they accumulate as a trail of progress
6. The plan persists across the session — it is the single source of truth for execution progress

### Tool Interface

The orchestrator interacts with the plan panel via these tools:

- `plan(goal, steps)` — create initial plan with goal and ordered step list
- `plan_add_steps(steps)` — append new steps when scope expands
- `advance_plan_step()` — mark current step complete, advance to next
- `insert_step(index, label)` — insert a step at a specific position
- `remove_step(index)` — remove a step by position
- `modify_step(index, label)` — change a step's label to reflect updated understanding

### Separation of Concerns

- **PlanPanel** (Layer 1): Manages plan state, renders the header widget, handles step lifecycle — the macro view
- **ActivityFeed** (Layer 2): Tracks per-delegation substeps, tool details, progress within a step — the micro view

These are separate layers with distinct responsibilities. PlanPanel tracks *what needs to happen*. ActivityFeed tracks *what is happening right now* within each delegation. They compose but do not overlap.

### Anti-Patterns

- Steps that are too granular (one tool call per step) — steps describe work, not commands
- Steps that are too vague ("do stuff", "handle it") — each step must be specific enough to verify completion
- Plans that never update despite new information — stale plans mislead the user
- Plan panel showing stale or incorrect step labels — labels must match actual work
- Orchestrator work steps that never advance in the plan panel — own-work steps must advance like delegation steps

---

## Delegation Budget & Timeout Philosophy

### Timeout as Guardrail, Not Wall

The timeout is a **discipline enforcer for weaker models**, not a punishment. It exists because models with large context windows lose focus and burn time on investigation that should have been bounded. The timeout applies to ALL delegations — serial and parallel alike. Serial mode means one-at-a-time, not unlimited-time.

### Graceful Degradation, Not Hard Kill

**NEVER** hard-kill a delegation. The timeout behavior must follow this sequence:

1. **80% of budget**: Send a warning to the subagent: "Time warning: Xs remaining. Wrap up current work and deliver what you have."
2. **100% of budget**: Collect partial results. Return them with `stopReason: "timeout"` (NOT "aborted").
3. **Error message**: Must say "Delegation hit Xs timeout" — never "interrupted by user" or "aborted." The user didn't abort anything. A system constraint fired.

A subagent that delivers 80% of the work at timeout is infinitely more valuable than one that delivers 0% because it was killed mid-thought.

### Why This Matters

- "Aborted — interrupted by user" is a lie when the system fires the timeout. It misdirects debugging.
- Weaker models interpret the abort as "the human stopped me" and don't learn from it.
- Partial results are wasted when the session is hard-killed. The orchestrator has no output to work with.

---

## Context Architecture

### Each Subagent Reads Files Itself

The orchestrator never holds file contents. Each subagent reads files independently.

- Scout reads files → returns **findings + relevant snippets** (5-10 lines around the issue)
- Orchestrator gets **enough to decide** (the snippet, not the file)
- Coder reads files itself → makes edits
- Deterministic checks verify (lint, scope guard)

### Why Re-Reading Is Not Waste

The "waste" of re-reading is **not waste** — it's the correct architecture:

| Operation | Where It Happens | Cost |
|-----------|-----------------|------|
| Read 200-line file | Cheap model (subagent) | Pennies |
| Hold 200-line file | Expensive model (orchestrator) | Dollars + degraded reasoning |

A cheap model re-reading a file costs pennies. An expensive model holding a 200-line file in context costs dollars and degrades its reasoning quality for every subsequent decision.

### What Scout Returns

Scout returns a **structured finding**, not a file dump:

```
## Finding: Auth token expiry bug

**File**: auth.ts
**Line**: 42
**Issue**: Uses < instead of <= for expiry check

**Relevant code (lines 40-45)**:
  if (tokenExpiry < Date.now()) {  // ← bug here
    return expired();
  }

**Fix**: Change < to <= on line 42.
**Scope**: Single-file fix, no dependencies.
```

The orchestrator gets:
- The finding (what's wrong)
- The relevant snippet (5 lines, not 200)
- The fix recommendation (what to change)
- The scope (how big the change is)

This is **enough to decide**, not enough to pollute.

### The Orchestrator Is Not a Cache

The orchestrator's context is **sacred** — it holds decisions, not data. It's a brain, not a storage system.

**Wrong**: Orchestrator absorbs scout's findings, holds file contents, passes code to coder.
**Right**: Scout returns snippets, orchestrator decides, coder reads files itself.

---

## Error Message Standards

### What Happened vs What It Looks Like

| Current Message | Actual Cause | Correct Message |
|----------------|--------------|------------------|
| "Aborted — interrupted by user" | System timeout fired | "Delegation hit Xs timeout (orchestrator.yml)" |
| "Request was aborted" | AbortSignal.timeout fired | "Timeout: partial results preserved below" |
| "Aborted — interrupted by user" | User pressed Ctrl+C | "Aborted — interrupted by user" (this one is correct) |

The error message must distinguish between:
1. **User abort** (Ctrl+C) — "interrupted by user"
2. **System timeout** — "hit Xs timeout"
3. **Model error** — "model returned error: ..."
4. **Scope violation** — "scope guard blocked: ..."

Each message must teach the next step, not just state what happened.

---

## Orchestrator-Subagent Cost Architecture

### The Orchestrator Is the Brain, Not the Storage

The orchestrator runs on the **most capable, most expensive model**. Its context window is premium real estate. Every token of file content in the orchestrator's context is:
- Expensive (premium model pricing)
- Degrading (larger context = slower reasoning, lower quality decisions)
- Wasted (the orchestrator doesn't need to know the code — it needs to know the *decisions*)

The orchestrator's context should contain:
- **Decisions**: what to do, in what order, with what constraints
- **Delegation results**: summaries, findings, status — not raw code
- **Plan state**: what's done, what's next, what changed
- **Relevant snippets**: 5-10 lines around a finding, NOT whole files

The orchestrator's context should NOT contain:
- Whole file contents (that's the subagent's job)
- Full investigation logs (that's the scout's job)
- Complete code listings (that's the coder's job)

### Subagents Are the Muscles

Subagents run on **cheap models**. Their context windows are expendable. They're designed for:
- Focused, directed tasks with clear inputs and outputs
- Reading files, searching code, making edits
- Burning tokens on investigation that the orchestrator shouldn't touch

The cheap model's strength is **concentrated work** — given a clear directive from a higher intelligence, it executes mechanically. The orchestrator provides the "what" and "why." The subagent provides the "how."

### The Division of Labor

```
Orchestrator (expensive):  "Fix the auth bug at line 42 in auth.ts. Change X to Y."
Subagent (cheap):          Reads auth.ts, makes the edit, runs lint, reports done.
Orchestrator (expensive):  "✓ Auth bug fixed. Next: update the tests."
```

The orchestrator never reads `auth.ts`. It never sees the full code. It trusts the subagent to do the work and the deterministic checks to catch errors.

### What Scout Returns (Not Whole Files)

See the Context Architecture section above for the full scout return format. The key point: scout returns a **structured finding** (5-10 lines around the issue), not a file dump. The orchestrator can say "yes, that's the right fix" or "no, investigate further" without absorbing the whole file.

### Context Pollution Is the Enemy

When the orchestrator absorbs whole file contents from scout's findings:
- Its context window grows
- Its reasoning quality degrades
- Its cost increases exponentially (input tokens × model price)
- It reaches its optimal working context size faster
- Every subsequent delegation costs more because the context is bloated

The orchestrator should **summarize, not absorb**. Scout returns: "Found the bug at line 42. The function uses `<` instead of `<=`." The orchestrator records: "Bug at auth.ts:42, operator fix needed." The raw code stays in the scout's context — which is discarded after the delegation.

### Deterministic Checks Replace Human Verification

The orchestrator doesn't need to verify the coder's work by reading the code. Instead:
- **lint-guard** runs after every edit — catches syntax and style errors
- **scope-guard** prevents edits outside the allowed files — catches scope violations
- **Tests** (when available) verify behavior — catches logic errors

These are **mechanical, deterministic, cheap**. They replace the need for the orchestrator to inspect code, which would be expensive and error-prone (LLMs are bad at verification).

### The Optimization Stack

| Layer | What It Does | Cost Impact |
|-------|-------------|-------------|
| **Provider cache** | Caches system prompt + tool definitions across delegations | Near-zero cost for repeated specialist types |
| **Subagent isolation** | Each subagent gets fresh context — no cross-contamination | Orchestrator context stays clean |
| **Read dedup (within session)** | token-saver returns stub for re-read files in same session | Reduces redundant reads within one subagent |
| **Deterministic checks** | lint-guard, scope-guard catch errors mechanically | No orchestrator verification needed |
| **Timeout guardrail** | Keeps subagents disciplined, prevents runaway sessions | Bounded cost per delegation |

### What This Means for Delegation Design

**Correct**: Orchestrator delegates focused tasks with clear scope. Subagent reads, edits, reports. Deterministic checks verify. Scout returns snippets, not files.

**Wrong**: Orchestrator absorbs scout's findings, holds file contents, passes code to coder. This pollutes the expensive model's context with cheap model work.

**Wrong**: Scout returns whole files verbatim. The orchestrator doesn't need 200 lines — it needs the 5 relevant lines.

**The orchestrator's job is to think, not to store.** The subagent's job is to work, not to think. The deterministic checks' job is to verify, not the orchestrator.

### Token Cost Model

```
Orchestrator turn:  $$$$  (expensive model, premium pricing)
Scout delegation:   $     (cheap model, reads files, returns summary + snippets)
Coder delegation:   $     (cheap model, reads files, makes edits)
Lint check:         free  (deterministic, no LLM involved)
Scope check:        free  (deterministic, no LLM involved)
```

Every file the orchestrator reads directly costs 10-100x what it costs in a subagent. Every whole file the orchestrator absorbs from a subagent pollutes its context. The only free information is the delegation status: "done," "error," "timeout."

### The Principle

**Orchestrator context is sacred.** Keep it clean, keep it small, keep it focused on decisions. Let cheap models do the expensive work of reading and writing. Let deterministic checks do the expensive work of verifying. The orchestrator's only job is to direct the orchestra — not to play every instrument.

Scout returns **relevant snippets** (5-10 lines around a finding), not whole files. The orchestrator gets enough to decide, not enough to pollute.
