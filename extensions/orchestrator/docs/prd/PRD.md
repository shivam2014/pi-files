# Orchestrator Extension Refactor — PRD and Tracer-Bullet Issues

## Part 1 — PRD

### 1. Problem Statement

The orchestrator extension was extracted from a monolith. It still carries monolithic coupling.

- Scope lifecycle, delegate-tool responsibilities, entry-point wiring, subagent event routing, and plan-panel state are entangled across modules.
- `index.ts` mixes policy, wiring, and tool handling.
- `delegate-tool` owns too much of the per-delegation lifecycle.
- The scope cache lives in memory, so stale scope can survive across turns.
- UI modules import each other directly instead of subscribing to events.

### 2. Solution

Introduce deep modules. Each owns one seam.

- `ScopeManager`: owns Scope concept, writes `.pi/scope.json`, exposes typed API, clears scope after every delegation and in `before_agent_start`.
- `ScopeGuard`: reads raw `.pi/scope.json`, enforces scope, emits `ScopeExpansionRequest`, fails closed on malformed/stale.
- `DelegateController`: drives start/finalize/error hooks for a single delegation inside an active plan.
- `AskResolver`: decides whether a delegation needs `ask_orchestrator` before it runs.
- `DelegateFeedBuilder`: builds the live activity feed during a subagent run.
- `DelegateOutputFormatter`: post-processes the subagent result into the final formatted block.
- `BashInterceptor`: converts user-typed bash commands to equivalent tool calls.
- `SubagentToolGuard`: allows/denies tools, enforces `planSteps`-first ordering, routes bash through `BashInterceptor`.
- `PromptBuilder`: builds the orchestrator system prompt.
- `RegistrationHub`: wires tools, commands, and handlers into the extension API.
- `SubagentEventRouter`: routes subagent events to registered UI handlers.
- `PlanPanel`: one class instance per orchestrator session, passed through context.

### 3. User Stories

1. **Maintainer wiring clarity**: As a maintainer, I can open `index.ts` and see only registration calls, so I know where the extension starts.
2. **Tester scope isolation**: As a tester, I can import `ScopeManager` and write/read/clear `.pi/scope.json` without starting a subagent.
3. **User fail-closed enforcement**: As a user, an out-of-scope write is blocked even when `ScopeManager` is not loaded, because `ScopeGuard` reads the file directly.
4. **Maintainer UI extension**: As a maintainer, I can add a new UI panel by calling `SubagentEventRouter.on(...)` without editing the router.
5. **Tester regression safety**: As a tester, I can run `npm test` after each refactor and all existing tests still pass.

### 4. Implementation Decisions

- No in-memory scope cache. The orchestrator passes scope explicitly.
- `ScopeManager` is the sole writer of `.pi/scope.json`. It clears the file after every delegation and in `before_agent_start`.
- `ScopeGuard` reads raw JSON directly. It does not import orchestrator types.
- The scope file carries a version and schema. Malformed or stale files trigger fail-closed behavior.
- `ScopeExpansionRequest` goes to the orchestrator, not the user. The orchestrator decides using full conversation history.
- `delegate-tool` becomes thin wiring. `DelegateController` orchestrates the per-delegation lifecycle.
- `DelegateFeedBuilder` owns the live feed. `DelegateOutputFormatter` only post-processes final output.
- `index.ts` becomes pure wiring.
- UI modules self-register with `SubagentEventRouter`. The router does not import UI modules.
- `PlanPanel` is one instance per orchestrator session, passed via context.
- Candidate B was rejected: plan/feed models stay separate. `DelegateFeedBuilder` and `DelegateOutputFormatter` are not merged.
- Scope types live with `ScopeManager`, not in a shared `types.ts`.

### 5. Testing Decisions

- Write unit tests for each new module.
- Add an integration test for the scout→coder scope chain: scout writes a scope, coder's `ScopeGuard` enforces it, expansion request reaches the orchestrator.
- Existing tests must continue to pass after each issue.
- Prefer real file I/O for `ScopeManager`/`ScopeGuard` tests in a temp directory; mock only external APIs.

