# Orchestrator Extension — Refactoring Plan

> **Source:** Structural audit of `orchestrator.ts` (1663 lines) vs design spec
> `ORCHESTRATION-UI-DESIGN.md`, compared against community implementations.
> **Updated:** 2026-06-11 — Added scope-guard.ts, audit findings, caveman prompt upgrade

---

## 1. Current State: Structural Problems

### 1.1 Monolith — 1663 Lines, One File

| Metric | Value |
|--------|-------|
| Total lines | 1663 |
| Exported symbols | 1 (`export default function(pi)`) |
| Module-private functions | 40+ |
| Module-private interfaces/types | 8 |
| Module-private variables | 16 |
| Import statements | 6 (from 6 packages) |

All concerns mixed in one file — plan panel, activity feed, subagent runner,
specialist definitions, tool registration, command registration, debug logging,
box-drawing utilities.

### 1.2 Concern-Coupling Matrix

Every function in `orchestrator.ts` is coupled to every other function via
shared module-level state:

```
Module-level vars:               Used by:
──────────────────────────────────────────────────
orchestratorActivity             getOrchestratorActivity, resetOrchestratorActivity,
                                 renderOrchestratorActivity, renderCombinedProgress,
                                 runSubagent, delegate.execute

planState, planContainer,        setupPlanPanel, renderPlanPanel, completePlanStep,
planTimer, planTUI               errorPlanStep, clearPlanPanel, buildPlanPanel,
                                 startPlanTimer, stopPlanTimer

_batchLoadSubagent,              isSubagentContext, runSubagent, delegate.execute,
_inSubagentExecution             before_agent_start, tool_call handler
```

Changing any one concern risks breaking unrelated functionality.

### 1.3 Design Spec vs Implementation: Gaps

| Design Spec Says | Implementation Does | Impact |
|---|---|---|
| Layer 1 + Layer 2 are separate concerns | Both rendered in same functions, sharing `planState` | Can't modify one without touching other |
| `setHeader(factory)` replaces pi's header | `buildPlanPanel()` uses `Container` directly, tight to TUI API | Hard to test without TUI instance |
| Activity feed NEVER collapses | `renderActivityFeed()` handles collapse logic | Extra complexity not in spec |
| State reset on `before_agent_start` | Also resets inside `delegate.execute` — dual reset paths | Race condition risk |
| 5 specialists in roster | 5 specialists defined inline, no extensibility | Adding specialist means editing core file |
| **No scope enforcement** | Coder subagent has unrestricted write access | Can create monoliths, touch unintended files |

### 1.4 Comparison with Community Implementations

**Source:** `@ifi/pi-extension-subagents` (v0.5.1)
- Repo: `github.com/ifiokjr/oh-pi/tree/main/packages/subagents`
- npm: `https://www.npmjs.com/package/@ifi/pi-extension-subagents?activeTab=code`
- Architecture: 43 TS source files, 1 concern = 1 file
- Key pattern: schemas (`schemas.ts`, `types.ts`) extracted as shared Layer 0,
  execution layer separated from chain engine, agent management as CRUD module,
  UI rendering extracted to `render.ts` + `render-helpers.ts`
- File count demonstrates intentional modularity — each file has single reason to change

**Source:** `HazAT/pi-interactive-subagents` (v3.7.2)
- Repo: `https://github.com/hazat/pi-interactive-subagents`
- Architecture: 6 core TS files, coarser granularity but still clean separation
- `cmux.ts` (1334 lines) — standalone multiplexer abstraction, zero coupling to rest
- `activity.ts` (511 lines) — pure state tracking, no rendering
- `status.ts` (513 lines) — pure state machine widget, no business logic
- `subagent-done.ts` (324 lines) — completion detection, single responsibility
- Each file independently testable, replaceable

**Your orchestrator.ts vs both:**
- @ifi and HazAT both split by **change frequency** (UI changes faster than execution
  logic, specialist definitions change slower than tool handlers)
- Your orchestrator.ts splits by **nothing** — all frequencies mixed

---

## 2. Target File Structure

