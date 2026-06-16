# Orchestrator Extension — Vision Document

## Core UX Principle

The orchestrator provides a **three-layer visibility** system. At every moment, the user can see:

1. **What** is being done (plan panel — goal + step list)
2. **How** it's being done (subagent progress — substeps under active step, collapsible on click)
3. **Peek inside** what the subagent is doing right now (conversation viewer overlay)

The goal is **total transparency without clutter, without breaking cache, without wasting tokens**.

---

## Design Constraints

### Cache Safety
- Never modify existing `tool_result` content — this breaks Anthropic prompt cache
- All lint/substep updates go via **append-only** `steer` messages or separate `onUpdate` calls
- The conversation viewer reads subagent session data via `session.subscribe()` — it's an overlay, not a modification of parent conversation history

### Token Efficiency
- Goal is summarized (not raw user prompt)
- Steps are concise one-liners (not verbose descriptions)
- Completed substeps collapse to a single `✓ Step label (duration)` — no accumulated scroll
- The conversation viewer is on-demand (keyboard shortcut) — zero token cost when not in use

---

## Layer 1: Plan Panel (Orchestrator Level)

The plan panel sits above the editor, rendered via `ctx.ui.setWidget()`. It shows:

### Goal
- One concise line (few words, no overflow)
- Comprehended by the model from the user's intent, not raw prompt text
- Example: `◆ Investigate auth middleware` — not `Find and fix the auth bug in the middleware code and write tests for it`

### Steps
- List of high-level delegations
- Each step has three states:
  - `✓ Step label (duration)` — completed
  - `⠇ Step label` — active, showing current substeps beneath
  - `○ Step label` — pending, waiting
- Steps never overflow to multiple lines
- Completed steps are **collapsible on click** — user can expand to see what substeps ran

### Example
```
Plan: ◆ Investigate auth middleware  ● 2/4  1m 30s
✓ Scout: Read middleware files (25s)
⠇ Coder: Fix token expiry
  → Reading auth.ts                     ← live substep
  → Reading middleware.ts (✓)           ← completed substep
○ Reviewer: Verify fix
```

---

## Layer 2: Subagent Activity (Subagent Level)

When a subagent (scout, coder, etc.) is delegated via `delegate()`:

1. Subagent outputs its own **goal** (few words) and **steps** as `## Steps`
2. Each subagent step executes with **substeps** (individual tool calls like `read`, `lint`, `bash`)
3. Active substeps show live — spinner animates, label shows what's happening
4. Completed substeps **collapse** under the parent step — step shows `✓`
5. Click on a completed step to **expand** and see all substeps that ran
6. Next step becomes active only after current step fully completes

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
    ○ Summarize findings

  → After completion:
    ✓ Find auth files (2s)
    ✓ Read each file (12s)               ← collapsed, click to expand
    ✓ Summarize findings (3s)
```

### Collapsible Steps
- Click a completed `✓ Step` to toggle visibility of its substeps
- Keyboard shortcuts: `1`-`9` toggles that step's expansion, `0` expands all, `-` collapses all
- This avoids clutter while keeping history accessible

---

## Layer 3: Subagent Peek (Conversation Viewer)

At any time during delegation, the user can **peek inside** the subagent's conversation via a keyboard shortcut overlay. This addresses the core opacity problem: "I don't know if the subagent is hung, thinking, or waiting."

### What the viewer shows
- Subagent's reasoning (its chain of thought)
- Every tool call it makes and what returns
- Results in real-time (streaming via `session.subscribe()`)
- Errors immediately visible
- Status: reading a file, searching the web, linting, thinking, waiting

### How to access
- Keyboard shortcut `Ctrl+P` (or custom keybinding)
- Opens a centered overlay showing the subagent's live conversation
- Auto-scrolls as new content arrives
- Two-press `x` to abort a misbehaving subagent
- `Esc` to close, returns to orchestrator view

### Cache & Token Safety
- The overlay reads session data via `session.subscribe()` — it does NOT modify conversation history
- No additional API calls — it's a TUI-only feature
- Zero token cost when not in use
- Perfect for debugging without breaking prompt cache

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

1. **Raw prompt as goal**: Never use the user's raw input as the goal. Model must comprehend and summarize.
2. **Tool calls as step labels**: Never show `Running: ls -la` as a step name. Tool calls are substeps, not steps.
3. **Substep clear on completion**: Never erase substep history. Completed substeps collapse, they don't vanish.
4. **Overflowing text**: Never let goal or step labels overflow to multiple lines. Smart truncation if needed.
5. **Silent execution**: Never leave the user wondering "what is it doing?" Always show:
   - What's currently executing (active step + substep with label)
   - What's completed
   - What's next
6. **No peek**: Never hide the subagent's activity. The conversation viewer is essential for trust.
7. **Cache breaking**: Never modify existing `tool_result` content. Use steer messages or onUpdate for all state changes.

---

## Implementation Status

| Feature | Status | Priority |
|---------|--------|----------|
| Plan panel with goal + steps | ✅ Working | P0 |
| Auto-plan fallback (when plan() not called) | ✅ Working | P0 |
| Subagent outputs ## Steps | ✅ Working (STEPS_MANDATE in prompt) | P0 |
| Substeps under active step (not replacing step labels) | ✅ Working | P0 |
| Completed substeps collapse (not erased) | ✅ Working | P0 |
| Smart goal summarization (80 chars, no URLs/code) | ✅ Working | P0 |
| Tool call label as step fallback (not "Working...") | ✅ Working | P0 |
| Scope validation (filesToModify + filesToCreate) | ✅ Working | P0 |
| Tilde path expansion in syntax checker | ✅ Working | P0 |
| onUpdate fires during tool execution | ✅ Working | P0 |
| **Conversation viewer peek overlay** | ❌ Not implemented | P1 |
| **Collapsible steps (click/keyboard to expand)** | ❌ Not implemented | P1 |
| Steps auto-populate from subagent ## Steps | ⚠️ Partial — depends on model compliance | P1 |
| Status bar subagent count | ❌ Not implemented | P2 |