### 6. Out of Scope

- Fusion tool refactor.
- `legacy/orchestrator.ts`.
- UI redesign or new user-facing behavior.
- Any behavior change not required by the refactor.

### 7. Further Notes

- See `CONTEXT.md` for domain definitions.
- See any co-located ADR files for decision records.

## Part 2 — Tracer-bullet issues

### Issue 1: Create ScopeManager module and move scope types

- **Parent**: PRD
- **What to build**: Extract scope logic into `ScopeManager`. Move scope types from shared `types.ts` into `scope-manager.ts` or `scope-types.ts`. Implement normalize manifest to resolved scope, `writeScope`, `readScope`, `clearScope`, changeType-to-gateMode derivation. No caching.
- **Acceptance criteria**:
  - `ScopeManager.writeScope` creates `.pi/scope.json` with version and schema.
  - `ScopeManager.clearScope` removes `.pi/scope.json`.
  - `ScopeManager.normalize` turns a `ScopeManifest` into a `ResolvedScope`.
  - Unit tests in `scope-manager.test.ts` cover write/read/clear/normalize/gateMode.
  - Existing tests still pass.
- **Blocked by**: none

### Issue 2: Create ScopeGuard zero-coupled enforcement adapter

- **Parent**: PRD
- **What to build**: Build `ScopeGuard` that reads `.pi/scope.json` as raw JSON. Validate version/schema. Block out-of-scope tool calls. Emit `ScopeExpansionRequest` when expansion is allowed. Fail closed on missing/stale/malformed file. Do not import orchestrator modules.
- **Acceptance criteria**:
  - `ScopeGuard` blocks writes outside the allowed files/directories.
  - `ScopeGuard` emits a `ScopeExpansionRequest` for expandable boundaries.
  - Missing, stale, or malformed `.pi/scope.json` blocks all writes.
  - Unit tests in `scope-guard.test.ts` cover allow/block/expansion/fail-closed.
  - Existing tests still pass.
- **Blocked by**: 1

### Issue 3: Refactor delegate-tool to use ScopeManager and remove scope cache

- **Parent**: PRD
- **What to build**: Update `delegate-tool` to call `ScopeManager.writeScope` before a run and `ScopeManager.clearScope` after a run and in `before_agent_start`. Remove any in-memory scope cache.
- **Acceptance criteria**:
  - `delegate-tool` no longer stores scope in module-level state.
  - `delegate-tool` calls `ScopeManager.clearScope` after delegation and in `before_agent_start`.
  - Scope is passed explicitly to downstream modules.
  - Tests for `delegate-tool` still pass; update mocks to `ScopeManager`.
- **Blocked by**: 1

### Issue 4: Extract DelegateOutputFormatter

- **Parent**: PRD
- **What to build**: Move final result formatting from the existing delegation flow into `DelegateOutputFormatter`. It accepts subagent output and returns formatted text. No live feed handling.
- **Acceptance criteria**:
  - `DelegateOutputFormatter.format(output)` returns final formatted block with findings summary, audit, and metrics.
  - It does not call feed or plan-panel update functions.
  - Unit tests in `delegate-output-formatter.test.ts` cover formatting cases.
  - Existing tests still pass.
- **Blocked by**: none

### Issue 5: Extract AskResolver

- **Parent**: PRD
- **What to build**: Move ask-orchestrator decision logic into `AskResolver`. It evaluates the user request, current scope, and whether clarification is needed.
- **Acceptance criteria**:
  - `AskResolver.resolve(request, scope)` returns `ask` or `proceed`.
  - It does not perform delegation.
  - Unit tests in `ask-resolver.test.ts` cover ask vs proceed cases.
  - Existing tests still pass.
- **Blocked by**: 1

### Issue 6: Extract DelegateFeedBuilder from subagent-runner

- **Parent**: PRD
- **What to build**: Move live feed construction out of `subagent-runner` into `DelegateFeedBuilder`. It handles `reportFinding`, `ask_orchestrator` prompts, spinner updates, and plan-panel detail lines as they arrive.
- **Acceptance criteria**:
  - `DelegateFeedBuilder` produces live feed lines from subagent events.
  - It does not format the final result block.
  - Unit tests in `delegate-feed-builder.test.ts` cover event-to-feed mapping.
  - Existing tests still pass.
