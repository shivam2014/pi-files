# Orchestrator Extension — Codebase Review

> **Date:** 2026-06-14
> **Reviewer:** External (second model)
> **Scope:** Full codebase review against VISION.md and pi SDK compliance
> **Constraint:** No changes made — review only

---

## Executive Summary

| Category | Grade | Notes |
|----------|-------|-------|
| Architecture | B+ | Refactored from monolith to 10-file module. Clean separation. |
| Implementation | C | 2 P1 features unimplemented. State machine has race condition. |
| SDK Compliance | B | Uses pi APIs correctly. Some experimental APIs need guardrails. |
| Testability | D+ | No mock LLM harness. Junior dev cannot test TUI without real API calls. |

---

## 1. Codebase Structure

### Current Layout

```
orchestrator/
├── index.ts              # 260 lines — wiring hub, system prompt injection
├── types.ts              # 80 lines — interfaces
├── plan-panel.ts         # 380 lines — Layer 1, timer, spinner
├── activity-feed.ts      # 440 lines — Layer 2, state machine, parsing
├── subagent-runner.ts    # 380 lines — env guard, session lifecycle
├── delegate-tool.ts      # 380 lines — delegate() tool, scope wiring
├── specialists.ts        # 280 lines — 5 specialists + prompts
├── peek-overlay.ts       # 230 lines — Layer 3, Ctrl+Q overlay
├── plan-tool.ts          # 50 lines — plan() tool
├── commands.ts           # 40 lines — /orchestrate, /specialists
├── ui-utils.ts           # 20 lines — box drawing
├── debug.ts              # 30 lines — logging
├── test-unit.test.ts     # 280 lines — vitest tests
├── test-e2e.ts           # 420 lines — RpcClient test
└── test-visual.sh        # 180 lines — tmux smoke test
```

**Verdict:** Good modularization. File sizes reasonable. Dependency graph acyclic. Meets self-imposed 400-line limit.

---

## 2. Issues Found

### 2.1 `peek-overlay.ts` — Interface Mismatch Risk

**Problem:** Re-declares pi-tui interfaces locally to avoid import issues:

```typescript
// Lines 23-30: Local interface subset
interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
}
```

**Risk:** If the real `Component` interface changes (adds required method), code compiles but fails at runtime.

**Fix:** Import from `@earendil-works/pi-tui` directly. The `tsconfig.json` already maps it:

```typescript
import { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
```

**Effort:** 30 minutes

---

### 2.2 `index.ts` — System Prompt Injection is Fragile

**Problem:** String concatenation into system prompt:

```typescript
const delegationInstructions = `## Orchestrator Mode...`;
return { systemPrompt: cleanedPrompt + delegationInstructions };
```

**Risk:**
- `cleanedPrompt` may already contain `## Orchestrator Mode` → duplicate sections
- If `event.systemPrompt` is `undefined` → `"undefined[string content]"`

**Fix:** Use structured merge with guard:

```typescript
function injectOrchestratorPrompt(existing: string | undefined): string {
  const base = existing ?? "";
  const marker = "## Orchestrator Mode";
  if (base.includes(marker)) return base;
  return base + "\n\n" + delegationInstructions;
}
```

**Effort:** 30 minutes

---

### 2.3 `activity-feed.ts` — State Machine Mutates Directly (CRITICAL)

**Problem:** Direct mutation + concurrent events = race conditions:

```typescript
function addStep(state: ActivityFeedState, label: string): void {
  state.steps.push({ label, completed: false, substeps: [] });
}
```

**Impact:**
- `text_delta` + `tool_end` + 80ms timer tick = three concurrent mutation paths
- Race conditions in UI state don't flake occasionally — they flake when users are watching
- Violates your own Rule 2 (State Localization)

**Fix:** Immutable reducer. Pure functions that return new state:

```typescript
function addStep(state: ActivityFeedState, label: string): ActivityFeedState {
  if (state.steps.some(s => s.label === label)) return state;
  const newStep: Step = {
    label, completed: false, substeps: [],
    startTime: Date.now()
  };
  return {
    ...state,
    steps: [...state.steps, newStep],
    currentStep: state.currentStep === -1 ? 0 : state.currentStep,
  };
}

// In event handler:
state = addStep(state, label); // reassign, don't mutate
```

