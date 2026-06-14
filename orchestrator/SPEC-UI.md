# SPEC-UI.md — Orchestrator UI/UX Specification

> **Purpose:** Canonical UI/UX specification for the orchestrator extension. This document
> defines the exact rendering format for delegation progress shown in chat history.
> Every implementation decision must match these visual rules.

---

## Table of Contents

1. [Three-Layer Hierarchy](#1-three-layer-hierarchy)
2. [Status Icons](#2-status-icons)
3. [Canonical Rendering Example](#3-canonical-rendering-example)
4. [Progress Dots Row](#4-progress-dots-row)
5. [Step Row Rendering](#5-step-row-rendering)
6. [Substep Row Rendering](#6-substep-row-rendering)
7. [Tool Detail Row (Ephemeral)](#7-tool-detail-row-ephemeral)
8. [Indentation Scheme](#8-indentation-scheme)
9. [Blink Logic](#9-blink-logic)
10. [Duration Format](#10-duration-format)
11. [Substep Parsing from Subagent Output](#11-substep-parsing-from-subagent-output)
12. [Agent Instructions](#12-agent-instructions)
13. [Collapse Not Erase](#13-collapse-not-erase)
14. [Visual State Examples](#14-visual-state-examples)
15. [Implementation Mapping](#15-implementation-mapping)

---

## 1. Three-Layer Hierarchy

Every orchestrator session produces a three-layer information hierarchy visible to the user.

```
Layer 1: Plan Panel       → Widget above editor — orchestrator's goal + delegation steps
                            (9-line budget, managed via setWidget)
Layer 2: Step Progress    → Inline in chat history — THIS IS THE MAIN FOCUS
                            Numbered steps with intent descriptions,
                            nested substeps (logical actions + findings),
                            tool call detail for the active tool
Layer 3: Peek Overlay     → Ctrl+Q — full subagent conversation viewer
                            (right-aligned overlay, 50% width, 80% max height)
```

### Layer 1 — Plan Panel (Widget)

- Location: `ctx.ui.setWidget("orchestrator-status", lines)` — sits above editor, outside chat scroll.
- Budget: **9 lines** max. Overflow trims oldest completed steps from top.
- Content: Mirror of the active delegation progress from Layer 2.
- The plan panel uses the **same rendering format** as the chat history blob.
- The plan panel is flat text (no box borders, no ANSI decoration).
- Cleared via `setWidget("orchestrator-status", undefined)` when orchestrator completes.

### Layer 2 — Step Progress (Chat History)

- Location: Inline in chat as a tool result text blob (rendered by `renderResult`).
- Content: Progress dots row + step rows with nested substeps.
- Each delegation produces one block in chat history.
- Streaming updates via `onUpdate` callback during delegation.

### Layer 3 — Peek Overlay (Ctrl+Q)

- Opened via `showPeek()` on Ctrl+Q.
- Right-aligned overlay, 50% width, 80% max height.
- Shows: goal, current step, recent substeps (last 3), streaming subagent text.
- Esc to close, double-press `x` within 600ms to abort subagent.
- Auto-scrolls, capped at 50 lines.
- Uses same icon format as Layer 2.

---

## 2. Status Icons

Every level of the hierarchy uses the same icon system:

| State     | Icon              | Notes                                   |
|-----------|-------------------|-----------------------------------------|
| Completed | `✓`               | Checkmark — step/substep is done        |
| Active    | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | Moving spinner, cycles at 80ms          |
| Pending   | `○`               | Unfilled circle — not yet started       |

**Spinner specification:**
- 10 frames: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`
- Cycle interval: **80ms**
- Frames cycle continuously while the item is active
- Spinner resets to frame 0 on step transitions
- After 10 frames (800ms), the cycle loops back to frame 0

---

## 3. Canonical Rendering Example

The following is the **exact rendering** that all implementations must produce:

```
◆ Investigate codebase for auth bug
●○○ 1/3
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Grep "verifyToken" functions
    ✓ Read token validation logic
    ✓ Check middleware chain
    ✓ Report: Found expired token bug
    ✓ Report: Noted hardcoded secret issue
  ⠋ Step 2: Check token validation
    ⠋ Read src/auth/validate.ts
        ⠋ Running: cat src/auth/validate.ts
    ○ Check JWT decode flow
    ○ Find missing expiry check
    ○ Test with malformed token
    ○ Verify fix location
    ○ Add to fix list
  ○ Step 3: Find related tests
```

This rendering shows:
- **Line 1:** Goal line with `◆` prefix
- **Line 2:** Progress dots row (`●○○ 1/3`)
- **Line 3+:** Step rows at 2-space indent, substeps at 4-space indent
- **Step 1** is completed (checkmark + duration in parentheses)
- **Step 2** is active (spinner + no duration)
  - First substep is active (spinner)
  - Tool detail shown at 8-space indent under active substep
  - Remaining substeps are pending (unfilled circles)
- **Step 3** is pending (unfilled circle)

---

## 4. Progress Dots Row

**Format:** `●○○ N/M`

- One dot per step in the plan
- Dots are ordered left-to-right matching step order

| Dot State   | Symbol | Condition                              |
|-------------|--------|----------------------------------------|
| Completed   | `●`    | Step is locked completed (checked)     |
| Active      | `●`/`○`| Blinks between filled and unfilled at spinner rate (80ms) |
| Not reached | `○`    | Step has not started yet               |

**N/M count:**
- `N` = number of **truly completed steps** (locked `●` dots only)
- `M` = total number of steps
- Example: `●○○ 1/3` means 1 of 3 steps completed
- Example: `●●○ 2/3` means 2 of 3 steps completed
- Example: `●●● 3/3` means all steps completed

**Blink rule:** The active step's dot alternates between `●` and `○` at 80ms, synchronized with the spinner animation. On even frames (frame 0, 2, 4, 6, 8) — `○`. On odd frames (1, 3, 5, 7, 9) — `●`.

---

## 5. Step Row Rendering

Each step is rendered at **2-space indent** from the left margin.

### Completed Step

```
  ✓ Step N: <label> (<duration>)
```

- `✓` — checkmark icon
- Space after icon
- `Step N:` — literal "Step" followed by the step number (1-indexed) and colon
- Space after colon
- `<label>` — intent description (e.g., "Read auth middleware")
- Space
- `(<duration>)` — formatted duration in parentheses

**Duration** is calculated from `startTime` to `endTime` using `formatDuration()`.
Format: `Xm Ys` if minutes > 0, or `Xs` if only seconds.
Examples: `(45s)`, `(2m 13s)`, `(1m 0s)`.

### Active Step

```
  <spinner> Step N: <label>
```

- Spinner icon (current frame of `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)
- Space after spinner
- `Step N:` — same format as completed
- `<label>` — intent description
- **NO duration shown** on active steps

### Pending Step

```
  ○ Step N: <label>
```

- `○` — unfilled circle
- Space after icon
- `Step N: <label>` — same format
- No duration (not started)

### Error Step

```
  ✗ Step N: <label> (<duration>)
```

- `✗` — error icon
- Same label format as completed
- Duration optional (if step had started)

---

## 6. Substep Row Rendering

Substeps are rendered under their parent step at **4-space indent** from the left margin.

### Completed Substep

```
    ✓ <logical action>
    ✓ Report: <finding description>
```

- 4 spaces + `✓` + space + logical action text
- If the substep is a **finding** (information discovered during execution), use `Report:` prefix:
  `    ✓ Report: Found expired token bug`
- Duration is **NOT** shown for substeps (only steps show duration)

### Active Substep

Only ONE substep can be active at a time — the one currently executing.

```
    <spinner> <logical action>
```

- 4 spaces + spinner + space + logical action text
- Example: `    ⠋ Read src/auth/validate.ts`

### Pending Substep

```
    ○ <planned action>
```

- 4 spaces + `○` + space + planned action text
- Example: `    ○ Check JWT decode flow`

### No Substeps for Completed/Pending Steps

- **Completed steps** show ALL their completed substeps (see [Collapse Not Erase](#13-collapse-not-erase))
- **Pending steps** show no substeps (they haven't started)
- Only the **active step** can have a mix of completed, active, and pending substeps

---

## 7. Tool Detail Row (Ephemeral)

Tool detail is a **third-level** row shown only for the active substep. It displays the currently running tool command.

**Format:**

```
        <spinner> Running: <command summary>
```

- **8 spaces** from left margin + spinner + ` Running: ` + command summary
- Uses the same spinner animation as steps/substeps
- Command summary is a concise description of the tool being executed

**Ephemeral behavior:**
- **Appears** when a tool call starts (`tool_execution_start`)
- **Updates** in-place as the command runs (frame updates only — text stays same)
- **Disappears** when the tool call completes (`tool_execution_end`)
- When tool completes, the detail line is removed and the substep gets `✓` (if the subagent marks it done)

**Tool detail is NOT a substep.** It is a transient detail view of the active substep's current tool call. Multiple tool calls within one substep will each produce their own ephemeral detail line, one at a time.

**Only shown under the active substep.** If no substep is active, no tool detail row is shown.

---

## 8. Indentation Scheme

All indentation is from the **left margin** of the chat history text blob.

| Level | Content            | Indent | Example                                      |
|-------|--------------------|--------|----------------------------------------------|
| 0     | Goal line          | 0      | `◆ Investigate codebase for auth bug`         |
| 0     | Progress dots row  | 0      | `●○○ 1/3`                                    |
| 1     | Step               | 2      | `  ✓ Step 1: Read auth middleware (45s)`      |
| 2     | Substep            | 4      | `    ✓ Read src/auth/middleware.ts`            |
| 3     | Tool detail        | 8      | `        ⠋ Running: cat src/auth/validate.ts`  |

**Edge case — finding substep in a completed step:**
```
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Report: Found expired token bug
```
The `Report:` prefix is part of the substep text, not an additional indent level.

---

## 9. Blink Logic

The active step's progress dot blinks to create visual distinction.

**Mechanism:**
- The dot alternates between `●` (filled) and `○` (unfilled)
- Alternation rate matches the spinner: **80ms**
- On **even frames** (0, 2, 4, 6, 8): active dot shows `○`
- On **odd frames** (1, 3, 5, 7, 9): active dot shows `●`
- This creates a pulsing/blinking effect for the in-progress step

**Example progression over 5 frames (160ms):**
```
Frame 0:  ●○○ 1/3    (even frame — active dot is ○)
Frame 1:  ●●○ 1/3    (odd frame — active dot is ●)
Frame 2:  ●○○ 1/3    (even — ○)
Frame 3:  ●●○ 1/3    (odd — ●)
Frame 4:  ●○○ 1/3    (even — ○)
```

The first step is already completed (locked `●`), the second step is active (blinking), the third is pending (locked `○`).

---

## 10. Duration Format

Duration is displayed **only for completed steps** (not substeps, not active steps).

**Format:** `formatDuration(deltaMs)`

| Elapsed | Display    |
|---------|------------|
| 0-59s   | `(Ns)`     |
| 1m+     | `(Xm Ys)`  |
| 0s      | `(0s)`     |

**Examples:**
- `(45s)` — 45 seconds
- `(2m 13s)` — 2 minutes 13 seconds
- `(1m 0s)` — exactly 1 minute
- `(0s)` — instantaneous

**Rules:**
- Active steps: **NO duration shown** (not even elapsed — the user doesn't see a ticking timer)
- Completed steps: duration shown in parentheses after the label
- Substeps: **NO duration shown** (only steps show duration)
- Error steps: duration shown if the step was active before error

---

## 11. Substep Parsing from Subagent Output

The subagent communicates its plan via structured text output. The orchestrator parses this text to produce the step/substep tree.

### Subagent Output Format

```
## Goal
Find the auth token validation bug and determine the fix

## Steps
Step 1: Read auth middleware
  - Read src/auth/middleware.ts
  - Grep "verifyToken" functions
Step 2: Check token validation
  - Read src/auth/validate.ts
  - Check JWT decode flow
  - Find missing expiry check
Step 3: Find related tests
```

### Parsing Rules

1. **`## Goal`** — The line immediately after the goal heading is the goal text. Used for the `◆ <goal>` line.
2. **`## Steps`** — Each `Step N:` line creates a step. The step number `N` and label (text after `Step N:`) are extracted.
3. **Indented `-` bullets** under a step become substeps of that step. The text after `- ` is the logical action description.
4. **`- Report:` prefix** in a bullet marks the substep as a finding (rendered as `✓ Report: <text>`).
5. **Tool calls** are automatically tracked by the runtime — they appear as tool detail rows (Level 3) under the active substep. They do NOT create new substeps.

### Real-Time Substep Addition

During execution, the subagent can add new substeps via tool calls. When a tool call starts, the runtime:
1. Records it as the active substep's current tool (shows tool detail)
2. When the tool completes, the detail disappears
3. The subagent's text output may produce additional `- bullet` lines that become new completed substeps

---

## 12. Agent Instructions

The subagent's system prompt must instruct it to produce output in the parseable format.

### Required System Prompt Additions

Add the following instructions to the subagent system prompt:

```
## Output Format Requirements

When given a task, you MUST structure your response with:

1. **## Goal** — A one-line goal description starting on the line after this heading.

2. **## Steps** — Numbered steps using the format `Step N: <intent description>`.
   Each step should describe WHAT you need to accomplish (the intent), NOT the specific commands.

   Good: Step 1: Read auth middleware
   Bad:  Step 1: cat src/auth/middleware.ts

3. Under each step, list substeps as indented `- bullet` items.
   These are the logical actions you'll take or checks you'll perform.

   Example:
   Step 2: Check token validation
     - Read src/auth/validate.ts
     - Check JWT decode flow
     - Find missing expiry check

4. When you discover important findings during execution, add them as:
   - Report: <finding description>
   
   These can be added mid-execution as you discover things.

5. Do NOT list tool commands as steps. Tool calls are tracked automatically.
   Only list the logical intent.

6. Complete the `## Steps` section BEFORE making any tool calls.
   The steps serve as your plan of action.
```

---

## 13. Collapse Not Erase

Completed elements remain visible. They do not disappear.

### Steps
- Completed steps remain in the list with all their completed substeps visible
- The step gets `✓` but substeps are NOT collapsed
- Example — after Step 1 and Step 2 complete:

```
◆ Investigate codebase for auth bug
●●○ 2/3
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Grep "verifyToken" functions
    ✓ Report: Found expired token bug
  ✓ Step 2: Check token validation (30s)
    ✓ Read src/auth/validate.ts
    ✓ Check JWT decode flow
    ✓ Find missing expiry check
    ✓ Report: Missing expiry check in JWT decode path
  ⠋ Step 3: Find related tests
```

### Substeps
- Completed substeps remain visible under their parent step
- They are never removed, collapsed, or hidden
- Each completed substep shows `✓`

### Tool Detail (Exception)
- Tool detail is **ephemeral** — the only element that disappears
- Tool detail shows the currently running tool for the active substep
- When the tool completes, the detail line is removed
- This is the only transient element in the rendering

---

## 14. Visual State Examples

### Example 1: Initial State (Plan Declared, No Work Started)

```
◆ Investigate codebase for auth bug
○○○ 0/3
  ○ Step 1: Read auth middleware
  ○ Step 2: Check token validation
  ○ Step 3: Find related tests
```

### Example 2: First Step Active, No Completed Substeps Yet

```
◆ Investigate codebase for auth bug
●○○ 0/3
  ⠋ Step 1: Read auth middleware
    ⠋ Read src/auth/middleware.ts
        ⠋ Running: cat src/auth/middleware.ts
  ○ Step 2: Check token validation
  ○ Step 3: Find related tests
```

Note: Progress dot shows `●○○ 0/3` — the first dot blinks between ○ and ● (active step) but N=0 because no steps have truly completed yet.

### Example 3: First Step Partially Complete, Tool Running

```
◆ Investigate codebase for auth bug
●○○ 0/3
  ⠋ Step 1: Read auth middleware
    ✓ Read src/auth/middleware.ts
    ✓ Grep "verifyToken" functions
    ⠋ Read token validation logic
        ⠋ Running: grep -r "verifyToken" --include="*.ts"
    ○ Check middleware chain
    ○ Report: Found expired token bug (pending)
  ○ Step 2: Check token validation
  ○ Step 3: Find related tests
```

Note: Progress dot `●○○ 0/3` — the first dot blinks between ○ and ● (active step), N=0 because no steps are locked complete yet.

### Example 4: Step 1 Complete, Step 2 Active

```
◆ Investigate codebase for auth bug
●○○ 1/3
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Grep "verifyToken" functions
    ✓ Read token validation logic
    ✓ Check middleware chain
    ✓ Report: Found expired token bug
    ✓ Report: Noted hardcoded secret issue
  ⠋ Step 2: Check token validation
    ⠋ Read src/auth/validate.ts
        ⠋ Running: cat src/auth/validate.ts
    ○ Check JWT decode flow
    ○ Find missing expiry check
    ○ Test with malformed token
    ○ Verify fix location
    ○ Add to fix list
  ○ Step 3: Find related tests
```

Progress dots: `●○○ 1/3` — step 1 is locked completed (`●`), step 2 is active (blinks between ○ and ●), step 3 is pending (`○`).

### Example 5: Tool Call Completes, Detail Removed

When the `cat src/auth/validate.ts` tool finishes, the tool detail line disappears:

```
◆ Investigate codebase for auth bug
●○○ 1/3
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ...
  ⠋ Step 2: Check token validation
    ✓ Read src/auth/validate.ts         ← now checked (tool detail gone)
    ⠋ Check JWT decode flow
        ⠋ Running: grep "decode" src/auth/validate.ts
    ○ Find missing expiry check
    ...
  ○ Step 3: Find related tests
```

Progress dots: `●○○ 1/3` — step 1 is locked completed (`●`), step 2 is active (blinks between ○ and ●), step 3 is pending (`○`).

### Example 6: Two Steps Complete, Third Active

```
◆ Investigate codebase for auth bug
●●○ 2/3
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Grep "verifyToken" functions
    ✓ Read token validation logic
    ✓ Check middleware chain
    ✓ Report: Found expired token bug
    ✓ Report: Noted hardcoded secret issue
  ✓ Step 2: Check token validation (30s)
    ✓ Read src/auth/validate.ts
    ✓ Check JWT decode flow
    ✓ Find missing expiry check
    ✓ Test with malformed token
    ✓ Verify fix location
    ✓ Add to fix list
  ⠋ Step 3: Find related tests
    ⠋ Find existing tests for auth middleware
        ⠋ Running: grep -r "auth" src/__tests__/
    ○ Check test coverage for token validation
    ○ Identify missing test cases
```

Progress dots: `●●○ 2/3` — steps 1 and 2 are locked completed (`●`), step 3 is active (blinks between ○ and ●).

### Example 7: All Steps Complete

```
◆ Investigate codebase for auth bug
●●● 3/3
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Grep "verifyToken" functions
    ✓ Read token validation logic
    ✓ Check middleware chain
    ✓ Report: Found expired token bug
    ✓ Report: Noted hardcoded secret issue
  ✓ Step 2: Check token validation (30s)
    ✓ Read src/auth/validate.ts
    ✓ Check JWT decode flow
    ✓ Find missing expiry check
    ✓ Test with malformed token
    ✓ Verify fix location
    ✓ Add to fix list
  ✓ Step 3: Find related tests (22s)
    ✓ Find existing tests for auth middleware
    ✓ Check test coverage for token validation
    ✓ Identify missing test cases
```

### Example 8: Step with Error

```
◆ Investigate codebase for auth bug
●✗○ 1/3
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Grep "verifyToken" functions
    ...
  ✗ Step 2: Check token validation (20s)
    ✓ Read src/auth/validate.ts
    ✓ Check JWT decode flow
    ✗ Find missing expiry check
  ○ Step 3: Find related tests
```

Note: When a step errors, its substeps up to the error point remain visible.
The error icon `✗` replaces the spinner or checkmark at the step level.
Progress dots: `●✗○ 1/3` — step 1 is locked completed (`●`), step 2 is errored (`✗`), step 3 is pending (`○`).

### Example 9: Dynamic Step Addition

Orchestrator discovers a new step is needed mid-execution.

```
◆ Investigate codebase for auth bug
●○○○ 1/4
  ✓ Step 1: Read auth middleware (45s)
    ✓ Read src/auth/middleware.ts
    ✓ Report: Found JWT secret hardcoded in config
  ⠋ Step 2: Check token validation
    ⠋ Read src/auth/validate.ts
    ○ Check JWT decode flow
    ...
  ○ Step 3: Find related tests
  ○ Step 4: Fix hardcoded JWT secret (NEW)    ← dynamically added
```

Progress dots: `●○○○ 1/4` — step 1 is locked completed (`●`), step 2 is active (blinks between ○ and ●), steps 3 and 4 are pending (`○`). The N/M count updates to reflect the new total of 4 steps.

### Example 10: Plan Panel Widget (Layer 1)

The plan panel widget mirrors the same format but is budget-constrained to 9 lines.

```
◆ Fix auth bug
●○○ 1/3
  ✓ Step 1: Read auth middleware (45s)
  ⠋ Step 2: Check token validation
    ⠋ Read src/auth/validate.ts
        ⠋ Running: cat file
  ○ Step 3: Find related tests
```

Progress dots: `●○○ 1/3` — step 1 is locked completed (`●`), step 2 is active (blinks between ○ and ●), step 3 is pending (`○`).

If over 9 lines, trim oldest completed steps from top. The goal line, progress dots, and active step are always retained.

---

## 15. Implementation Mapping

### Key Components

| Component     | Role                                      |
|---------------|-------------------------------------------|
| `plan-panel.ts` | Widget rendering (Layer 1), step lifecycle, progress dots |
| `activity-feed.ts` | Step/substep parsing, chat history rendering (Layer 2) |
| `delegate-tool.ts` | Tool registration, orchestrator orchestration |
| `subagent-runner.ts` | Subagent session management, tool event wiring |
| `peek-overlay.ts` | Ctrl+Q overlay (Layer 3) |
| `plan-tool.ts` | `plan()` tool registration |
| `types.ts` | `PlanStep`, `Substep`, `Step` type definitions |

### Data Flow

```
plan() tool call
  → setupPlanPanel(goal, steps)           [plan-panel.ts]
  → setWidget("orchestrator-status", lines)

delegate() tool call
  → startDelegationStep(label)            [plan-panel.ts]
  → subagent session starts               [subagent-runner.ts]
    → subagent outputs ## Steps
    → parseTextForSteps()                  [activity-feed.ts]
    → renderProgress() → setWidget / onUpdate
    → tool_execution_start
      → ephemeral tool detail line shown
      → renderProgress() → setWidget / onUpdate
    → tool_execution_end
      → tool detail line removed
      → substep may get ✓ (if subagent completed it)
      → renderProgress() → setWidget / onUpdate
    → subagent text output with findings
      → new substeps added rendered with ✓
      → renderProgress() → setWidget / onUpdate
  → completePlanStep()                     [plan-panel.ts]
    → step gets ✓ + duration
```

### Rendering Function

```
renderProgress(state: OrchestratorState): string[]
```

Returns a `string[]` where each element is one line of text. This array is used both for:
- `setWidget("orchestrator-status", lines)` — plan panel (Layer 1), truncated to 9 lines
- `onUpdate(lines.join('\n'))` — chat history blob (Layer 2), full rendering

### Formatting Helpers

| Helper | Purpose |
|--------|---------|
| `formatDuration(ms)` | `45s`, `2m 13s` |
| `spinnerFrame(index)` | Returns current spinner char from frame index |
| `progressDot(index, activeIdx, completedSet)` | Returns `●`, `○`, or blinking variant |
| `indent(level)` | Returns `' ' * (level * 2)` — level 1=2sp, level 2=4sp, level 3=8sp |

### Compliance Checklist

- [ ] Goal line starts with `◆`
- [ ] Progress dots: `●○○ N/M` format, active dot blinks at 80ms
- [ ] Completed steps: `  ✓ Step N: <label> (<duration>)`
- [ ] Active steps: `  <spinner> Step N: <label>` (no duration)
- [ ] Pending steps: `  ○ Step N: <label>`
- [ ] Completed substeps: `    ✓ <action>`
- [ ] Finding substeps: `    ✓ Report: <finding>`
- [ ] Active substeps: `    <spinner> <action>`
- [ ] Pending substeps: `    ○ <action>`
- [ ] Tool detail: `        <spinner> Running: <command>` under active substep only
- [ ] Tool detail is ephemeral — removed on tool completion
- [ ] Completed substeps stay visible (collapse not erase)
- [ ] Substep parsing: `Step N:` → steps, `- bullet` → substeps, `- Report:` → findings
- [ ] No duration shown on active steps or substeps
- [ ] Spinner: 10 frames, 80ms cycle
- [ ] Plan panel capped at 9 lines
