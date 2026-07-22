# MASTER-PLAN-LOG.md

## Session 1 — 2026-07-22

**Tickets:** H0, R1, R2, R3, R4

### Gate results
- **vitest:** 832 passed, 1 skipped, 833 total, 54 files
- **tui-smoke:** 6 passed, 3 failed (9 total). All 3 failures match known pre-existing issues (U5 — not yet done): Plan panel detection, render logs, cleared-after-complete.

### Summary
- H0: Copied OMP reference from /private/tmp/oh-my-pi to permanent location.
- R1: Cut prose-regex guards (TOOL_PATTERNS + validateTaskCapabilities + call site); replaced QA heuristic with toolCalls===0 signal.
- R2: Removed 4 dead files (bash-interceptor-integrated.ts+test, loop-panel.test.ts, parallel-delegation.test.ts, init-guard.test.ts); 3 already absent; 4 candidates verified LIVE and kept (model-tui, fusion-tui, introspection-tools, debug-path-trace).
- R3: Fixed tsc error in subagent-runner.ts advanceStepTool handler signature.
- R4: Isolated ../nyro-sync type errors from extension lint.

### Friction notes
- Regex guard blocked orchestrator delegations 4× pre-R1 (scopeNotes/blockedCalls).
- Transport truncation lost worker reports 3× (findings cut mid-run).
- C1 test timing-flaky: 2.8–5s variance.
- Reviewer rubber-stamped incomplete R1 — needed second pass with explicit file-level audit.

## Session 2 (partial) — 2026-07-22
### Completed
- O1: Flight recorder — createFlightRecorderDump extended with toolCallTrail (tool+input+output+isError+durationMs), blockedCalls, planSteps, metrics, tokenSummary. Written on every delegation completion. 3 new tests (32 total in subagent-runner.test.ts). tsc zero errors. 832 vitest green.

### Remaining
- O2: Widen diagnostic triggers (errors + blocked calls, not just zero-tool-call silence)
- O3: Replay surface (timeline command or reuse recordTimelineFrame)

### Friction this session
- Transport truncation: worker reports cut in transit ~5x (P3 ticket material)
- Regex guard blocked orchestrator delegations 4x before R1 cut (fix is on disk but needs pi restart to take effect in live session)
- C1 token test timing-flaky (2-5s, T1 will rewrite with SDK-true mocks)
- Reviewer rubber-stamped incomplete R1 (isLikelyQATask not done on first pass — needed second delegation)
- tui-smoke: 6/9 pass, 3 known U5 pre-existing failures