### Orchestrator Module (refactored from orchestrator.ts)

```
agent/extensions/orchestrator/
├── index.ts                    # Extension bootstrap, pi.on() + pi.registerTool() wiring
├── types.ts                    # Shared interfaces/types (Specialist, ActivityFeedState, etc.)
├── plan-panel.ts               # Layer 1: Plan panel header (setHeader lifecycle)
├── activity-feed.ts            # Layer 2: Activity feed state machine + rendering
├── specialists.ts              # Specialist roster definitions + ACTIVITY_FEED_INSTRUCTION
├── subagent-runner.ts          # runSubagent(), subagent isolation via env var
│                               # MODIFIED: writes .pi/scope.json before creating subagent
├── delegate-tool.ts            # delegate() tool registration: renderCall, renderResult, execute
├── commands.ts                 # /orchestrate, /specialists slash commands
├── ui-utils.ts                 # Box-drawing helpers (wrapInBox, wrapInBoxStatic)
└── debug.ts                    # debugLog(), DEBUG_LOG_DIR constants
```

### Global Enforcement Extension (NEW — not extracted from orchestrator.ts)

```
agent/extensions/
├── orchestrator/               # (the module above)
├── scope-guard.ts              # NEW: tool_call hook, blocks writes outside scope
├── lint-guard.ts               # existing: blocks sed/awk, auto-lints after edits
└── token-saver.ts              # existing: token compression
```

`scope-guard.ts` is NOT inside `orchestrator/`. It's a sibling extension that loads
in ALL sessions (including subagent sessions). It reads `.pi/scope.json` to know
which files the current subagent is allowed to modify. No scope file = guard inactive.

### 2.1 File Responsibilities

#### `index.ts` (~60 lines)
- **Exports:** `export default function(pi: ExtensionAPI)`
- **Responsibilities:**
  - `pi.on("before_agent_start")` — reset state, strip tools, inject system prompt
  - `pi.on("tool_call")` — block non-delegate calls
  - Import and wire all other modules
- **Source:** Lines ~1370-1450 of current orchestrator.ts

#### `types.ts` (~50 lines)
- **Exports:** All interfaces and types
- **Responsibilities:**
  - `OrchestratorStep`, `OrchestratorActivity`
  - `ActivityFeedState`, `Step`, `Substep`
  - `Specialist` interface
  - `SubagentContext` interface
  - `PlanStep` type for plan panel
  - `Scope` interface (NEW: `{ filesToModify, filesToCreate, changeType }`)
- **Source:** Lines 361-370, 552-570, 949-955, 1118-1119 of current orchestrator.ts

#### `plan-panel.ts` (~150 lines)
- **Exports:**
  - `setupPlanPanel(goal, stepLabels, ctx): void`
  - `renderPlanPanel(): void`
  - `completePlanStep(ctx): void`
  - `errorPlanStep(ctx): void`
  - `clearPlanPanel(ctx): void`
  - `buildPlanPanel(tui, theme): Container`
  - `renderPlanStatusText(): string`
- **Responsibilities:**
  - Layer 1: Orchestration Plan header widget
  - Timer management (startPlanTimer, stopPlanTimer)
  - Plan state management (planState module-level, NOT global)
- **Source:** Lines 126-355 of current orchestrator.ts
- **Note:** This is the ONLY module that touches `planContainer`, `planTimer`, `planTUI`

#### `activity-feed.ts` (~250 lines)
- **Exports:**
  - `createActivityFeed(): ActivityFeedState`
  - `parseTextForFeed(state, text): void`
  - `addStep(state, label): void`
  - `addSubstep(state, label): void`
  - `completeLastSubstep(state): void`
  - `completeCurrentStep(state): void`
  - `renderActivityFeed(name, state): string`
  - `renderCombinedProgress(orchestratorActivity, specialistName, feedState, goal?): string`
  - `toolCallToSubstep(toolName, input): string`
- **Responsibilities:**
  - Layer 2: Subagent tool blocks in chat history
  - Activity feed state machine (step/substep lifecycle)
  - Rendering activity feed with box-drawing
