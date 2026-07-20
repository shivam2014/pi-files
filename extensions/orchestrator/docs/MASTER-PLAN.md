# MASTER PLAN — Orchestrator Extension: Live Tokens, Plan Panel UX, Loop Engine, Robustness

> Multi-session execution plan. Each ticket is agent-ready: goal, files, acceptance criteria.
> Execute blockers-first, one ticket per delegation, clear context between tickets.
> Orchestrator: read this file at session start, pick next unblocked ticket, delegate, verify, check off.

## 0. Context & hard-won constraints

- Subagents run on a WEAK model (deepseek-v4-flash-2). Observed failure modes THIS project:
  1. Final report lost when session aborts/truncates (3 occurrences) — findings kept in-context only.
  2. Model announces intent then emits stopReason="stop" without acting (researcher, 15s session).
  3. Model identity confusion: scout role-played as orchestrator, hallucinated plan/delegate tools.
  4. Broad tasks (>3 items) → scattered exploration, wasted turns, truncated output.
- Therefore: narrow tasks (≤3 items), exact entry paths, verbatim-quote demands for type extraction,
  mechanical acceptance criteria, findings must leave the subagent's context (file or final message).
- Sequential delegation mode (parallel only for provably disjoint file sets).

## 1. Audit findings (done, verified against source)

### pi SDK (node_modules/@earendil-works/pi-coding-agent)
- `Usage { input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost{...} }` — pi-ai/types.d.ts L251
- `AssistantMessage.usage: Usage` required, every finalized assistant message
- Events: `message_end { message }` per-turn (filter role==="assistant"), `turn_end`, `agent_end { messages[] }`
- `setWidget(key, string[] | factory, { placement })` — current usage correct

### OMP (/private/tmp/oh-my-pi)
- Token flow: task/executor.ts — PROGRESS_COALESCE_MS=150; accumulate per message_end assistant-only;
  progress.tokens = input+output+cacheWrite (excludes cacheRead); contextTokens = latest totalTokens;
  emit via onProgress + eventBus "task:subagent:progress"
- Todo strike: tools/todo.ts — STRIKE_START="\x1b[9m", STRIKE_END="\x1b[29m",
  partialStrikethrough(text,n); HOLD_FRAMES=2 + REVEAL_FRAMES=12 @65ms; component-scoped repaint
- Collapse: selectCollapsedTodos caps items + "… N more"; phase one-liner `{name} {done}/{total}`
- LoopWatchdog (packages/tui/src/loop-watchdog.ts): event-loop lag probe, 250ms interval/threshold — infra reference only

### Extension current state (~/.pi/agent/extensions/orchestrator)
- subagent-runner.ts ~L717: usage captured ONLY on agent_end/done → final totals, NOT live
- orchestrator-theme.ts: formatTokens() exists, unused
- plan-panel.ts: 9-line widget budget, 1s+120ms timers, loop_until ALREADY EXISTS
  (LoopUntilConfig, runLoopIteration, rollingSummary, consecutivePasses, oscillation exit)
- activity-feed.ts: event-driven render + _lastFeedSnapshot dedupe

### Loop research (URLs in delegation log 2026-07-20T21-18)
- Claude ralph-wiggum: Stop hook exit-2 blocks exit, stop_hook_active guard prevents infinite block,
  reason field = next prompt. One block per work stretch.
- Codex /goal: persistent objective + budget template injected every turn; self-audit before done.
- LoopGain: trajectory classifier (FAST_CONVERGE/CONVERGING/STALLING/OSCILLATING/DIVERGING),
  best-so-far rollback (argmin error), 92.8% cost cut vs max_iter.
- arXiv 2606.27009: judge-free semantic stop (embedding cosine + patience k=2) saves 38% tokens
  at parity; per-round LLM judging is counter-productive (2.3× cost).
- BMAD: fresh-context worker per iteration; orchestrator owns state; spec-file frontmatter
  state machine as communication channel; adversarial review inside loop.

