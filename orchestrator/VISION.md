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

- Plan panel must fit in <10 lines at all times
- Substeps collapse aggressively: once a step completes, its substeps are removed from rendering
- Step labels are short (max ~60 chars) — truncated if longer
- No debug-level output in plan panel (that's what the peek is for)
- Status bar is single-line, always visible

---

## Layer 0: Enforcement

Before any delegation occurs, three guard mechanisms enforce invariants across all subagent work:

### lint-guard
Deterministic lint checking after every file edit or write. Project-agnostic: auto-detects linter from project config (supports 14 linters across 7 languages). Cache-safe: lint results sent via `pi.sendMessage()` without modifying tool output — no side effects on delegation results.

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
3. Completed substeps **collapse** — they disappear from the view and the step is marked `✓`
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
    ✓ Read each file (12s)               ← collapsed, no substeps visible
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
- Keyboard shortcut (e.g., `Ctrl+P` to peek)
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
│ [Peek: Ctrl+P to see subagent conversation]      │  ← Layer 3 indicator
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
| Substeps shown under active step | ⚠️ Partial — sometimes replaces step labels | P0 |
| Completed substeps collapse | ❌ Substeps erased instead of collapsing | P0 |
| Smart goal summarization | ❌ Using raw prompt text | P0 |
| Cache safety (no cross-delegation caching) | ✅ Working by design | P0 |
| Conversation viewer peek | ❌ Not implemented | P1 |
| Keyboard shortcut for peek | ❌ Not implemented | P1 |
| Token-efficient rendering (<10 lines) | ⚠️ Partial — some overflow edge cases | P1 |
| Status bar subagent count | ❌ Not implemented | P2 |