- **Source:** Lines 357-930 of current orchestrator.ts

#### `specialists.ts` (~80 lines)
- **Exports:**
  - `SPECIALISTS: Record<string, Specialist>`
  - `ACTIVITY_FEED_INSTRUCTION: string`
  - `TERSE_INSTRUCTION: string`
  - `getSpecialist(name): Specialist`
  - `listSpecialists(): string[]`
- **Responsibilities:**
  - Central roster of 5 specialists (scout, coder, reviewer, researcher, writer)
  - Activity feed instruction template for subagent prompts
  - Terse mode instruction
- **Source:** Lines 940-1110 of current orchestrator.ts
- **Note:** TERSE_INSTRUCTION updated to match original JuliusBrussee/caveman SKILL.md — includes Persistence, Rules with pattern + examples, Auto-Clarity, Boundaries, "Think short" for CoT

#### `subagent-runner.ts` (~200 lines)
- **Exports:**
  - `runSubagent(specialist, task, cwd, parentCtx?, signal?, onUpdate?, orchestratorActivity?, scope?)`
  - `isSubagentContext(): boolean`
  - `SUBAGENT_ENV_KEY: string`
- **Responsibilities:**
  - Subagent isolation via `PI_ORCHESTRATOR_SUBAGENT` env var
  - `createAgentSession()` lifecycle
  - **NEW: writes `.pi/scope.json` before creating coder subagent** — this activates
    scope-guard.ts for the subagent session
  - Session event subscription → activity feed updates
  - Output compression (`compressOutput`)
- **Source:** Lines 1121-1300 of current orchestrator.ts + ~20 lines NEW for scope writing

#### `delegate-tool.ts` (~200 lines)
- **Exports:**
  - `registerDelegateTool(pi, specialists, runSubagent): void`
  - Or returns the tool config object for `index.ts` to register
- **Responsibilities:**
  - `delegate` tool registration (parameters schema, renderCall, renderResult, execute)
  - Orchestrator activity management per tool call
  - Plan panel integration (calls plan-panel functions)
- **Source:** Lines 1450-1570 of current orchestrator.ts (inside the big `pi.registerTool` block)

#### `commands.ts` (~80 lines)
- **Exports:**
  - `registerCommands(pi): void`
- **Responsibilities:**
  - `/orchestrate <task>` — manual orchestration trigger
  - `/specialists` — list available specialists
- **Source:** Lines 1580-1640 of current orchestrator.ts

#### `ui-utils.ts` (~60 lines)
- **Exports:**
  - `wrapInBox(lines, boxWidth): string`
  - `wrapInBoxStatic(lines, boxWidth): string`
  - `formatDuration(ms): string`
- **Responsibilities:**
  - Pure rendering helpers, no state
- **Source:** Lines 401-425, 1652-1663 of current orchestrator.ts

#### `debug.ts` (~30 lines)
- **Exports:**
  - `debugLog(msg, data?): void`
  - `DEBUG_LOG_DIR: string`
- **Responsibilities:**
  - Debug logging to `/tmp/orchestrator-debug/`
- **Source:** Lines 64-76 of current orchestrator.ts

#### `scope-guard.ts` (~80 lines, NEW — not extracted from orchestrator.ts)
- **Exports:** `export default function(pi: ExtensionAPI)`
- **Responsibilities:**
  - `pi.on("tool_call")` — fires on EVERY write/edit in EVERY session
  - Reads `.pi/scope.json` (relative to cwd) — if file missing, silently allows all
  - If scope is set: checks file path against `scope.filesToModify` + `scope.filesToCreate`
  - Out-of-scope writes → `{ block: true, reason: "..." }` with file list
  - No scope file → tool_call handler returns undefined (pass-through, 0 overhead)
- **Source:** New file, modeled on `lint-guard.ts` (same `tool_call` + `block` pattern)

### 2.2 Dependency Graph

