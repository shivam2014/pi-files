# MASTER PLAN v2 — Orchestrator Extension: Removal, Tokens, UI Hardening, Prompt Layer, PBT, Loop Engine

> Multi-session execution plan. Each ticket is agent-ready: goal, files, acceptance criteria.
> Supersedes v1 (2026-07-22 CEO review). Doctrine: docs/VISION.md "Core Doctrine".
> Orchestrator: read this file at session start, pick first unblocked unchecked ticket, declare plan, delegate, verify, check off.

## 0. Context & hard-won constraints

- Subagents may run on WEAK models. Observed failure modes: lost final reports, announce-then-stop, identity confusion, scattered exploration on broad tasks.
- Therefore: narrow tasks (≤3 items), exact entry paths, mechanical acceptance criteria, findings must leave the subagent's context (file or final message).
- NO model-strength detection anywhere. Design for the weakest worker; a strong worker must not be degraded (CEO D7).
- Sequential delegation mode (parallel only for provably disjoint file sets).
- Scope grep/find to the extension dir explicitly (home-dir permission floods otherwise).
- Mocks must derive from SDK source of truth. Lesson: token accumulator read usage.inputTokens while SDK sends usage.input — green tests, dead feature.
- Guards verify facts (paths, commands, metrics, events, test outcomes), never infer intent from prose (VISION principle 19).
- Communication contract: CEO = architecture-part level, ADHD-shaped output, no silent mechanisms, internals on request.
- Baseline: 841 tests green, 1 skipped, 59 files (2026-07-22).

## WS-H — Housekeeping [FIRST]
- [x] H0. OMP currently lives in /private/tmp/oh-my-pi — /tmp vanishes on reboot. Copy to permanent home (~/omp-reference or inside ~/pi-files) BEFORE any WS-U port ticket. Accept: reference copy exists outside /tmp.
- [ ] H1. End-of-session mechanical: sync + commit + push from ~/pi-files; append docs/MASTER-PLAN-LOG.md (date, tickets, pass/fail, friction). Not optional.

## WS-R — Removal [no blockers]
- [x] R1. Cut prose-regex guards. Delete TOOL_PATTERNS + validateTaskCapabilities + call site in delegate-pipeline.ts (~L31-101, ~L142) + delegate-capability.test.ts. Replace isLikelyQATask prose-regex in subagent-diagnostics.ts with toolCalls===0 signal. Accept: suite green; task text "search the codebase" to scout delegates fine.
- [x] R2. Dead file removal. Verify via import-graph, then delete: bash-interceptor-integrated.ts(+test), rollout-overlay.ts, loop-panel.ts, model-tui.ts, fusion-tui.ts, init-guard.ts, introspection-tools.ts(+test), parallel-delegation.test.ts, debug-path-trace.ts. WARNING: debug.ts is LIVE (subagent-runner imports debugLog) — earlier scan false-flagged it; verify every candidate before deleting. Accept: suite green + extension boots (tui-smoke).
- [x] R3. Fix tsc error subagent-runner.ts:468 (advanceStepTool handler signature drifted from SDK AgentTool type). Accept: tsc clean for extension.
- [x] R4. Isolate ../nyro-sync type errors (3 test errors) from extension lint — exclude dir or fix — so lint stops masking real regressions. Accept: project lint shows only extension-relevant results.

## WS-T — Live tokens done right [blocked by R1]
- [ ] T1. SDK-true accumulator. Fix field names: usage.input/output/cacheRead/cacheWrite (currently reads inputTokens/outputTokens/cachedTokens → always 0). agent_end has NO event.usage — flush from last assistant message in messages[]. Fix C1 test mocks to SDK Usage shape (pi-ai types.d.ts ~L251). Files: subagent-runner.ts, subagent-runner.test.ts. Accept: tests use SDK-shaped mocks; live delegation shows non-zero totals.
- [ ] T2. Token line render (v1 C2). activity-feed status line: ↑{input} ⇄{cacheRead} ↓{output} · ctx {cur}/{win} via formatTokens; glyphs in orchestrator-theme SYMBOLS; hide ⇄ when cacheRead==0 all run; freeze line on completion. Accept: render tests (with/without window, zero-cache, k/M formats).
- [ ] T3. Secondary surfaces (v1 C3). plan-panel step detail live tokens; peek-overlay header token segment; model tag in delegate block header. Accept: smoke — tokens visible in panel + peek during delegation.

