# Orchestrator Extension — Reconciled Audit & Action Plan

**Date:** 2026-06-14
**Audits:** 4 independent (Kimi-k2.6, Sonnet 4.6, GPT-5.x, Meta-assessor)
**Status:** Reconciled with user decisions
**Revisions:** 2

---

## TABLE OF CONTENTS

1. [Quick Overview](#1-quick-overview)
2. [Audit Sources](#2-audit-sources)
3. [What Was Found (All Findings)](#3-what-was-found)
4. [Agreements & Conflicts](#4-agreements--conflicts)
5. [User Decisions](#5-user-decisions)
6. [Meta-Audit Corrections](#6-meta-audit-corrections)
7. [Phase 1: Fix Broken (Visual + Code)](#7-phase-1-fix-broken)
8. [Phase 2: Simplify (Visual + Code)](#8-phase-2-simplify)
9. [Phase 3: Test & Harden](#9-phase-3-test)
10. [Backlog](#10-backlog)
11. [Appendix: Grades & Metrics](#11-appendix)

---

## 1. QUICK OVERVIEW

### 1.1 Audit Sources

| # | Auditor | Model | Role | Files Read |
|---|---------|-------|------|------------|
| 1 | **Codex** | Kimi-k2.6 | SDK + UI/UX + Code expert | Full codebase (17 files) + execution trace |
| 2 | **Sonnet 4.6** | Claude Sonnet 4.6 | Code review + architecture | Key files + previous AUDIT-REVIEW |
| 3 | **GPT-5.x** | GPT-5.x | Pi-native architecture expert | Execution trace + architecture docs |
| 4 | **Meta-assessor** | — | Audit of the audit | Reconciled audit document only |

### 1.2 All Findings at a Glance

#### Codex Findings

| Severity | Finding | File |
|----------|---------|------|
| P0 | State machine race condition | `activity-feed.ts` |
| P0 | Peek overlay disconnected | `subagent-runner.ts` |
| P0 | Scope extraction missing | `delegate-tool.ts` |
| P1 | `pi.setActiveTools()` unverified | `index.ts` |
| P1 | `ctx.ui.custom()` experimental | `peek-overlay.ts` |
| P1 | Widget ID collision | `plan-panel.ts` |
| P1 | Smart goal summarization missing | `plan-panel.ts` |
| P2 | System prompt merge fragile | `index.ts` |
| P2 | Import real pi-tui types | `peek-overlay.ts` |
| D+ | No mock testing harness | — |

#### Sonnet 4.6 Findings

| Severity | Finding | File |
|----------|---------|------|
| P0 | Unit tests test dead code | `test-unit.test.ts` |
| P0 | `_orchestratorActivity` concurrent overwrite | `delegate-tool.ts` |
| P0 | Peek content replay missing | `peek-overlay.ts` |
| P1 | Progress dots format mismatch | `plan-panel.ts` |
| P1 | `renderCombinedProgress` / `renderActivityFeed` duplication | `activity-feed.ts` |
| P1 | `require()` in render callbacks | `delegate-tool.ts` |
| P2 | `_batchLoadSubagent` hot-reload risk | `subagent-runner.ts` |
| P2 | `require()` in `plan-panel.ts` | `plan-panel.ts` |

#### GPT-5.x Findings

| Severity | Finding | File |
|----------|---------|------|
| P1 | `MAX_RAW_TEXT` too large | `activity-feed.ts` |
| P1 | Scout should not have `bash` | `specialists.ts` |
| P1 | `edit` should be only file-mod path | `specialists.ts` |
| P2 | Scope should use directories | `types.ts` |
| P2 | Remove peek overlay | `peek-overlay.ts` |

#### Meta-Assessor Findings

| Severity | Finding | Source |
|----------|---------|--------|
| P1 | Reconciled audit conflict: peek in Phase 1 vs user "skip" | Reconciled audit |
| P1 | Reconciled audit conflict: collapsible over-engineered | Reconciled audit |
| P2 | Missing: `requiresApprovalBeyondScope` field | New recommendation |
| P2 | Missing: tool metrics telemetry | New recommendation |
| P2 | Missing: scope violations counter | New recommendation |
| P2 | Missing: validator specialist | New recommendation |

### 1.3 Where All 4 Agreed

| # | Finding | Agreement |
|---|---------|-----------|
| 1 | State machine race condition | All 4 flagged as P0 |
| 2 | Testing is inadequate | All 4 gave low scores |
| 3 | Architecture is good | All 4 praised modular design |
| 4 | Tool-level gating is correct | All 4 agreed scout→coder→reviewer |
| 5 | Peek overlay: defer or remove | All 4 (user: skip, meta: backlog, GPT: remove) |

### 1.4 Action Plan Summary

| Phase | Tasks | Effort | Files |
|-------|-------|--------|-------|
| Phase 1 (Fix Broken) | 4 tasks | 5-6 hrs | `activity-feed.ts`, `delegate-tool.ts`, `test-unit.test.ts` |
| Phase 2 (Simplify) | 4 tasks | 4-5 hrs | `specialists.ts`, `types.ts`, `scope-guard.ts`, `activity-feed.ts` |
| Phase 3 (Test) | 3 tasks | 4-5 hrs | `test-mock-e2e.ts`, `test-unit.test.ts`, `delegate-tool.ts` |
| **Total** | **11 tasks** | **13-16 hrs** | — |

### 1.5 Grades

| Category | Codex | Sonnet | GPT | Meta |
|----------|-------|--------|-----|------|
| Architecture | B+ | A- | 8.5/10 | — |
| SDK Compliance | B+ | B | 7.5/10 | — |
| Code Quality | C+ | C | — | — |
| UI/UX | B | — | 7/10 | — |
| Testability | D+ | D+ | 5/10 | — |
| Production Ready | — | — | 6.5/10 | 8.5/10 if implemented |

---

## 2. AUDIT SOURCES

### 2.1 Codex (Kimi-k2.6)

**Role:** SDK compliance + UI/UX + Code quality expert
**Files read:** All 17 files in orchestrator directory + execution trace + SDK type definitions
**Method:** Read all TypeScript files, inspected `@earendil-works/pi-coding-agent` SDK types, traced execution flow through `delegate()` → `runSubagent()` → `session.subscribe()` → `parseTextForFeed()` → `renderActivityFeed()`

**Key findings:** State machine race condition, peek overlay disconnected, scope extraction missing, SDK API risks

### 2.2 Sonnet 4.6

**Role:** Code review + architecture deep-dive
**Files read:** Key files + previous `AUDIT-REVIEW-2026-06-13.md`
**Method:** Deep code inspection, identified test divergence (unit tests inline old mutating code while actual exports are immutable), found module-level mutable exports at risk under hot reload

**Key findings:** Tests test dead code, `_orchestratorActivity` concurrent overwrite, peek content replay missing, progress dots format mismatch

### 2.3 GPT-5.x

**Role:** Pi-native architecture + philosophy alignment
**Files read:** Execution trace + architecture docs
**Method:** Evaluated against Pi SDK philosophy (tool-level > prompt-level, cache conservation), assessed cache efficiency, reviewed UX against attention surface limit

**Key findings:** Scout bash defeats cache, `MAX_RAW_TEXT` too large, scope format too rigid, 20-30% of code could be removed

### 2.4 Meta-Assessor (4th Audit)

**Role:** Audit of the reconciled audit document
**Method:** Reviewed the reconciled audit itself, not fresh code. Identified conflicts between user decisions and reconciled plan. Proposed simplifications.

**Key findings:** Peek overlay should not be in Phase 1 (conflicts with user "skip"), collapsible steps over-engineered, missing tool metrics, missing scope approval field

---

## 3. WHAT WAS FOUND

### 3.1 P0 Issues — All 4 Audits Agreed

#### Issue 1: State Machine Race Condition
**File:** `activity-feed.ts` (lines ~230-250)
**Severity:** P0
**Found by:** All 4 audits

**Current broken code:**
```typescript
// tool_execution_update handler — DIRECT MUTATION
if (event.partialResult && feed.steps.length > 0) {
    const activeStep = feed.steps[feed.currentStep];
    const lastSub = activeStep.substeps[activeStep.substeps.length - 1];
    lastSub.outputPreview = preview; // ← MUTATES IN PLACE
}
```

**Why it's broken:**
- The `feed` object is reassigned by other handlers (`parseTextForFeed`, `setToolDetail`, `clearToolDetail`)
- But `tool_execution_update` mutates the OLD object's nested array
- The 80ms render timer reads `feed` concurrently and sees inconsistent state

**Visual effect:**
```
BEFORE (broken):
  ⠋ Step 2: Check token validation
    ✓ Read src/auth/validate.ts
    ⠋ Read src/auth/validate.ts  ← WRONG: shows stale "Reading" instead of preview
        ⠋ Running: cat src/auth/validate.ts
    ○ Find missing expiry check

AFTER (fixed):
  ⠋ Step 2: Check token validation
    ✓ Read src/auth/validate.ts
    ⠋ Read src/auth/validate.ts
        ⠋ const x = 1;  ← CORRECT: shows live preview
    ○ Find missing expiry check
```

---

#### Issue 2: Testing Inadequate
**File:** `test-unit.test.ts`
**Severity:** P0
**Found by:** All 4 audits

**Current broken code:**
```typescript
// test-unit.test.ts — inlines OLD mutating version
function addStep(state: ActivityFeedState, label: string): void {
    state.steps.push({ label, completed: false, substeps: [] }); // ← MUTATES
}

// activity-feed.ts — actual export is IMMUTABLE
export function addStep(state: ActivityFeedState, label: string): ActivityFeedState {
    return { ...state, steps: [...state.steps, newStep] }; // ← RETURNS NEW STATE
}
```

**Why it's broken:**
- Tests pass but test dead code
- The actual implementation changed to immutable reducer pattern
- Tests weren't updated to import the real exports
- Gives false confidence — "all tests pass" but code has race conditions

**Impact:** Junior developers see green tests and think code is solid. It's not.

---

### 3.2 P0 Issues — Found by 1-2 Audits

#### Issue 3: `_orchestratorActivity` Concurrent Overwrite
**File:** `delegate-tool.ts` (line ~42)
**Severity:** P0
**Found by:** Sonnet 4.6 + Meta-assessor

**Current broken code:**
```typescript
// Module-level variable — shared across all delegations
let _orchestratorActivity: ReturnType<typeof createOrchestratorActivity> | null = null;

// In execute():
_orchestratorActivity = createOrchestratorActivity(stepName);
```

**Why it's broken:**
- If two delegations run concurrently, second overwrites first
- The `incrementDelegationCount` guard suggests concurrent delegations are possible
- First delegation's plan panel updates get lost

**Visual effect:**
```
BEFORE (broken):
Plan: ◆ Fix auth bug  ●○○ 1/3  45s
  ⠋ Scout: investigate auth  ← WRONG: shows scout label when coder is running
  ○ Coder: fix token expiry
  ○ Reviewer: verify

AFTER (fixed):
Plan: ◆ Fix auth bug  ●○○ 1/3  45s
  ✓ Scout: investigate auth (25s)
  ⠋ Coder: fix token expiry  ← CORRECT: shows coder label
  ○ Reviewer: verify
```

---

### 3.3 P1 Issues

#### Issue 4: Scout Has `bash` (Cache Inefficiency)
**File:** `specialists.ts` (line ~95)
**Severity:** P1
**Found by:** GPT-5.x + Meta-assessor

**Current code:**
```typescript
scout: {
    tools: ["read", "bash"],
    systemPrompt: "Use grep/find to locate code..."
    // But has no grep or find tool!
}
```

**Why it's bad:**
- Scout's instructions say "use grep/find" but it only has `bash`
- So it runs `rg foo`, `find .`, `cat file.ts` through bash
- Pi can't deduplicate bash strings for cache — each command is unique
- Wastes tokens on every investigation

**Visual effect:**
```
BEFORE (bash):
  ✓ Scout: Read auth files (25s)
    ✓ Running: rg --glob '*.ts' auth
    ✓ Running: cat src/auth/middleware.ts
    ✓ Running: grep -n 'verifyToken' src/auth.ts
    ✓ Running: find . -name '*test*' -type f

AFTER (tools):
  ✓ Scout: Read auth files (25s)
    ✓ Search: auth (glob: *.ts)
    ✓ Read src/auth/middleware.ts
    ✓ Search: verifyToken
    ✓ Find: *test*
```

---

#### Issue 5: Progress Dots Format Mismatch
**File:** `plan-panel.ts` (line ~220)
**Severity:** P1
**Found by:** Sonnet 4.6

**Current code:**
```typescript
// plan-panel.ts renders:
const prog = `● ${completedCount}/${total}`; // ← "● 2/4"

// SPEC-UI.md requires:
// ●○○ 2/4 — one dot per step
```

**Visual effect:**
```
Plan panel (current):  ● 2/4
Chat (correct):        ●○○ 2/4

Inconsistent between layers.
```

---

#### Issue 6: `MAX_RAW_TEXT` Too Large
**File:** `activity-feed.ts` (line ~95)
**Severity:** P1
**Found by:** GPT-5.x

**Current code:**
```typescript
const MAX_RAW_TEXT = 10_000;
```

**Why it's bad:**
- 10K per subagent × 10 subagents = 100K accumulated text
- Stored in memory but never used after parsing
- Wastes memory and token budget

**Fix:**
```typescript
const MAX_RAW_TEXT = 3_000; // ← enough for goal + steps + few substeps
```

---

### 3.4 P2 Issues

#### Issue 7: `require()` in Render Callbacks
**File:** `delegate-tool.ts` (lines ~82, ~97)
**Severity:** P2
**Found by:** Sonnet 4.6

**Current code:**
```typescript
renderCall(args: any, theme: any, context: any) {
    const comp = context.lastComponent ?? 
        new (require("@earendil-works/pi-tui").Text)("", 0, 0); // ← dynamic require every frame
}
```

**Fix:**
```typescript
import { Text } from "@earendil-works/pi-tui";
// ...
const comp = new Text("", 0, 0);
```

---

#### Issue 8: Scope Format Too Rigid
**File:** `types.ts` (line ~45)
**Severity:** P2
**Found by:** GPT-5.x + Meta-assessor

**Current code:**
```typescript
export interface Scope {
    filesToModify: string[];
    filesToCreate: string[];
    changeType: "single-file" | "multi-file";
    maxLinesPerFile: number;
}
```

**Fix:**
```typescript
export interface Scope {
    filesToModify: string[];
    filesToCreate: string[];
    directories: string[];      // ← NEW
    maxFiles: number;           // ← NEW
    requiresApprovalBeyondScope: boolean; // ← NEW (meta-assessor)
    changeType: "single-file" | "multi-file";
    maxLinesPerFile: number;
}
```

---

## 4. AGREEMENTS & CONFLICTS

### 4.1 All 4 Agreed (High Confidence)

| # | Topic | Consensus | Confidence |
|---|-------|-----------|------------|
| 1 | State machine race condition | P0 — immutable reducer needed | **Certain** |
| 2 | Testing inadequate | D+/5/10 — needs mock harness | **Certain** |
| 3 | Architecture good | B+ to 8.5/10 — modular design correct | **Certain** |
| 4 | Tool-level gating correct | scout→coder→reviewer pattern | **Certain** |
| 5 | Peek overlay: defer/remove | All agree: not priority | **Certain** |

### 4.2 Conflicts (Resolved)

| Topic | Codex | Sonnet | GPT | Meta | **User Decision** |
|-------|-------|--------|-----|------|-------------------|
| Peek overlay | Fix | Fix | Remove | Backlog | **Backlog** |
| Scout bash | Keep | — | Remove | Remove | **Remove, add tools** |
| Scope format | Files | — | Directories | Hybrid+approval | **Hybrid + approval field** |
| Substep collapse | Visible | — | Compress | Auto-only | **Auto-behavior (B)** |
| Activity feed | Full | — | Compress | Compress | **Compress** |
| Testing order | Tests first | Fix dead code | Snapshots | Fix first | **Fix → refactor → test** |

---

## 5. USER DECISIONS

### 5.1 Decisions (Final Reconciled)

| # | Decision | Driver | Rationale |
|---|----------|--------|-----------|
| 1 | **Peek overlay:** Backlog | **User + Meta** | "Not immediate priority." Meta: "Do not spend engineering effort fixing a surface you're considering removing." |
| 2 | **Scout bash:** Remove, add `find`/`grep`/`ls` | **User** | "Follow GPT-5.x advice." Coder keeps bash for patches/scripts. |
| 3 | **Scope format:** Hybrid + `requiresApprovalBeyondScope` | **User + Meta** | Hybrid for flexibility. Meta: add approval field for scope creep. |
| 4 | **Substep collapse:** Auto-behavior only | **User + Meta** | Active expanded, completed collapsed. No shortcuts. No persistence. |
| 5 | **Activity feed:** Compressed | **User** | Active step full detail. Completed shows count + reports. |
| 6 | **Testing:** Fix code → refactor → test | **User** | "Fix first what's broken. Then refactor. Tests for refactored code." |

---

## 6. META-AUDIT CORRECTIONS

### 6.1 Correction 1: Peek Overlay Removed from Phase 1

**Original reconciled audit:** Peek overlay in Phase 1 (Task 3)
**Meta-audit finding:** "Conflicts with user 'skip for now'. If truly deferred, move to backlog."
**Action:** Moved peek overlay from Phase 1 to Backlog

### 6.2 Correction 2: Collapsible Steps Simplified

**Original reconciled audit:** Toggleable with `1`-`9` shortcuts (2 hours)
**Meta-audit finding:** "Over-engineered. No shortcuts, no persistence, no extra complexity."
**User decision:** Auto-behavior only (Option B)
**Action:** Changed to auto-expand active + auto-collapse completed. No shortcuts.

### 6.3 New Addition: Scope Approval Field

**Meta-audit recommendation:** Add `requiresApprovalBeyondScope: boolean`
**Purpose:** When coder touches files outside scope, requires orchestrator approval
**Example:**
```typescript
{
    directories: ["src/auth"],
    maxFiles: 10,
    requiresApprovalBeyondScope: true
}
```

### 6.4 New Addition: Tool Metrics

**Meta-audit recommendation:** Track tool calls per specialist
**Example:**
```typescript
{
    readCalls: 12,
    grepCalls: 8,
    bashCalls: 0
}
```

### 6.5 New Addition: Scope Violations Counter

**Meta-audit recommendation:** Track `scopeBlocks: 3` during execution
**Purpose:** Most valuable orchestrator metric

### 6.6 New Addition: Validator Specialist

**Meta-audit recommendation:** New role: `read`, `bash` only for tests
**Purpose:** Separate validation from review

---

## 7. PHASE 1: FIX BROKEN (This Week)

### 7.1 Task 1: Immutable State Machine
**File:** `activity-feed.ts`
**Effort:** 2-3 hours
**Audits:** All 4
**Driver:** All 4 audits

**Current broken:**
```typescript
// tool_execution_update handler — direct mutation
lastSub.outputPreview = preview;
```

**After fix:**
```typescript
// Pure function: returns new state, never mutates
export function setOutputPreview(
    state: ActivityFeedState, 
    preview: string
): ActivityFeedState {
    if (state.currentStep < 0 || state.currentStep >= state.steps.length) {
        return state;
    }
    const step = state.steps[state.currentStep];
    if (step.substeps.length === 0) return state;
    
    // Find active (first uncompleted) substep
    let activeIdx = -1;
    for (let i = 0; i < step.substeps.length; i++) {
        if (!step.substeps[i].completed) { activeIdx = i; break; }
    }
    if (activeIdx < 0) return state;
    
    // Return NEW state, never mutate
    const newSubsteps = step.substeps.map((sub, i) =>
        i === activeIdx ? { ...sub, outputPreview: preview } : sub
    );
    const newSteps = state.steps.map((s, i) =>
        i === state.currentStep ? { ...s, substeps: newSubsteps } : s
    );
    return { ...state, steps: newSteps };
}

// In event handler:
feed = setOutputPreview(feed, preview); // ← reassign, never mutate
```

**Visual impact:**
```
BEFORE (broken):
  ⠋ Step 2: Check token validation
    ✓ Read src/auth/validate.ts
    ⠋ Read src/auth/validate.ts  ← WRONG: stale preview
        ⠋ Running: cat src/auth/validate.ts

AFTER (fixed):
  ⠋ Step 2: Check token validation
    ✓ Read src/auth/validate.ts
    ⠋ Read src/auth/validate.ts
        ⠋ const x = 1;  ← CORRECT: live preview
```

---

### 7.2 Task 2: Fix `_orchestratorActivity` Concurrent Overwrite
**File:** `delegate-tool.ts`
**Effort:** 1 hour
**Audits:** Sonnet 4.6 + Meta
**Driver:** Sonnet 4.6

**Current broken:**
```typescript
// Module-level variable — shared across all delegations
let _orchestratorActivity: ReturnType<typeof createOrchestratorActivity> | null = null;

// In execute():
_orchestratorActivity = createOrchestratorActivity(stepName);
```

**After fix:**
```typescript
// Remove module-level variable entirely
// Move to local within execute()

async execute(toolCallId: string, params: any, ...) {
    // ... validation ...
    
    const orchestratorActivity = createOrchestratorActivity(stepName);
    // ← local, no concurrent overwrite
    
    incrementDelegationCount();
    const startTime = Date.now();
    
    const result = await runSubagent(
        specialist, params.task, ctx.cwd,
        { modelRegistry: ctx.modelRegistry, model: ctx.model },
        signal, onUpdate, orchestratorActivity, // ← pass local, not module
        scopeToUse, orchestratorUi,
    );
    
    // ... rest of execute ...
    
    completeOrchestratorStep(orchestratorActivity); // ← local
    // ...
}
```

**Visual impact:**
```
BEFORE (broken):
Plan: ◆ Fix auth bug  ●○○ 1/3  45s
  ⠋ Scout: investigate auth  ← WRONG: shows scout when coder is running
  ○ Coder: fix token expiry
  ○ Reviewer: verify

AFTER (fixed):
Plan: ◆ Fix auth bug  ●○○ 1/3  45s
  ✓ Scout: investigate auth (25s)
  ⠋ Coder: fix token expiry  ← CORRECT
  ○ Reviewer: verify
```

---

### 7.3 Task 3: Fix Dead Unit Tests
**File:** `test-unit.test.ts`
**Effort:** 1-2 hours
**Audits:** Sonnet 4.6 + Meta
**Driver:** Sonnet 4.6

**Current broken:**
```typescript
// test-unit.test.ts — inlines OLD mutating version
function addStep(state: ActivityFeedState, label: string): void {
    state.steps.push({ label, completed: false, substeps: [] }); // ← MUTATES
}

// activity-feed.ts — actual export is IMMUTABLE
export function addStep(state: ActivityFeedState, label: string): ActivityFeedState {
    return { ...state, steps: [...state.steps, newStep] }; // ← RETURNS NEW STATE
}
```

**After fix:**
```typescript
// Import actual exports instead of inlining
import { addStep, completeLastSubstep, createActivityFeed } from "./activity-feed";

test("addStep returns new state, does not mutate", () => {
    const state = createActivityFeed();
    const newState = addStep(state, "Test step");
    
    expect(newState).not.toBe(state); // new object
    expect(newState.steps).not.toBe(state.steps); // new array
    expect(state.steps).toHaveLength(0); // original unchanged
    expect(newState.steps).toHaveLength(1);
});

test("completeLastSubstep marks active substep complete", () => {
    let state = createActivityFeed();
    state = addStep(state, "Step 1");
    state = addSubstep(state, "Read file");
    state = completeLastSubstep(state, "file content");
    
    expect(state.steps[0].substeps[0].completed).toBe(true);
    expect(state.steps[0].substeps[0].outputPreview).toBe("file content");
});
```

---

### 7.4 Task 4: Static Imports
**File:** `delegate-tool.ts`
**Effort:** 30 minutes
**Audits:** Sonnet 4.6
**Driver:** Sonnet 4.6

**Current:**
```typescript
const comp = new (require("@earendil-works/pi-tui").Text)("", 0, 0);
```

**After:**
```typescript
import { Text } from "@earendil-works/pi-tui";
// ...
const comp = new Text("", 0, 0);
```

---

## 8. PHASE 2: SIMPLIFY (Next Week)

### 8.1 Task 5: Scout Tools — Remove bash, Add find/grep/ls
**File:** `specialists.ts`
**Effort:** 30 minutes
**Audits:** GPT-5.x + Meta
**Driver:** User + GPT-5.x

**Current:**
```typescript
scout: {
    tools: ["read", "bash"],
    systemPrompt: "Use grep/find to locate code..."
}
```

**After:**
```typescript
scout: {
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: `
You are a read-only codebase investigator.

Your tools:
- read: examine file contents
- grep: search for patterns in code
- find: locate files by name/pattern
- ls: list directory contents

Rules:
- Use grep (not bash+rg) to search code
- Use find (not bash+find) to locate files
- Use read (not bash+cat) to examine files
- Use ls (not bash+ls) to list directories
- NEVER use bash for file operations

${TERSE_INSTRUCTION}`
}
```

**Visual impact:**
```
BEFORE (bash):
  ✓ Scout: Read auth files (25s)
    ✓ Running: rg --glob '*.ts' auth
    ✓ Running: cat src/auth/middleware.ts
    ✓ Running: grep -n 'verifyToken' src/auth.ts
    ✓ Running: find . -name '*test*' -type f

AFTER (tools):
  ✓ Scout: Read auth files (25s)
    ✓ Search: auth (glob: *.ts)
    ✓ Read src/auth/middleware.ts
    ✓ Search: verifyToken
    ✓ Find: *test*
```

---

### 8.2 Task 6: Coder bash Restricted
**File:** `specialists.ts`
**Effort:** 15 minutes
**Driver:** User + GPT-5.x

**Current:**
```typescript
coder: {
    tools: ["read", "bash", "edit", "write"],
    systemPrompt: "Use edit/write for file changes, bash for verification"
}
```

**After:**
```typescript
coder: {
    tools: ["read", "bash", "edit", "write"],
    systemPrompt: `
You are an implementation specialist.

Rules:
- ALWAYS use edit or write to modify files
- NEVER use bash+sed, bash+awk, bash+perl, bash+python for file modifications
- Use bash ONLY for:
  - Running tests (npm test, pytest, etc.)
  - Compilation (tsc, cargo build, etc.)
  - Running patch scripts (patch -p1 < fix.diff)
  - GitHub CLI (gh pr create, gh issue list)
  - Verification commands
- Use read (not bash+cat) to read files
- Use grep (not bash+rg) to search

${TERSE_INSTRUCTION}`
}
```

---

### 8.3 Task 7: Hybrid Scope Format + Approval Field
**File:** `types.ts` + `scope-guard.ts`
**Effort:** 1 hour
**Driver:** User + Codex + Meta

**Current:**
```typescript
export interface Scope {
    filesToModify: string[];
    filesToCreate: string[];
    changeType: "single-file" | "multi-file";
    maxLinesPerFile: number;
}
```

**After:**
```typescript
export interface Scope {
    filesToModify: string[];
    filesToCreate: string[];
    directories: string[];      // ← NEW
    maxFiles: number;           // ← NEW
    requiresApprovalBeyondScope: boolean; // ← NEW (meta)
    changeType: "single-file" | "multi-file";
    maxLinesPerFile: number;
}
```

**Scope-guard logic:**
```typescript
function isPathAllowed(path: string, scope: Scope): boolean {
    if (scope.filesToModify.includes(path)) return true;
    if (scope.filesToCreate.includes(path)) return true;
    
    for (const dir of scope.directories) {
        if (path.startsWith(dir)) {
            const touchedCount = touchedFiles.filter(f => f.startsWith(dir)).length;
            if (touchedCount < scope.maxFiles) return true;
        }
    }
    return false;
}
```

---

### 8.4 Task 8: Compress Activity Feed + Auto Collapse
**File:** `activity-feed.ts`
**Effort:** 1 hour
**Driver:** User + GPT-5.x + Meta

**Current (full):**
```
◆ Investigate auth middleware
●○○ 1/3
  ✓ Step 1: Read auth files (25s)
    ✓ Read src/auth/middleware.ts
    ✓ Search: verifyToken
    ✓ Read src/auth/validate.ts
    ✓ Find: test files
    ✓ Report: Found expired token bug
    ✓ Report: Noted hardcoded secret issue
  ⠋ Step 2: Check token validation
    ⠋ Read src/auth/validate.ts
        ⠋ Running: cat src/auth/validate.ts
    ○ Check JWT decode flow
    ○ Find missing expiry check
  ○ Step 3: Find related tests
```

**After (compressed + auto collapse):**
```
◆ Investigate auth middleware
●○○ 1/3
  ✓ Step 1: Read auth files (25s) — 6 substeps, 2 reports
    ✓ Report: Found expired token bug
    ✓ Report: Noted hardcoded secret issue
  ⠋ Step 2: Check token validation
    ⠋ Read src/auth/validate.ts
        ⠋ Running: cat src/auth/validate.ts
    ○ Check JWT decode flow
    ○ Find missing expiry check
  ○ Step 3: Find related tests
```

**Change:**
- Completed steps: show count + reports only
- Active step: show full substeps
- No shortcuts, no persistence, no manual toggle
- Auto-behavior: active expanded, completed collapsed

---

## 9. PHASE 3: TEST & HARDEN (Following Week)

### 9.1 Task 9: Mock E2E Harness
**File:** `test-mock-e2e.ts`
**Effort:** 3 hours
**Driver:** All 4 audits

**Concept:**
```typescript
const MOCK_EVENTS = [
    { type: "text_delta", delta: "## Goal: Test\n## Steps:\nStep 1: Read file\n" },
    { type: "tool_execution_start", toolName: "read", args: { path: "test.ts" } },
    { type: "tool_execution_update", partialResult: "const x = 1;" },
    { type: "tool_execution_end", toolName: "read", result: { content: "const x = 1;" } },
    { type: "message_end", message: { role: "assistant" } },
];

function createMockSession(events: any[]) {
    return {
        subscribe: (cb: (event: any) => void) => {
            let i = 0;
            const interval = setInterval(() => {
                if (i >= events.length) { clearInterval(interval); return; }
                cb(events[i++]);
            }, 500);
            return () => clearInterval(interval);
        },
        prompt: async () => {},
        abort: () => {},
        dispose: () => {},
    };
}
```

**Benefit:** Junior devs can run `npx tsx test-mock-e2e.ts` without API keys.

---

### 9.2 Task 10: Reducer Tests + Snapshot Tests
**File:** `test-unit.test.ts`
**Effort:** 2 hours
**Driver:** Sonnet 4.6 + Meta

**Reducer tests:**
```typescript
test("addStep returns new state", () => {
    const state = createActivityFeed();
    const newState = addStep(state, "Test step");
    expect(newState).not.toBe(state);
    expect(newState.steps).toHaveLength(1);
});
```

**Snapshot tests:**
```typescript
test("renderActivityFeed: empty state", () => {
    const state = createActivityFeed();
    const output = renderActivityFeed("scout", state);
    expect(output).toMatchSnapshot();
});

test("renderActivityFeed: running state", () => {
    let state = createActivityFeed();
    state = addStep(state, "Step 1");
    state = addSubstep(state, "Read file");
    const output = renderActivityFeed("scout", state);
    expect(output).toMatchSnapshot();
});
```

---

### 9.3 Task 11: Tool Metrics + Scope Violations
**File:** `delegate-tool.ts` + `types.ts`
**Effort:** 1 hour
**Driver:** Meta-assessor

**Tool metrics:**
```typescript
// Per-delegation metrics
interface DelegationMetrics {
    readCalls: number;
    grepCalls: number;
    findCalls: number;
    editCalls: number;
    writeCalls: number;
    bashCalls: number;
    scopeBlocks: number;
}
```

**Visual:**
```
Scout
read: 7
search: 12
find: 3
scope blocks: 0
```

---

## 10. BACKLOG

### 10.1 Peek Overlay

**Status:** Deferred indefinitely
**Reason:** User: "Not immediate priority." Meta: "Do not spend engineering effort fixing a surface you're considering removing."
**Action:** If needed in future, implement buffer + replay (1 hour). If not needed, delete 230-line module.

### 10.2 Manual Collapse Controls

**Status:** Superseded by auto-behavior
**Reason:** Meta: "No shortcuts, no persistence, no extra complexity."
**Action:** Auto-behavior (active expanded, completed collapsed) is sufficient. If users request manual control later, add shortcuts.

### 10.3 Validator Specialist

**Status:** Future consideration
**Role:** `read`, `bash` only — for running tests and validation
**Action:** Add if workflow needs separate validation step after reviewer.

---

## 11. APPENDIX

### 11.1 Grades

| Category | Codex | Sonnet | GPT | Meta |
|----------|-------|--------|-----|------|
| Architecture | B+ | A- | 8.5/10 | — |
| SDK Compliance | B+ | B | 7.5/10 | — |
| Code Quality | C+ | C | — | — |
| UI/UX | B | — | 7/10 | — |
| Testability | D+ | D+ | 5/10 | — |
| Production Ready | — | — | 6.5/10 | 8.5/10 if implemented |

### 11.2 Estimated Total Effort

| Phase | Effort | Tasks |
|-------|--------|-------|
| Phase 1 (Fix Broken) | 5-6 hours | 4 tasks |
| Phase 2 (Simplify) | 4-5 hours | 4 tasks |
| Phase 3 (Test) | 4-5 hours | 3 tasks |
| **Total** | **13-16 hours** | **11 tasks** |

### 11.3 Files Modified

| Phase | Files |
|-------|-------|
| Phase 1 | `activity-feed.ts`, `delegate-tool.ts`, `test-unit.test.ts` |
| Phase 2 | `specialists.ts`, `types.ts`, `scope-guard.ts`, `activity-feed.ts` |
| Phase 3 | `test-mock-e2e.ts`, `test-unit.test.ts`, `delegate-tool.ts` |

### 11.4 Files in Audit Directory

| File | Size | Content |
|------|------|---------|
| `RECONCILED-AUDIT.md` | 35KB | This file — combined overview + detailed |
| `AUDIT-REVIEW-2026-06-14.md` | 11KB | Previous audit review |
| `20260614_1140_kimi-k2.6.txt` | 19KB | Original Kimi-k2.6 audit |
| `20260614_1140_sonnet_4.6.txt` | 14KB | Original Sonnet 4.6 audit |
| `20260614_1140_gpt5.x.txt` | 7KB | Original GPT-5.x audit |

### 11.5 Revision History

| Revision | Date | Changes |
|----------|------|---------|
| 1 | 2026-06-14 | Initial combined audit (overview + detailed) |
| 2 | 2026-06-14 | Meta-audit corrections: peek to backlog, collapsible auto-only, added approval field + metrics |

---

*Generated: 2026-06-14*
*Audits: Kimi-k2.6 + Sonnet 4.6 + GPT-5.x + Meta-assessor*
*Reconciliation: Codex + User decisions*
*Revisions: 2*