```
index.ts
  ├── types.ts          (shared types, no deps)
  ├── plan-panel.ts     (types)
  ├── activity-feed.ts  (types)
  ├── specialists.ts    (types)
  ├── subagent-runner.ts (types, specialists)
  ├── delegate-tool.ts  (types, plan-panel, activity-feed, subagent-runner)
  ├── commands.ts       (types, specialists)
  ├── ui-utils.ts       (no deps)
  └── debug.ts          (no deps)

--- separate, loaded in all sessions ---

scope-guard.ts      (no deps on orchestrator modules, only reads .pi/scope.json)
lint-guard.ts       (no deps on orchestrator modules)
token-saver.ts      (no deps on orchestrator modules)
```

Acyclic. Each file depends only on `types.ts` or on other files with clear
one-directional arrows. No circular imports. `scope-guard.ts` has ZERO coupling
to the orchestrator module.

---

## 3. Scope Handoff Flow (New Integration)

This is the key addition: how scout's plan becomes an enforceable boundary for coder.

```
delegate(scout, "investigate X")
  → scout outputs structured plan with scope section
  → e.g. "Files to modify: src/auth.ts, src/login.ts"

SYSTEM: PARSE SCOPE FROM SCOUT OUTPUT  ← NEW
  → extract filesToModify, filesToCreate
  → write to <cwd>/.pi/scope.json       ← NEW

delegate(coder, "implement X")
  → loader.reload() loads scope-guard.ts fresh
  → scope-guard.ts reads .pi/scope.json
  → coder tries to edit src/database.ts
  → scope-guard BLOCKS: "File not in scope"
  → coder must work within approved files or request scope expansion

delegate(reviewer, "review")
  → reviewer reads what was actually changed
  → checks against scope + spec
```

### Scope JSON format

```json
{
  "filesToModify": ["src/auth.ts", "src/login.ts"],
  "filesToCreate": ["src/auth-types.ts"],
  "changeType": "multi-file",
  "maxLinesPerFile": 400
}
```

### When scope is not set

- No `.pi/scope.json` file exists → scope-guard silently allows all writes
- This covers: direct pi use without orchestrator, quick single-file fixes,
  any scenario outside the scout→scope→coder flow

---

## 4. Refactoring Order (Safe Sequence)

The refactoring preserves behavior at every step. Each step produces a running
extension before proceeding.

### Phase 1: Extract pure utilities (no behavior change)

```
Step 1: Create orchestrator/ui-utils.ts     ← formatDuration, wrapInBox, wrapInBoxStatic
Step 2: Create orchestrator/debug.ts         ← debugLog
Step 3: Create orchestrator/types.ts          ← all interfaces/types + NEW Scope interface
Step 4: Create orchestrator/specialists.ts    ← SPECIALISTS, ACTIVITY_FEED_INSTRUCTION
```

Each: copy code, add import, verify extension loads.

### Phase 2: Create scope-guard.ts (new global extension)

```
Step 5: Create agent/extensions/scope-guard.ts  ← NEW, ~80 lines
         Mode: tool_call handler, no env var guard
         Reads .pi/scope.json, blocks out-of-scope writes
         No scope file = pass through
```

### Phase 3: Extract stateful modules

```
Step 6: Create orchestrator/subagent-runner.ts ← runSubagent + env var guard
         MODIFIED: accept scope param, write .pi/scope.json before subagent creation
Step 7: Create orchestrator/plan-panel.ts    ← all plan panel functions + module-level state
Step 8: Create orchestrator/activity-feed.ts ← all activity feed functions + module-level state
```

Each: copy code, add import to index.ts, keep original as thin re-export until
next step removes it.

### Phase 4: Extract registration

```
Step 9:  Create orchestrator/delegate-tool.ts ← delegate tool configuration
Step 10: Create orchestrator/commands.ts      ← /orchestrate, /specialists
Step 11: Strip orchestrator.ts to index.ts    ← only wiring remains
```

### Phase 5: Wire scope into delegate-execute

```
Step 12: Modify delegate-tool.ts's execute handler:
         - Pass scope from scout output to runSubagent()
         - runSubagent() writes .pi/scope.json before creating coder session
Step 13: Verify /orchestrate end-to-end with scope enforcement
```