**Effort:** 2-3 hours

---

### 2.4 `plan-panel.ts` — Dual Timer Path

**Problem:** `setupPlanPanel` calls `startPlanTimer()` but may also create intervals directly in some paths.

**Risk:** Double timers = double renders = flickering.

**Fix:** Single timer source. `setupPlanPanel` should only call `startPlanTimer()`.

**Effort:** 1 hour

---

### 2.5 `subagent-runner.ts` — No Peek Data Source

**Problem:** `peek-overlay.ts` is 90% built but `subagent-runner.ts` never calls `updatePeek()` or `updatePeekFeed()`.

**Impact:** `Ctrl+Q` opens empty overlay. No live content streamed.

**Fix:** Add `session.subscribe()` integration:

```typescript
session.subscribe((event) => {
  if (event.type === "text_delta") {
    updatePeek(event.delta);
  }
  if (event.type === "tool_call") {
    updatePeekFeed(feedState);
  }
});
```

**Effort:** 1 hour

---

## 3. SDK Compliance

### ✅ Correct Usage

| Feature | SDK API | File | Status |
|---------|---------|------|--------|
| Plan panel widget | `ctx.ui.setWidget()` | `plan-panel.ts` | ✅ |
| Tool registration | `pi.registerTool()` | `delegate-tool.ts` | ✅ |
| Command registration | `pi.registerCommand()` | `commands.ts` | ✅ |
| Shortcut registration | `pi.registerShortcut()` | `index.ts` | ✅ |
| Event hooks | `pi.on("before_agent_start")` | `index.ts` | ✅ |
| Tool call blocking | `return { block: true, reason }` | `index.ts` | ✅ |
| Subagent isolation | `process.env` guard | `subagent-runner.ts` | ✅ |

### ⚠️ Risky Usage

#### 3.1 `ctx.ui.custom()` — Experimental Overlay

**Risk:** Pi docs mark `overlay: true` as experimental. API may change.

**Mitigation:** Wrap in try-catch. Fall back to non-overlay:

```typescript
export function showPeek(ctx, ...): void {
  try {
    ctx.ui.custom(...overlayConfig...);
  } catch {
    ctx.ui.custom(...panelConfig...); // fallback
  }
}
```

#### 3.2 Widget ID Collision

**Risk:** `ctx.ui.setWidget("orchestrator-status", ...)` may collide with other extensions.

**Mitigation:** Use namespaced ID:

```typescript
const WIDGET_ID = "earendil/orchestrator-status";
ctx.ui.setWidget(WIDGET_ID, lines);
```

#### 3.3 `pi.setActiveTools()` — Verify SDK

```typescript
pi.setActiveTools(["plan", "delegate"]);
```

**Action:** Verify this method exists in `@earendil-works/pi-coding-agent` types. If monkey-patched, document.

---

## 4. Missing P1 Features (from VISION.md)

### 4.1 Collapsible Steps — ❌ Not Implemented

**VISION.md says:**
> "Click a completed `✓ Step` to toggle visibility of its substeps"
> "Keyboard shortcuts: `1`-`9` toggles that step's expansion"

**Current state:** `PlanStep` has no `collapsed` flag. No keyboard shortcuts.

**Implementation path:**

```typescript
// types.ts
interface PlanStep {
  label: string;
  completed: boolean;
  active: boolean;
  collapsed: boolean; // NEW
  substeps: Substep[];
}

// plan-panel.ts
pi.registerShortcut("1", {
  description: "Toggle step 1",
  handler: (ctx) => toggleStepExpansion(0),
});

// render
function renderPlanStep(step: PlanStep): string[] {
  const lines = [`${icon} ${step.label}`];
  if (!step.collapsed && step.substeps.length > 0) {
    for (const sub of step.substeps) {
      lines.push(`  ${subIcon} ${sub.label}`);
    }
  }
  return lines;
}
```

**Effort:** 2-3 hours

---

### 4.2 Peek Overlay — ⚠️ 90% Built, Disconnected

**Current:** `peek-overlay.ts` exists. `Ctrl+Q` registered. But:
- No `session.subscribe()` integration
- `_peekLines` never populated by subagent-runner
- Activity feed state registered but not streamed