## WS-O — Flight recorder (delegation observability) [blocked by R1; BEFORE WS-U]
Problem: activity feed shows rich behavior live (blocked commands, tool errors, retries, timings) but nothing persists it. Diagnostics only fire on zero-tool-call failures. Prompt/rule improvement is blind without records.
- [x] O1. Per-delegation structured record: on EVERY delegation completion persist JSON with full tool trail (tool + input summary + outcome + duration), blocked/redirected calls with reasons (from scopeNotes/blockedCalls), retries, token totals, plan-step durations, final status. Files: delegate-pipeline.ts, subagent-diagnostics.ts. Accept: completed delegation leaves record with ≥90% of feed-visible events.
- [x] O2. Widen diagnostic triggers: also record delegations with tool errors or blocked calls, not only 0-tool-call silence. Accept: delegation with blocked command produces record.
- [x] O3. Replay surface: reuse timeline machinery (recordTimelineFrame/timeline-dump) or /timeline command to render a past delegation record. Accept: user can inspect a finished delegation's event sequence.

## WS-U — UI hardening, OMP ports [blocked by T1; requires H0]
- [ ] U1. LoopWatchdog port (OMP packages/tui/src/loop-watchdog.ts). ~90-line event-loop lag probe, 250ms interval/threshold, generation counter, unref(). Wire around session subscribe in subagent-runner with phase attribution. Accept: fake-clock unit test; stall yields diagnostic naming the phase.
- [ ] U2. Collapse viewport (adapt OMP selectCollapsedTodos). Active-steps-first selection replaces naive trimToBudget; fix PAN-005 (goal line can drop in fallback). Keep "✓ N completed" fold line. Accept: 12-step plan ≤9 lines, active always visible, goal never dropped.
- [ ] U3. Progress emission dedup (OMP scheduleProgress pattern). Replace inline Date.now() coalesce with timer-based dedup. Accept: burst of tool calls → ≤1 emission per 150ms window.
- [ ] U4. recentTools surface. Last ≤5 tool calls shown in plan-panel step detail for debugging stuck workers. Accept: detail renders recent tool history.
- [ ] U5. tui-smoke.sh modernization (v1 E6). Detect panel from tmux capture-pane; match real widget output ('⠋ Plan:', '✓ N completed'); assert cleared-after-complete as correct behavior; add token glyph (↑/ctx) assertions. Accept: 9/9 or documented remaining gaps.

## WS-PR — Prompt & information layer [no blockers]
- [ ] P1. Worker truth gaps. Reviewer prompt: full interceptor redirect list (cat→read, find→find, ls→ls — currently only rg/grep warned). Researcher prompt: mention git-read (granted but undocumented), add gh to NOT-have list. Files: specialists.ts. Accept: prompt-truth test per specialist.
- [ ] P2. Delete dead prompt machinery: _scoutToolDoc/_coderToolDoc/etc + updateToolDocs() in specialists.ts (exported, never imported). Accept: suite green.
- [ ] P3. Findings salvage chain. Verify A4 salvage from diagnostics JSON works for read-only specialists (scout/researcher/reviewer); orchestrator-side: results cut in transport must be marked "⚠ PARTIAL". Accept: killed-mid-run delegation still yields findings; cut transport flagged.
- [ ] P4. Routing table extension. Task-type → specialist → default skills rows: coding, review, docs/essay (writer + humanizer/edit-article), deep research (researcher + research). ask-matt stays a normal skill, never a routing layer. Fix stale fallback skill name (review → code-review). Files: prompt-builder.ts, specialists.ts. Accept: routing snapshot test.
- [ ] P5. Prompt compression. Remove duplicate static tool table (keep dynamic generateToolDocumentation); add interactive_shell to intro tool list; move loop_until docs (~50 lines) to on-demand skill "orchestrator-loops". Target ~2.5k tokens from ~4k. Accept: prompt snapshot + token-count assertion.
- [ ] P6. Communication contract. Replace TERSE_INSTRUCTION block with CEO-communication block: ADHD output rules (lead with next action, numbered steps, restate state per turn, ≤5 items per list, one concrete next action) + architecture-part-level reporting + no silent mechanisms + internals on request. Files: prompt-builder.ts. Accept: prompt contains contract; old caveman block gone.