### Phase 6: Test and verify

```
Step 14: Verify /orchestrate still works end-to-end
Step 15: Verify subagent isolation (env var guard)
Step 16: Verify plan panel renders correctly
Step 17: Verify activity feed updates in real-time
Step 18: Verify scope-guard blocks out-of-scope writes in subagent
Step 19: Verify scope-guard inactive when no scope file (direct pi use)
```

---

## 8. Execution Progress (2026-06-11)

### Phase 1: Pure Utilities — ✅ COMPLETE

| Step | File | Status | Lint |
|------|------|--------|------|
| 1 | `orchestrator/ui-utils.ts` | ✅ Created | ✅ Clean |
| 2 | `orchestrator/debug.ts` | ✅ Created | ✅ Clean |
| 3 | `orchestrator/types.ts` | ✅ Created — includes Scope interface | ✅ Clean |
| 4 | `orchestrator/specialists.ts` | ✅ Created — full caveman prompt from JuliusBrussee/caveman SKILL.md | ✅ Clean |

### Phase 2: Global Extensions — ✅ COMPLETE

| Step | File | Status | Lint |
|------|------|--------|------|
| 5 | `scope-guard.ts` | ✅ Created — tool_call hook, reads .pi/scope.json, blocks out-of-scope writes | ⚠️ Runtime-resolved (same as all pi extensions) |

### Phase 3: Stateful Modules — ✅ COMPLETE

| Step | File | Status | Lint |
|------|------|--------|------|
| 6 | `orchestrator/subagent-runner.ts` | ✅ Created — includes lint capture + scope writing | ✅ Clean |
| 7 | `orchestrator/activity-feed.ts` | ✅ Full implementation — feed state machine, text parsing, rendering, compression | ✅ Clean |
| 8 | `orchestrator/plan-panel.ts` | ✅ Full implementation — timer, spinner, step lifecycle | ✅ Clean |

### Notes on Phase 3
- `subagent-runner.ts` includes 3 additions vs original extraction: lint-guard custom message capture,
  scope file write/cleanup, removed `orchestratorGoal` dependency