## 2. Tickets (blocking edges declared)

### WS-A — Robustness & prompt audit [BLOCKS EVERYTHING]
Reliable hands before more work.

- [x] A1. Subagent system-prompt audit (P0)
  Investigate: what system prompt do subagents actually receive? Scout session 2026-07-20
  role-played as orchestrator (hallucinated plan/delegate tools). Check prompt-builder.ts:
  is the orchestrator capabilities block leaking into subagent prompts? Is the specialist
  roster (⚠ CANNOT lists) included in SUBAGENT prompts (it must NOT be — that's orchestrator
  routing info) while the subagent's OWN tool list is accurate?
  Files: prompt-builder.ts, subagent-runner.ts, specialists.ts
  Accept: subagent prompt contains only its own tools with explicit "you do NOT have: <tools>"
  line (observed: writer attempted bash, scout hallucinated plan/delegate); no orchestrator
  tool docs; test asserting prompt does not contain "delegate(" for scout sessions.

- [x] A2. Capability-aware task validation
  Orchestrator instructed researcher (no write tool) to write a file → model stopped silently.
  Fix: delegate() validates task text against specialist ⚠CANNOT list (regex for "write to",
  "create file" vs tools). Warn-or-block.
  Files: delegate-tool.ts or delegate-pipeline.ts, specialists.ts
  Accept: unit test — instructing researcher to "write file X" returns warning.

- [x] A3. Early-stop detection + nudge
  If stopReason="stop" AND (planned steps incomplete OR task explicitly required deliverable
  missing) → re-prompt subagent once: "You stopped before completing: <missing>. Continue."
  Files: subagent-runner.ts (agent_end handler), plan-panel.ts (steps incomplete check)
  Accept: simulated early-stop session gets exactly one nudge; second stop passes through.

- [ ] A4. Findings durability
  Subagent final report must survive abort. Mechanism per specialist:
  coder/writer (have write): findings file /tmp/orchestrator-debug/findings-<id>.md written
  incrementally (instruct in prompt). scout/researcher/reviewer (no write): enforce
  "final message = complete structured findings" in prompt; pipeline salvages from
  diagnostics JSON if final text empty.
  Files: specialists.ts (prompts), delegate-pipeline.ts (salvage), subagent-diagnostics.ts
  Accept: killed-mid-run delegation still yields ≥80% findings in delegate result.

- [ ] A5. Output hygiene
  When final report exists, delegate result = report + metrics only (no raw tool-result echo).
  When missing, mark "⚠ PARTIAL — salvaged". Cuts orchestrator context burn ~70%.
  Files: delegate-pipeline.ts, delegate-output-formatter.test.ts
  Accept: snapshot test — result contains no raw JSON tool-result blocks.

- [ ] A6. Completed-with-no-work detection + plan-step integrity
  Observed (session 2): weak-model delegations returned status=ok with edit=0 (one
  scattered 23 reads/0 edits; one emitted orchestrator-only plan() call) and the
  pipeline incorrectly marked plan steps done. Also: delegate() auto-advance +
  insertion-order tracking fought orchestrator bookkeeping (needed remove_step/
  re-plan resets).
  Fix: (a) delegate() result validation — coder/writer delegations with zero
  edit/write/bash-mutating tool calls AND no deliverable → treat as error, do NOT
  advance plan step, surface "⚠ no-work completion". (b) Plan step state: only
  finalize a step when its delegation produced verified work or explicit user
  override. (c) tdd skill caution: weak model + tdd skill induced spurious plan()
  calls — skip tdd skill for weak models, enforce test-in-same-task instead.
  Files: delegate-pipeline.ts, plan-panel.ts, plan-tool.ts
  Accept: unit test — fake delegation with metrics edit=0 returns error status,
  plan step NOT advanced; E2 ticket text updated with tdd-skill caveat.

