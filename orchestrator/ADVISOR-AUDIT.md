# Orchestrator Extension — Development Approach Audit

> **Purpose**: External review prompt. This document is self-contained — no other files needed.
> **Reviewer**: Second model with no prior context.
> **Goal**: Evaluate architecture decisions, testing strategy, and suggest improvements.

---

## 1. The Vision

3-layer transparency system for pi coding agent's orchestrator extension.

**Core principle**: Total transparency without clutter — user never wonders "what is it doing right now?"

### Layer 1 — Plan Panel (Widget above editor)

- Shows goal + step list
- States: `✓` completed, `⠋` active (spinner), `○` pending
- Token budget: <10 lines
- API: `ctx.ui.setWidget("orchestrator-status", string[])`
- Render timing: 80ms spinner timer + 1s elapsed timer

### Layer 2 — Subagent Activity (Chat inline)

- Substeps collapse into completed steps (don't erase, don't vanish)
- API: `renderActivityFeed()` / `renderCombinedProgress()` → tool result text
- State machine: `ActivityFeedState` with `steps[]`, `currentStep`, `substeps[]`
- Events update state: `text_delta`, `tool_start`, `tool_end`

### Layer 3 — Peek (Overlay)

- Live conversation viewer for any subagent
- Opens via `Ctrl+Q` shortcut
- API: `ctx.ui.custom()` with `{ overlay: true, anchor: "right-center", width: "50%" }`
- Shows: goal, feed steps, streaming content (capped at 50 lines)
- Double-press `x` to abort subagent

---

## 2. Implementation Approach — Why We Chose This

### Why `ctx.ui.setWidget()` for Layer 1?

| Pros | Cons |
|------|------|
| Sits above editor, no chat scroll consumption | Flat string array — no rich formatting |
| Persists across turns | No borders, no interactive elements |
| Simple `string[]` rendering | Limited styling control |

### Why inline text for Layer 2?

| Pros | Cons |
|------|------|
| Tool results appear in chat history naturally | Mixed with other chat content |
| No extra widget or overlay needed | Hard to distinguish from other messages |
| User sees delegation cards with nested progress | No structural separation |

### Why `ctx.ui.custom()` overlay for Layer 3?

| Pros | Cons |
|------|------|
| Positionable, sizable, focusable | "Experimental" per pi docs |
| Captures keyboard input for abort | Limited API surface |
| Overlay model fits peek metaphor | No programmatic way to inspect overlay state |

### Why state machine for activity feed?

- Incremental parsing of streaming markdown (`## Goal`, `## Steps`)
- Each event updates state → render function reads state → produces `string[]`
- **Risk**: State mutations complex — race conditions between parsing and rendering

### Why 80ms render timer?

- Matches spinner frame rate (12.5 fps)
- Batches rapid state updates
- Dedup prevents unnecessary re-renders
- **Bug found**: Dedup killed spinner animation — fixed by tracking `_spinnerIndex` separately

---

## 3. Protections Implemented

| Protection | What it does | Location |
|-----------|--------------|----------|
| Bash restrictions | Blocks `cat`/`head`/`tail` → forces read tool | `index.ts` tool_call handler |
| Tool allowlisting | Each specialist gets only declared tools | `specialists.ts` + `createAgentSession()` |
| Scope enforcement | Writes validated against `.pi/scope.json` | `subagent-runner.ts` + `scope-guard.ts` |
| `_activeDelegations` | Prevents `clearPlanPanel()` mid-delegation | `plan-panel.ts` |
| Cache safety | No cross-delegation caching | By design — each subagent runs fresh |
| Token budget | Plan panel <10 lines, substeps capped | `renderPlanLines()` + `MAX_FEED_SUBSTEPS` |

---

## 4. Current Testing Methodology

### What we've tried

#### A. Unit tests (vitest)

- Inlined critical functions (`addSubstep`, `completeCurrentStep`, etc.)
- 7/7 pass
- **Limitation**: Isolated functions only — not full TUI rendering pipeline

#### B. tsc compilation check

- Verifies type safety
- Only pre-existing errors (`.ts` imports, missing `@types/node`)
- **Limitation**: Doesn't catch runtime bugs

#### C. RpcClient E2E test (attempted)

- Spawned pi via `RpcClient`, sent prompts, captured events
- **Problems**:
  - Environment variable pollution (`PI_ORCHESTRATOR_SUBAGENT=1`)
  - Sequential prompts in same session rejected (agent busy)
  - Event collection timing issues