## WS-P — PBT guard [blocked by WS-R..WS-PR; grill first]
- [ ] PBT-0. Scoping grill with CEO before ticketing: which languages, trigger point (after every edit? on demand?), who writes properties (worker-written vs generated), feedback loop shape, token budget. Reference: quickcheck-in-every-language (fast-check TS, hypothesis Python, proptest Rust, gopter Go, jqwik JVM, StreamData Elixir, FsCheck .NET).
- [ ] PBT-1+. Tickets written from grill outcome. Doctrine: property-based tests are deterministic worker-feedback guards, like lint but deeper.

## WS-L — Loop engine v2 [blocked by T1; informed by WS-U]
CEO spec: goal + objective metric + hard iteration cap + best-so-far wins. Orchestrator monitors; worker iterates fresh each round with history handed over. Example: efficiency 50%→90% goal, scores 60/40/80/83/88/81, cap 6 → final result = iteration 5 (88%), never the last.
- [ ] L1. Metric abstraction (v1 D1). loopUntil gains metric (command → number), direction (higher-better | lower-better), target. Accept: schema test; metric command yields number.
- [ ] L2. Trajectory classifier (v1 D2). CONVERGING / STALLING / OSCILLATING / DIVERGING from metric history; stop on target, stall+patience k=2, oscillation 2 consecutive, or cap. Files: new loop-engine.ts. Accept: unit tests per trajectory.
- [ ] L3. Best-so-far rollback (v1 D3). Loop returns argbest iteration result per direction, never last. Accept: CEO example sequence returns iteration 5.
- [ ] L4. Fresh-context iterations + state file (v1 D4). New worker session per iteration; orchestrator passes {objective, metric history, best-so-far, remaining budget}; state persisted to /tmp/orchestrator-debug/loop-<id>.json. Accept: kill mid-loop, resume, count continues.
- [ ] L5. Budget governor (v1 D5). tokenBudget with operational vs evaluation split from T1 accumulator. Accept: simulated loop stops at budget with best-so-far returned.
- [ ] L6. Loop UI (v1 D6). Panel shows "⠸ iter 3/6 · metric 60→40→80 · best 80" + token line. Accept: smoke test live trajectory.

## WS-E — Execution infrastructure [alongside all]
- [ ] E1. Per-ticket acceptance tests included in coder delegation task text (no tdd skill on weak workers — induces spurious plan calls).
- [ ] E2. Session feedback loop: report delegation friction per session; fold into tickets.
- [ ] E3. Regression gate per session: vitest green + tui-smoke clean + H1 commit done.

## Session breakdown (suggested)
| Session | Tickets | Why |
|---|---|---|
| 1 | H0, R1-R4 | removal, near-zero risk |
| 2 | O1-O3 | flight recorder (delegation observability) |
| 3 | T1-T3 | the heartbeat |
| 4 | U1-U5 | UI hardening |
| 5 | P1-P6 | prompt & info layer |
| 6 | PBT-0 grill + PBT track | doctrine track |
| 7+ | L1-L6 | loop engine |

## Verification gates
- Per ticket: acceptance test green + no regressions vs 913 baseline.
- Per session: vitest + tui-smoke clean + commit pushed.
- WS-L ships only after: scratch-repo loop stops via classifier (not cap) AND best-so-far returned.

## Explicitly NOT doing
- No regex/heuristic classification of task prose in any guard, gate, or validator (VISION non-goal).
- No weak/strong model detection — design for weak, never degrade strong.
- No ask-matt as routing layer (stays a normal skill).
- No wholesale OMP port — parts only (watchdog, collapse, dedup, recentTools).
- No embedding-cosine convergence (test/lint metrics cheaper and stricter).
- No parallel-mode batching of these tickets (weak model + overlapping files).
