# Orchestrator Extension — Session Handoff

> Read this file at session start. It contains everything needed to continue work without conversation history.
> Also read: docs/MASTER-PLAN.md (current plan + tickets), docs/VISION.md (doctrine + principles).

## Where we are

**Master plan v2** is live in docs/MASTER-PLAN.md. Workstreams: WS-H (done), WS-R (done), WS-O (partial: O1 done, O2+O3 next), WS-T (tokens), WS-U (UI hardening), WS-PR (prompt layer), WS-P (PBT guard), WS-L (loop engine), WS-E (execution infra).

**Session 1 (done):** H0 (OMP rescued to ~/omp-reference), R1 (regex capability guard cut + isLikelyQATask removed), R2 (4 dead files deleted, 4 verified-live kept), R3 (tsc error fixed, orphan test deleted), R4 (tsconfig scoped — nyro-sync lint noise eliminated). Committed ac398d7.

**Session 2 (partial):** O1 flight recorder implemented — every delegation now persists structured JSON to /tmp/orchestrator-debug/ with: toolCallTrail (tool+input+output+isError+durationMs), blockedCalls (from subagent-tool-guard), planSteps (label+duration+completed), metrics (tool call counts), tokenSummary (input/output/cached/ctxTokens). 3 new tests. Not yet committed.

## Next steps (in order)
1. **O2** — Widen diagnostic triggers in subagent-diagnostics.ts: captureDiagnostic currently only fires on zero-tool-call silence. Add triggers for: delegations with tool errors (any substep with isError=true), delegations with blocked calls (blockedCalls.length > 0). File: subagent-diagnostics.ts. Accept: delegation with a blocked command produces a diagnostic record.
2. **O3** — Replay surface: make /timeline command or a new command render a past delegation's flight recorder JSON. Reuse existing timeline-dump machinery (recordTimelineFrame in plan-panel.ts) or read the delegation JSON directly. Accept: user can inspect a finished delegation's event sequence.
3. **Commit O1+O2+O3** as Session 2.
4. **WS-T (tokens):** T1 fix field names (usage.input not usage.inputTokens — SDK truth in pi-ai types.d.ts L251), fix agent_end path (no event.usage — use messages[]), fix test mocks to SDK shape. T2 render token line in activity-feed. T3 secondary surfaces.
5. **WS-U (UI hardening):** U1 LoopWatchdog (port from ~/omp-reference/packages/tui/src/loop-watchdog.ts), U2 collapse viewport, U3 progress dedup, U4 recentTools, U5 tui-smoke modernization.
6. **WS-PR (prompt layer):** P1-P6 — worker truth gaps, dead prompt machinery, findings salvage, routing table, prompt compression, communication contract (ADHD style + CEO-level reporting replacing caveman TERSE block).
7. **WS-P (PBT guard):** Scoping grill with CEO first. Property-based testing as deterministic worker feedback.
8. **WS-L (loop engine v2):** Metric abstraction + trajectory classifier + best-so-far rollback + fresh-context iterations + budget governor + loop UI. CEO spec: goal + metric + hard cap + best-so-far wins (example: scores 60/40/80/83/88/81, cap 6, return iteration 5 = 88%).

## Critical context for any session

### CEO communication contract
- User is CEO, orchestrator is manager. CEO steers at architecture-part level (knows every part + purpose, not code).
- ADHD-shaped output: lead with next action, numbered steps, restate state per turn, ≤5 items per list, one concrete next action, no preamble/closer.
- No silent mechanisms: every new guard/check/feature announced in plain language before or as it ships.
- Internals (file:line) on request only.
- No model-strength detection — design for weakest, never degrade strong.

### Known issues (not bugs, tracked tickets)
- C1 token accumulator reads wrong SDK field names (usage.inputTokens vs usage.input) — T1 fixes this. Tests pass because mocks use same wrong names.
- tui-smoke 6/9 — 3 known pre-existing failures (U5 fixes).
- Regex guard code is deleted on disk (R1) but a running pi session with old module loaded still has it — restart pi to take effect.
- Transport truncation: long worker reports get cut in transit to orchestrator — P3 ticket.

### Key files
- docs/MASTER-PLAN.md — tickets, session breakdown, verification gates
- docs/VISION.md — Core Doctrine (8 items), 19 principles, non-goals
- docs/MASTER-PLAN-LOG.md — per-session log
- ~/omp-reference/ — OMP codebase (parts bin, NOT /tmp anymore)
- delegate-pipeline.ts — delegation pipeline (regex guard removed)
- subagent-runner.ts — subagent session runner + flight recorder dump
- subagent-diagnostics.ts — diagnostic capture (O2 widens this)
- prompt-builder.ts — orchestrator system prompt assembly (WS-PR)
- specialists.ts — specialist definitions + prompts (WS-PR)

### Baseline
- 832 vitest tests green, 1 skipped (54 files)
- tsc zero errors (nyro-sync isolated)
- Git: main branch, github.com/shivam2014/pi-files
- Commits: ac398d7 (Session 1), 131cb7d (plan v2 + vision), c7d3aa1 (C1 accumulator prior session)