- **Result**: Partially working, abandoned

#### D. tmux capture-pane (attempted)

- Started pi in tmux, sent commands, captured screen
- **Problems**:
  - Static snapshot only — no spinner animation
  - ANSI escape sequences in output
  - Can't verify live widget updates
- **Result**: Limited usefulness

#### E. `/debug` command

- Writes render state to `pi-debug.log`
- **Problems**: Point-in-time only, manual

#### F. `PI_TUI_WRITE_LOG`

- Captures raw ANSI stream to file
- **Problem**: Hard to parse, no structured output

### What exists but we haven't used

#### G. herdr (terminal multiplexer for agents)

- Split panes, run commands, wait for output patterns
- `herdr wait output` blocks until text appears in pane
- `herdr pane read` snapshots pane content
- **Potential**: Run pi in one pane, tests in another, wait for rendering patterns

#### H. tui-smoke.sh (automated TUI smoke test)

- 10 tests validating TUI rendering
- Uses tmux + `PI_TUI_DEBUG=1` + snapshot polling
- Checks: plan panel visible, step icons present, specialist names, no crashes
- **Potential**: Run against extension to verify rendering

---

## 5. Debugging Challenges in Live TUI

### Core problem

Pi's TUI renders via ANSI escape sequences to stdout. Render state is:

- **Ephemeral**: Exists only in terminal scrollback
- **Dynamic**: Spinner, progress dots, step counts update in real-time
- **Layered**: Widget + chat + overlay + status bar render independently
- **Non-inspectable**: No API to query current widget state

### What we can't easily verify

| # | Question |
|---|----------|
| 1 | Does plan panel show correct step states (`✓`/`⠋`/`○`)? |
| 2 | Do substeps collapse correctly after step completion? |
| 3 | Does spinner animation continue during tool execution? |
| 4 | Does peek overlay show live streaming content? |
| 5 | Does `[1/1]` show instead of `[0/0]`? |
| 6 | Does `Ctrl+Q` open/close the overlay? |

### What we've tried

| Method | Result |
|--------|--------|
| tmux `capture-pane` | Static snapshot, no animation |
| `/debug` | Point-in-time dump only |
| `PI_TUI_WRITE_LOG` | Raw ANSI, hard to parse |
| `RpcClient` | Event stream, but timing issues |

### What we need

Programmatic assertion on TUI state **over time**, not just at a single point.

---

## 6. Available Tools

| Tool | Purpose | Usage |
|------|---------|-------|
| `herdr` | Terminal multiplexer for agents | `herdr wait output "pattern"` |
| `tui-smoke.sh` | 10 automated TUI rendering tests | `./tui-smoke.sh ./pi "test prompt"` |
| `createHarness()` | Simulate LLM without API keys | `import { createHarness } from pi test utils` |
| `FakeTerminal` | Capture TUI writes for assertions | `class FakeTerminal implements Terminal` |
| `/debug` | Dump render state to log | Type `/debug` in pi |
| `PI_TUI_WRITE_LOG` | Capture raw ANSI stream | `PI_TUI_WRITE_LOG=/tmp/log pi` |
| `PI_TUI_DEBUG=1` | Per-render snapshots | `PI_TUI_DEBUG=1 pi` |

---

## 7. Questions for the Advisor

### Q1 — Architecture
Is the 3-layer approach (widget + inline + overlay) the right choice for pi's SDK? Are there better primitives we should use?

### Q2 — State Management
The activity-feed state machine has many mutation paths. Is there a simpler pattern? Should we use a reducer/immutable approach?

### Q3 — Testing
We can't easily test live TUI rendering. Best approach?

- `createHarness()` + `FakeTerminal` from pi's test utils?
- `herdr` for coordinated multi-pane testing?
- `tui-smoke.sh` pattern with snapshot polling?
- Something else entirely?

### Q4 — Debugging
How should we debug live TUI issues? Is there a way to programmatically inspect widget state? Should we add logging to the extension?

### Q5 — The [0/0] Bug
We found `addOrchestratorStep()` was never called. Are there similar silent failures we should be looking for?

### Q6 — Performance
80ms render timer, 10K char raw text cap, 50 line peek cap. Are these appropriate? Too aggressive? Not aggressive enough?

### Q7 — Fresh Start
If building this 3-layer system from scratch in pi, what approach would you take?