- `activity-feed.ts` includes both Layer 2 activity feed AND `compressOutput()` needed by subagent-runner
- `plan-panel.ts` has its own local `PlanStep` type and `SPINNER_FRAMES`/`_spinnerIndex` (separate from activity-feed's copy — they control different UI elements)

### Phase 4: Registration — ✅ COMPLETE

| Step | File | Status | Lint |
|------|------|--------|------|
| 9 | `orchestrator/delegate-tool.ts` | ✅ Created — registerDelegateTool(), renderCall/renderResult/execute | ✅ Clean |
| 10 | `orchestrator/commands.ts` | ✅ Created — /orchestrate, /specialists | ✅ Clean |
| 11 | `orchestrator/index.ts` | ✅ Created — wiring hub with subagent guard, before_agent_start, tool_call block | ✅ Clean |

### Phase 4 Notes
- `delegate-tool.ts` execute handler passes `undefined` for scope param — scope wiring deferred to Phase 5
- `plan-panel.ts` updated with new `hasActivePlan()` export needed by delegate-tool.ts
- `index.ts` is the NEW entry point. When pi loads `orchestrator/index.ts`, it will replace `orchestrator.ts`.
- `orchestrator.ts` still exists and can be removed once index.ts is verified to load correctly.

### Phase 5: Scope Wiring — ✅ COMPLETE

| Step | Description | Status |
|------|-------------|--------|
| 12 | Parse scope from subagent output, cache for coder delegation | ✅ Done |

### Scope Wiring Details

**Mechanism:** After ANY subagent completes, `extractScopeFromOutput()` parses the output for:
- JSON code block with scope fields: ```` ```json {"filesToModify": [...], ...} ````
- `## Scope` section with key: value format: `filesToModify: ["src/auth.ts"]`

Cached scope is passed to the NEXT coder delegate. After coder uses it, scope is cleared (one-shot pattern).

**Files changed:**
- `delegate-tool.ts` — added `_cachedScope`, `extractScopeFromOutput()`, execute handler wiring
- `specialists.ts` — added `## Scope` output format guide to scout's system prompt

**Flow:**
```
1. scout outputs findings + optional ## Scope section
2. delegate-tool.ts parses scope, caches it
3. Next delegate(coder, ...) passes cached scope to runSubagent()
4. runSubagent() writes .pi/scope.json
5. scope-guard.ts blocks out-of-scope writes
6. After coder completes, scope cleared (one-shot)
```

### Testing Scope Wiring
To test: run `/orchestrate investigate the login module and add error handling`
- Scout should run first, optionally output ## Scope
- Coder should run next with scope enforced
- scope-guard.ts should block writes outside approved files

### Phase 6: Testing — 🔶 PENDING

All verification steps pending until extension can be reloaded:
- Verify /orchestrate works end-to-end
- Verify subagent isolation (env var guard)
- Verify plan panel renders correctly
- Verify activity feed updates in real-time

### Key Deviations from Original Plan

1. **activity-feed.ts needed as dependency** before subagent-runner.ts could compile. Created as stub — needs full function implementations.
2. **tsconfig.json** created at `extensions/tsconfig.json` for type checking during refactoring. Not needed at runtime (jiti).
3. **subagent-runner.ts** includes 3 additions not in original extraction plan:
   - lint-guard custom message capture (`event.message?.customType === "lint-guard"`)
   - Scope file writing (`writeScopeFile()` / `clearScopeFile()`)
   - Removed dependency on `orchestratorGoal` module-level var (uses empty string fallback instead)
4. **The subscription event `orchestratorGoal` reference** was removed because it's module-level state in the old orchestrator.ts. The extracted version doesn't have access to it. Render functions now receive empty string fallback.

### Next Steps

1. Implement full `orchestrator/activity-feed.ts` — extract from orchestrator.ts lines 357-930
2. Implement `orchestrator/plan-panel.ts` — extract from orchestrator.ts lines 126-355
3. Implement `orchestrator/delegate-tool.ts` — extract from orchestrator.ts lines ~1450-1570
4. Implement `orchestrator/commands.ts` — extract from orchestrator.ts lines ~1580-1640
5. Create `orchestrator/index.ts` — wiring hub
6. Verify extension loads and /orchestrate works

### Legacy Backup

The old monolithic `orchestrator.ts` (1663 lines) has been moved to:
```
agent/extensions/orchestrator/legacy/orchestrator.ts
```

This prevents pi from loading both the old file and the new `orchestrator/index.ts` at the same time.
The legacy file is preserved for reference — the refactored module at `orchestrator/index.ts` is now the active extension.

**To restore old behavior:** Move `orchestrator/legacy/orchestrator.ts` back to `orchestrator.ts` at the extensions root level.

### Reload Note

The updated extension takes effect on NEXT pi session start. Mid-session reload is not supported —
close the current session and start a new one to load the refactored orchestrator.

All files type-check clean. Ready for Phase 5 (scope wiring) and Phase 6 (verification).

---

## 5. Architecture Rules (for Future Agentic Work)

These rules prevent regression to monolith:

### Rule 1: One File Per Concern
No file > 400 lines. If a file exceeds 400 lines, it must be split by
change frequency (UI vs logic vs data) before adding more code.

### Rule 2: State Localization
Module-level state belongs in the file that owns that concern.
- `planContainer`, `planTimer` → only in `plan-panel.ts`
- `orchestratorActivity` → only in `activity-feed.ts`
- `_batchLoadSubagent` → only in `subagent-runner.ts`
- No shared mutable state across file boundaries — pass via function params.

### Rule 3: Dependency Direction
- `index.ts` depends on all modules (wiring hub)
- No module depends on `index.ts`
- `types.ts` depends on nothing
- UI modules (`plan-panel.ts`, `activity-feed.ts`) don't import business logic modules
- `scope-guard.ts` depends on NOTHING in the orchestrator module

### Rule 4: Scope Enforcement
- `scope-guard.ts` enforces write boundaries at the tool level (tool_call hook)
- Every `delegate(coder, ...)` must be preceded by a scope definition
- Scope comes from scout output (parsed, not free-text) or is explicitly set
- No scope file = scope-guard passes through (invisible, correct for single-file tasks)
- Scope file `.pi/scope.json` is project-specific (relative to cwd), cleaned up after coder completes
- scope-guard.ts never imports from orchestrator module — zero coupling

### Rule 5: Spec Enforcement
Before adding a new feature:
1. Update `ORCHESTRATION-UI-DESIGN.md` first
2. Then find the correct module
3. If no module fits, create a new one (Rule 1 applies)

---

## 6. Audit: Refactoring Plan vs Pi SDK

Verified against actual pi SDK source code:

| Check | Result | Evidence |
|-------|--------|----------|
| tool_call fires in subagent sessions | ✅ | Each AgentSession creates its own ExtensionRunner. scope-guard.ts loaded by DefaultResourceLoader.reload() in subagent session. |
| scope-guard.ts loads in subagents | ✅ | loader.reload() scans ALL extensions. No per-session filter. |
| process.env survives reload | ✅ | Same Node.js process (jiti re-imports, no fork). Env var before reload is visible after. |
| File-based IPC works | ✅ | Same process, synchronous readFileSync. .pi/scope.json is relative to cwd. |
| No scope = no blocking | ✅ | Guard checks file existence before each tool_call. No file = return undefined. |
| No SDK changes needed | ✅ | Uses existing pi.on("tool_call") and tool_call blocking API. Same pattern as lint-guard.ts. |
| Cross-project isolation | ✅ | .pi/scope.json is per-project (relative to cwd). No global state. |
| Works with DeepSeek Flash | ✅ | Tool-level enforcement doesn't depend on model capability. Model never sees the guard. |
| All tool_call handlers independent | ✅ | emitToolCall() iterates all extensions. scope-guard.ts and orchestrator.ts handlers don't interfere. |

### What Does NOT Change

- The user's debugging / scope.json file is NOT written unless scout has run
  and produced a structured scope
- Normal pi usage without orchestrator: no scope file, no enforcement
- Quick `delegate(coder, "fix one file")` without scout: no scope, no enforcement
- Only the full scout→scope→coder pipeline activates the guard

---

## 7. How to Verify Compliance

| Check | Command/Method |
|-------|---------------|
| File count | `ls orchestrator/*.ts \| wc -l` — target: 10 |
| Lines per file | `wc -l orchestrator/*.ts` — no file > 400 |
| Cyclic imports | `npx madge --circular orchestrator/` — 0 cycles |
| Exports per file | `grep "^export" orchestrator/*.ts` — each file has focused exports |
| State isolation | `grep "let [a-z]" orchestrator/*.ts` — state vars local to one file |
| Scope isolation | Forced to `scope.filesToModify` |
| Spec alignment | diff `ORCHESTRATION-UI-DESIGN.md` sections against file structure |

---

## References

- **Design spec:** `ORCHESTRATION-UI-DESIGN.md` (single source of truth)
- **Current impl:** `orchestrator.ts` (1663 lines, monolithic)
- **@ifi modular impl:** `npm:@ifi/pi-extension-subagents` —
  `https://www.npmjs.com/package/@ifi/pi-extension-subagents?activeTab=code` —
  43 TS files, chain engine, agent CRUD, render layer
- **HazAT multiplexer impl:** `github.com/hazat/pi-interactive-subagents` —
  6 core TS files, cmux abstraction, status state machine
- **nicobailon/pi-subagents base:** `github.com/nicobailon/pi-subagents` (2,139★)
- **AGENTS.md:** `/Users/shivam94/AGENTS.md` (caveman mode, delegation rules)
- **lint-guard.ts template:** `~/.pi/agent/extensions/lint-guard.ts` — blocking pattern
- **Pi SDK audit:** `agent-session.js` + `types.d.ts` + `extensions.md` — verified tool_call
  isolation, loader behavior, process architecture
