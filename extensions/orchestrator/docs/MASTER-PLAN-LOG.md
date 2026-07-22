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

## Session 2 (complete) — 2026-07-22

**Tickets:** O1, O2, O3 + theme fix + plan-panel fix + maxTurns removal

### Gate results
- **vitest:** 841 passed, 1 skipped, 842 total, 54 files
- **tsc:** zero errors
- **tui-smoke:** not run this session (U5 ticket)

### Completed
- O1: Flight recorder — createFlightRecorderDump with toolCallTrail, blockedCalls, planSteps, metrics, tokenSummary
- O2: Widened diagnostic triggers — captureDiagnostic now fires on tool errors (isError=true) and blocked calls (blockedCalls.length > 0), not just zero-tool-call silence. New kinds: 'tool_errors', 'blocked_calls'. 4 new tests.
- O3: Enriched flight recorder — toolCallTrail now captures full tool name, full input args, full output (capped 50KB), label, isError, durationMs. Added systemPrompt and activityFeed snapshot to dump. Old truncated inputSummary/outputPreview replaced.
- Theme fix: Created vitest.setup.ts that sets theme singleton on globalThis directly. Fixed 103 pre-existing test failures caused by "Theme not initialized" error. 3 snapshots updated.
- Plan panel fix: plan-tool.ts object-type steps now extract .label instead of String(step) producing [object Object].
- maxTurns removal: Removed 30-turn hard abort from subagent-runner.ts. Subagents now run until natural completion or timeout.
- Replay cleanup: Removed broken /replay command from commands.ts. Reverted replay mode from peek-overlay.ts.

### Friction notes
- Coder subagent hit maxTurns=30 THREE TIMES, each time leaving file in broken state (syntax errors from incomplete edits). Root cause: no turn budget awareness in subagent prompt + 30-turn limit too low for complex multi-edit tasks. Fix: removed maxTurns entirely.
- Coder wasted 2 turns per session on blocked bash calls (sed, cat blocked by interceptor, then python3 workaround).
- Transport truncation: worker reports still cut in transit.
- createFlightRecorderDump function had systemPrompt/activityFeed in interface but not in return object or call site — required surgical fix.
