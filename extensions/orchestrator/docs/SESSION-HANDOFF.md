# Orchestrator Extension — Session Handoff

> Read this file at session start. It contains everything needed to continue work without conversation history.
> Also read: docs/MASTER-PLAN.md (current plan + tickets), docs/VISION.md (doctrine + principles).

## Where we are

**Session 3 complete (2026-07-22).** Committed [hash] on main.

WS-T (tokens) is shipped (T1 + T2 + T3). Next session picks up at WS-U (UI hardening).

### What shipped in Session 3
- **T1** — SDK-true token accumulator: fixed field names in subagent-runner.ts (usage.inputTokens→input, outputTokens→output, cachedTokens→cacheRead). agent_end handler fixed: reads from event.messages[] last assistant message (no event.usage exists). Removed dead "done" event check. All test mocks updated to SDK Usage shape.
- **T2** — Token line render in activity-feed: ↑{input} ⇄{cacheRead} ↓{output} · ctx {cur}/{win}. New renderTokenLine() function. SYMBOLS gained token.input (↑), token.output (↓), token.cacheRead (⇄). ActivityFeedState gained token fields. ⇄ hidden when cacheRead==0. Line frozen on completion. 10 new tests in activity-feed-tokens.test.ts.
- **T3** — Secondary surfaces: plan-panel step detail shows live tokens via detailLines array. peek-overlay header gets token segment via new setViewerTokens() API. delegate-tool.ts cache glyph changed from ◎ to ⇄. subagent-runner.ts feeds token data to all three surfaces.

## Next steps (in order)
1. **WS-U (UI hardening):** U1 LoopWatchdog (port from ~/omp-reference), U2 collapse viewport, U3 progress dedup, U4 recentTools, U5 tui-smoke modernization.
2. **WS-PR (prompt layer):** P1-P6 — worker truth gaps, dead prompt machinery, findings salvage, routing table, prompt compression, communication contract.
3. **WS-P (PBT guard):** Scoping grill with CEO first. Property-based testing as deterministic worker feedback.
4. **WS-L (loop engine v2):** Metric abstraction + trajectory classifier + best-so-far rollback + fresh-context iterations + budget governor + loop UI.

## Critical context for any session

### CEO communication contract
- User is CEO, orchestrator is manager. CEO steers at architecture-part-level (knows every part + purpose, not code).
- ADHD-shaped output: lead with next action, numbered steps, restate state per turn, ≤5 items per list, one concrete next action, no preamble/closer.
- No silent mechanisms: every new guard/check/feature announced in plain language before or as it ships.
- Internals (file:line) on request only.
- No model-strength detection — design for weakest, never degrade strong.
- CEO priority: full tool call I/O capture in flight recorder for debugging. Replay/peek is secondary.

### Known issues (not bugs, tracked tickets)
- Transport truncation: long worker reports get cut in transit to orchestrator — P3 ticket.
- DEFAULTS.delegation.maxTurns (30) still in orchestrator-config.ts — not enforced anymore but config is stale.
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
- 851 vitest tests green, 1 skipped (55 files)
- tsc zero errors
- Git: main branch, github.com/shivam2014/pi-files

### Flight recorder debugging workflow
1. Delegations run → JSON written to /tmp/orchestrator-debug/delegation-<timestamp>-<specialist>.json
2. JSON now includes: full tool call inputs/outputs (not truncated), systemPrompt, activityFeed snapshot, blockedCalls, planSteps, metrics, tokenSummary
3. To investigate a past delegation: bring the JSON to a session and analyze with the orchestrator
4. Diagnostic records also written to {agentDir}/extensions/orchestrator/diagnostics/ on tool errors, blocked calls, silent failures, and crashes
