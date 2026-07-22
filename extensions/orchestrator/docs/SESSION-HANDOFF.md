# Orchestrator Extension — Session Handoff

> Read this file at session start. It contains everything needed to continue work without conversation history.
> Also read: docs/MASTER-PLAN.md (current plan + tickets), docs/VISION.md (doctrine + principles).

## Where we are

**Session 2 complete (2026-07-22).** Committed 30ef2d2 on main.

WS-O flight recorder is shipped (O1 + O2 + O3). Theme test failures fixed (103 pre-existing). Plan panel rendering fixed. maxTurns=30 removed. Next session picks up at WS-T (tokens).

### What shipped in Session 2
- **O1** — Flight recorder base: every delegation persists structured JSON to /tmp/orchestrator-debug/ with toolCallTrail, blockedCalls, planSteps, metrics, tokenSummary
- **O2** — Widened diagnostic triggers: captureDiagnostic now fires on tool errors (isError=true) and blocked calls (blockedCalls.length > 0), not just zero-tool-call silence. New kinds: 'tool_errors', 'blocked_calls'. 4 new tests.
- **O3** — Enriched flight recorder: toolCallTrail captures full tool name, full input args, full output (capped 50KB), label, isError, durationMs. Added systemPrompt and activityFeed snapshot to dump. Old truncated inputSummary/outputPreview replaced. 3 new tests.
- **Theme fix** — Created vitest.setup.ts that sets theme singleton on globalThis directly. Fixed 103 pre-existing test failures ("Theme not initialized"). 3 snapshots updated.
- **Plan panel fix** — plan-tool.ts: object-type steps now extract .label instead of String(step) producing [object Object]
- **maxTurns removal** — Removed 30-turn hard abort from subagent-runner.ts. Subagents now run until natural completion or timeout.
- **Replay cleanup** — Removed broken /replay command from commands.ts. Reverted replay mode from peek-overlay.ts.

## Next steps (in order)
1. **T1** — SDK-true token accumulator. Fix field names: usage.input/output/cacheRead/cacheWrite (currently reads inputTokens/outputTokens/cachedTokens → always 0). agent_end has NO event.usage — flush from last assistant message in messages[]. Fix C1 test mocks to SDK Usage shape (pi-ai types.d.ts ~L251). Files: subagent-runner.ts, subagent-runner.test.ts. Accept: tests use SDK-shaped mocks; live delegation shows non-zero totals.
2. **T2** — Token line render. activity-feed status line: ↑{input} ⇄{cacheRead} ↓{output} · ctx {cur}/{win} via formatTokens; glyphs in orchestrator-theme SYMBOLS; hide ⇄ when cacheRead==0 all run; freeze line on completion. Accept: render tests (with/without window, zero-cache, k/M formats).
3. **T3** — Secondary surfaces. plan-panel step detail live tokens; peek-overlay header token segment; model tag in delegate block header. Accept: smoke — tokens visible in panel + peek during delegation.
4. **WS-U (UI hardening):** U1 LoopWatchdog (port from ~/omp-reference), U2 collapse viewport, U3 progress dedup, U4 recentTools, U5 tui-smoke modernization.
5. **WS-PR (prompt layer):** P1-P6 — worker truth gaps, dead prompt machinery, findings salvage, routing table, prompt compression, communication contract (ADHD style + CEO-level reporting replacing caveman TERSE block).
6. **WS-P (PBT guard):** Scoping grill with CEO first. Property-based testing as deterministic worker feedback.
7. **WS-L (loop engine v2):** Metric abstraction + trajectory classifier + best-so-far rollback + fresh-context iterations + budget governor + loop UI.

## Critical context for any session

### CEO communication contract
- User is CEO, orchestrator is manager. CEO steers at architecture-part-level (knows every part + purpose, not code).
- ADHD-shaped output: lead with next action, numbered steps, restate state per turn, ≤5 items per list, one concrete next action, no preamble/closer.
- No silent mechanisms: every new guard/check/feature announced in plain language before or as it ships.
- Internals (file:line) on request only.
- No model-strength detection — design for weakest, never degrade strong.
- CEO priority: full tool call I/O capture in flight recorder for debugging. Replay/peek is secondary.

### Known issues (not bugs, tracked tickets)
- C1 token accumulator reads wrong SDK field names (usage.inputTokens vs usage.input) — T1 fixes this. Tests pass because mocks use same wrong names.
- Transport truncation: long worker reports get cut in transit to orchestrator — P3 ticket.
- maxTurns removed from code but DEFAULTS.delegation.maxTurns (30) still in orchestrator-config.ts — not enforced anymore but config is stale.
- Coder subagents waste turns on blocked bash calls (sed/cat blocked by interceptor, then python3 workaround). Subagent prompts don't mention turn budget or blocked tool workarounds.

### Key files
- docs/MASTER-PLAN.md — tickets, session breakdown, verification gates
- docs/VISION.md — Core Doctrine (8 items), 19 principles, non-goals
- docs/MASTER-PLAN-LOG.md — per-session log with friction notes
- ~/omp-reference/ — OMP codebase (parts bin, NOT /tmp)
- delegate-pipeline.ts — delegation pipeline (diagnostic triggers widened in O2)
- subagent-runner.ts — subagent session runner + flight recorder dump (enriched in O3, maxTurns removed)
- subagent-diagnostics.ts — diagnostic capture (widened in O2: tool_errors + blocked_calls kinds)
- prompt-builder.ts — orchestrator system prompt assembly (WS-PR)
- specialists.ts — specialist definitions + prompts (WS-PR)
- vitest.setup.ts — theme singleton mock for tests (new in Session 2)
- plan-tool.ts — plan tool handler (object-type step label fix)

### Baseline
- 841 vitest tests green, 1 skipped (54 files)
- tsc zero errors
- Git: main branch, github.com/shivam2014/pi-files
- Commits: 30ef2d2 (Session 2), 96619ce (Session 2 partial), ac398d7 (Session 1)

### Flight recorder debugging workflow
1. Delegations run → JSON written to /tmp/orchestrator-debug/delegation-<timestamp>-<specialist>.json
2. JSON now includes: full tool call inputs/outputs (not truncated), systemPrompt, activityFeed snapshot, blockedCalls, planSteps, metrics, tokenSummary
3. To investigate a past delegation: bring the JSON to a session and analyze with the orchestrator
4. Diagnostic records also written to {agentDir}/extensions/orchestrator/diagnostics/ on tool errors, blocked calls, silent failures, and crashes