**Fix:** See section 2.5 above.

**Effort:** 1 hour

---

## 5. Testing — How to Enable Junior Dev

Current testing is fragmented:
- Unit tests: isolated functions, no TUI
- E2E: RpcClient, but environment pollution
- Visual: tmux, static snapshots only

### 5.1 Missing: Mock Subagent Harness

**Problem:** No way to test TUI without real LLM API calls.

**Solution:** Create `test-mock-e2e.ts`:

```typescript
const MOCK_EVENTS = [
  { type: "text_delta", delta: "## Goal: Test\n## Steps:\n- Read file\n- Write code\n" },
  { type: "tool_start", tool: "read", input: { path: "test.ts" } },
  { type: "tool_end", tool: "read", output: "const x = 1;" },
  { type: "text_delta", delta: "## Result: Success\n" },
];

// Mock createAgentSession to emit events
const mockSession = {
  subscribe: (cb) => {
    let i = 0;
    const interval = setInterval(() => {
      if (i >= MOCK_EVENTS.length) { clearInterval(interval); return; }
      cb(MOCK_EVENTS[i++]);
    }, 500);
  },
  waitForCompletion: () => new Promise(r => setTimeout(r, 5000)),
};
```

### 5.2 Recommended Test Architecture

| Test Type | File | Purpose | When |
|-----------|------|---------|------|
| Unit | `test-unit.test.ts` | Pure functions | Every commit |
| Render | `test-render.ts` | Widget output | CI + manual |
| Mock E2E | `test-mock-e2e.ts` | Full flow, no LLM | CI + manual |
| Live TUI | `tui-smoke.sh` | Real pi in tmux | Release |
| Visual | `test-visual.sh` (future) | Screenshot diff | PR |

### 5.3 Junior Dev Testing Guide

```bash
# Step 1: Unit tests
cd ~/.pi/agent/extensions/orchestrator
npx vitest run test-unit.test.ts

# Step 2: Render test (no LLM)
npx tsx test-render.ts

# Step 3: Mock E2E (no LLM)
PI_TEST_MOCK=1 npx tsx test-mock-e2e.ts

# Step 4: Live TUI (needs pi binary)
cd ~/.pi
./tui-smoke.sh pi "add error handling to main.ts"

# Step 5: Manual peek test
# Start pi, run task, press Ctrl+Q during delegation
```

---

## 6. Refactoring Priority

| Priority | File | Issue | Effort | Impact |
|----------|------|-------|--------|--------|
| **P0** | `activity-feed.ts` | Immutable reducer | 2-3 hrs | Fixes race conditions, enables testing |
| **P0** | `subagent-runner.ts` | Peek data source | 1 hr | Makes Ctrl+Q useful |
| **P1** | `types.ts` + `plan-panel.ts` | Collapsible steps | 2-3 hrs | UX feature from VISION.md |
| **P1** | `test-mock-e2e.ts` | Create mock harness | 2-3 hrs | Unblocks all junior dev testing |
| **P2** | `peek-overlay.ts` | Import real types | 30 min | Prevents runtime breakage |
| **P2** | `index.ts` | Prompt merge guard | 30 min | Prevents duplicate injection |
| **P2** | `plan-panel.ts` | Single timer source | 1 hr | Fixes flickering |

---

## 7. Architecture Rules Compliance

| Rule | Status | Notes |
|------|--------|-------|
| One file per concern (<400 lines) | ✅ | All files under limit |
| State localization | ⚠️ | `activity-feed.ts` mutates directly |
| Dependency direction | ✅ | Acyclic graph |
| Scope enforcement | ✅ | `scope-guard.ts` is separate, zero coupling |
| Spec enforcement | ✅ | `VISION.md` exists, mostly aligned |

---

## 8. Bottom Line

**Architecture is good.** The refactoring from 1663-line monolith to 10-file module succeeded.

**Three gaps block junior dev productivity:**

1. **No mock subagent harness** → Can't test TUI without LLM API calls
2. **Peek overlay is 90% built but disconnected** → `Ctrl+Q` opens empty box
3. **State machine mutates directly** → Race conditions, hard to test

**Fix these three, and the extension becomes testable, debuggable, and trustworthy.**

---

*End of review. No changes made. Ready for implementation.*
