# Orchestrator Extension — Vision Document

## Core UX Principle

The orchestrator provides a **three-layer visibility** system. At every moment, the user can see:

1. **What** is being done (plan panel — goal + step list)
2. **How** it's being done (subagent progress — substeps collapsing into completed steps)  
3. **Peek inside** what the subagent is doing right now (conversation viewer)

The goal is **total transparency without clutter**. The user should never wonder "what is it doing right now?"

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