### WS-B — Plan panel readability + OMP todo port [blocked by A1]
- [ ] B1. Hard-truncate goal + step labels to one line (~58 chars, ellipsis). Never wrap.
  Full text in peek overlay + timeline dump. Files: plan-panel.ts, activity-feed.ts
  Accept: 200-char task label renders exactly 1 widget line.

- [ ] B2. Strikethrough completed steps: ✓ + \x1b[9m…\x1b[29m + dim.
  Strike-reveal animation: 2 hold + 12 reveal frames @65ms, reuse _spinnerTimer.
  Files: activity-feed.ts, orchestrator-theme.ts (symbols), spinner-state.ts
  Accept: snapshot test struck line; smoke test shows animation frames.

- [ ] B3. Collapse rule: budget 9 lines; overflow → fold completed prefix to "✓ N completed";
  always show active + next 2 pending; active substeps cap 3 + "… +N more".
  Files: plan-panel.ts (trimToBudget)
  Accept: 12-step plan renders ≤9 lines with fold line.

Target visual:
```
◆ 🔄 Port OMP token usage into delegate widget
✓ ~~Scout OMP token tracking~~ (1m 40s)
✓ ~~Scout orchestrator extension~~ (1m 47s)
⠸ Implement live token accumulator  ↑3.2k ⇄108k ↓1.1k
○ Render token line in widget
○ … +2 more
```

### WS-C — Live token usage [blocked by A1; B preferred first]
- [ ] C1. Usage accumulator in subagent-runner.ts: message_end handler, role==="assistant"
  guard; accInput/accOutput/accCacheRead/accCacheWrite += u.*; ctxTokens = u.totalTokens;
  ctxWindow from model.contextWindow (resolve at model selection ~L420, may be undefined → "ctx N/?").
  Keep agent_end capture as final flush. PROGRESS_COALESCE_MS=150 const; piggyback existing
  render throttle, no new timers.
  Accept: unit test accumulates 3 assistant message_end events, ignores toolResult.

- [ ] C2. Token line render in activity-feed.ts status line (same line as elapsed):
  `↑{input} ⇄{cacheRead} ↓{output} · ctx {cur}/{win}` via formatTokens(); glyphs added to
  orchestrator-theme SYMBOLS. Hide ⇄ if cacheRead==0 all run. feed.setUsage() +
  onUpdate details {tokenInput, tokenOutput, tokenCached, ctxTokens}.
  Freeze line on agent_end (drop spinner, keep totals).
  Accept: activity-feed.test.ts render cases (with/without window, zero-cache, k/M formats).

- [ ] C3. Secondary surfaces: plan-panel step detail live updates (updatePlanStepDetail on
  coalesced ticks, replacing end-only "tokens: ↑X ↓Y ◎Z"); peek-overlay header token segment;
  model tag [model] rendered in delegate block header (delegate-feed-builder.ts).
  Accept: smoke test — tokens visible in panel + peek during delegation.

### WS-D — Loop engine v2 (convergence) [blocked by A1-A4; C optional]
Extends existing loop_until. Design principles from research:
cheap-signal-first, orchestrator owns state, fresh-context iterations, one-block-per-stretch.

- [ ] D1. Error-signal abstraction: loopUntil config gains `metric` — user-declared scalar,
  lower-better. Supported: failing-test-count (bash command), lint-error-count,
  judge-score (evaluator specialist, LAST RESORT — per-round judging is 2.3× cost, research).
  Files: types.ts (LoopUntilConfig), plan-panel.ts
  Accept: config schema test; metric command runner returns number.

- [ ] D2. Trajectory classifier (LoopGain port, heuristics not t-test — weak-judge safe):
  track metric history; classify CONVERGING (strict decrease 2 iters), STALLING (no decrease
  2 iters), OSCILLATING (alternating), DIVERGING (increase 2 iters). Stop on: metric ≤ target,
  or STALLING + patience k=2, or OSCILLATING 2 consecutive, or maxIterations.
  Files: new file loop-engine.ts (extracted from plan-panel.ts)
  Accept: unit tests per trajectory from scripted metric sequences.

- [ ] D3. Best-so-far rollback: keep argmin(metric) iteration's result; loop returns best,
  never last. Files: loop-engine.ts
  Accept: oscillating sequence returns argmin iteration output.

- [ ] D4. Fresh-context iterations + state file (BMAD port): each iteration = new subagent
  session; orchestrator passes {objective, metric value history, best-so-far summary,
  remaining budget} as structured template. Loop state persisted to
  /tmp/orchestrator-debug/loop-<id>.json after every iteration (cross-session resumable).
  Files: loop-engine.ts, delegate-pipeline.ts
  Accept: kill session mid-loop, resume from state file, iteration count continues.

- [ ] D5. Budget governor: loopUntil gains tokenBudget; track operational vs evaluation
  tokens separately (usage from C1 accumulator). Hard stop at budget with "⚠ budget
  exhausted, best-so-far returned".
  Accept: simulated loop stops at budget; details show op/eval token split.

- [ ] D6. Loop UI: plan panel loop step shows `⠸ iter 3/10 · metric 7→4→4→2 · best 2`
  with token line (reuse B/C render). Strike + fold when done.
  Accept: smoke test loop run shows live metric trajectory.

### WS-E — Execution infrastructure [no blockers, do alongside A]
- [ ] E1. Session-start protocol for cheap orchestrator: system prompt addition —
  "On session start, read docs/MASTER-PLAN.md, find first unblocked unchecked ticket,
  declare plan, delegate." Files: prompt-builder.ts
- [ ] E2. Per-ticket tests: every coder delegation includes its acceptance test.
  NOTE: do NOT pass the tdd skill to weak models (observed: induces spurious
  plan() calls); require the test in the task text instead. tdd skill OK on
  stronger models.
- [ ] E3. After each ticket: run extension tests + ~/.pi/tui-smoke.sh; append result to
  docs/MASTER-PLAN-LOG.md (date, ticket, pass/fail, friction notes).
- [ ] E4. Session feedback loop: report delegation friction per session (orchestrator
  extension bug-report convention); fold fixes into WS-A tickets.
- [ ] E5. Version-control hygiene: extension working copy had mass untracked
  files; completed work (A1-A3) at risk. After each session: run ~/.pi/sync.sh,
  commit + push from ~/pi-files. Also fix pre-existing tsc errors
  (subagent-runner.ts advanceStepTool signature; ../nyro-sync/) that fail
  project-wide lint and mask real regressions.

## 3. Session breakdown (suggested)

| Session | Tickets | Why |
|---|---|---|
| 1 | A1, A2, A3 | prompt/robustness core — small, high-value |
| 2 | A4, A5, E1 | durability + output hygiene |
| 3 | B1, B2, B3 | plan panel UX (user-visible quick win) |
| 4 | C1, C2 | live tokens core |
| 5 | C3, D1, D2 | polish + loop engine start |
| 6 | D3, D4, D5 | loop engine complete |
| 7 | D6, E2-E4 audit, full regression | ship |

## 4. Verification gates
- Per ticket: its acceptance test green + no regressions in existing *.test.ts
- Per session: tui-smoke.sh clean (panel visible, icons ✓⠋○, no crash logs)
- Before WS-D ships: full loop smoke — loop_until fixing lint errors in scratch repo,
  must stop via classifier not maxIterations.

## 5. Explicitly NOT doing
- No embedding-cosine convergence (research: judge-free semantic stop wins on text, but our
  loops are code tasks — test/lint counts are cheaper and stricter). Revisit if prose loops needed.
- No parallel-mode batching of these tickets (weak model + overlapping files).
- No OMP framedBlock/output-block port (transcript-block luxury; widget budget forbids).