- **Blocked by**: none

### Issue 7: Extract DelegateController and thin delegate-tool

- **Parent**: PRD
- **What to build**: Move per-delegation lifecycle hooks into `DelegateController`. `delegate-tool` becomes thin wiring that calls `AskResolver`, `DelegateController`, `DelegateFeedBuilder`, `DelegateOutputFormatter`, and `ScopeManager`.
- **Acceptance criteria**:
  - `DelegateController` handles start, finalize, and error-step transitions for one delegation.
  - `delegate-tool` only wires inputs and outputs; it contains no lifecycle logic.
  - Unit tests in `delegate-controller.test.ts` cover start/finalize/error.
  - Existing delegation tests still pass.
- **Blocked by**: 1, 3, 4, 5, 6

### Issue 8: Extract BashInterceptor and SubagentToolGuard from index.ts

- **Parent**: PRD
- **What to build**: Move tool-allow/deny policy from `index.ts` into `SubagentToolGuard`. Move bash-to-tool substitution into `BashInterceptor`. `SubagentToolGuard` enforces planSteps-first ordering and fusion allow-list and routes bash through `BashInterceptor`.
- **Acceptance criteria**:
  - `SubagentToolGuard` returns allowed/blocked for each tool event.
  - `BashInterceptor` returns equivalent tool call for supported bash commands.
  - `planSteps`-first ordering is enforced.
  - Unit tests in `subagent-tool-guard.test.ts` and `bash-interceptor.test.ts` cover behavior.
  - Existing tests still pass.
- **Blocked by**: none

### Issue 9: Extract PromptBuilder and RegistrationHub from index.ts

- **Parent**: PRD
- **What to build**: Move system-prompt construction into `PromptBuilder`. Move extension wiring (tools, commands, handlers) into `RegistrationHub`. `index.ts` becomes pure wiring that calls `RegistrationHub`.
- **Acceptance criteria**:
  - `PromptBuilder.build()` returns the orchestrator system prompt.
  - `RegistrationHub.register(api)` registers all tools, commands, and handlers with the extension API.
  - `index.ts` contains no policy or prompt logic.
  - Unit tests in `prompt-builder.test.ts` and `registration-hub.test.ts` cover behavior.
  - Existing tests still pass.
- **Blocked by**: none

### Issue 10: Introduce SubagentEventRouter and migrate UI modules

- **Parent**: PRD
- **What to build**: Create `SubagentEventRouter` with `on(eventType, handler)` API. Migrate UI modules to register themselves. The router does not import UI modules.
- **Acceptance criteria**:
  - UI modules register handlers via `SubagentEventRouter.on(...)`.
  - Router dispatches subagent events to registered handlers.
  - Router has no direct imports of UI modules.
  - Unit tests in `subagent-event-router.test.ts` cover registration and dispatch.
  - Existing tests still pass.
- **Blocked by**: 11

### Issue 11: Convert plan-panel.ts to per-session PlanPanel class

- **Parent**: PRD
- **What to build**: Replace module-level plan-panel state with a `PlanPanel` class. One instance per orchestrator session. Pass the instance through context.
- **Acceptance criteria**:
  - `PlanPanel` class encapsulates plan state, widget handle, session id, and timers.
  - Each orchestrator session receives its own `PlanPanel` instance.
  - No global/module-level plan state remains.
  - Unit tests in `plan-panel-finalize.test.ts` cover lifecycle and session isolation.
  - Existing tests still pass.
- **Blocked by**: none

### Issue 12: Final integration cleanup and full test run

- **Parent**: PRD
- **What to build**: Wire all modules together. Remove dead code. Run the full test suite and typecheck. Fix regressions.
- **Acceptance criteria**:
  - `npm test` passes.
  - `npm run typecheck` passes.
  - No references to old monolithic functions remain.
  - Integration test for scout→coder scope chain passes.
  - PRD checklist updated if needed.
- **Blocked by**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
