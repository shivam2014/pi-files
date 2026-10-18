# pi-files evals — does the orchestrator earn its keep?

A runnable benchmark that measures the `pi-files` orchestrator extension against a
plain single-agent `pi` invocation on the same coding tasks, same model, same fixtures.

It is not a doc: `node evals/runner.mjs` actually spawns both agents, grades their
output with external scripts, and writes real token/cost/latency numbers.

## Problem

The orchestrator adds a layer on top of the agent: it plans, delegates to specialists
(coder / scout / reviewer), enforces scope, and escalates on difficulty. That layer
costs tokens and wall-clock time. The question this harness answers is narrow and
honest:

> On a fixed task set, what does the orchestrator buy and what does it cost,
> relative to a single agent with no orchestrator, no guards, and no context files?

## Method

For each task the runner does the same thing twice, in a **fresh scratch dir seeded
from the same fixture**, so neither arm inherits the other's files:

| | ARM A — single agent | ARM B — orchestrator |
| --- | --- | --- |
| command | `pi --provider <p> --model <m> --print --mode json --no-extensions --no-skills --no-context-files` | `pi --provider <p> --model <m> --print --mode json` |
| extensions | none | default discovery (orchestrator auto-loads from `~/.pi/agent/extensions`) |
| skills / AGENTS.md | disabled | enabled |
| planning / delegation | whatever the base agent does | orchestrator-owned (`plan`, `delegate`) |

Both arms use the same provider and model and get the identical prompt appended as the
final CLI argument. Each run gets its own `--session-dir` under its scratch dir.

**Grading is external and hidden from the agent.** Every task names a script in
`evals/checks/<id>.mjs`. After the agent exits, the runner executes
`node evals/checks/<id>.mjs <scratchDir>` with cwd inside the scratch dir; exit code 0
is a pass. The checks live outside the scratch dir, so an agent cannot read or edit its
own grader, and they assert observable behaviour (values, timings, exit codes), not the
presence of a particular implementation. `node evals/selftest.mjs` proves every grader
rejects the untouched fixture and accepts a known-good reference solution.

**Metrics** are parsed from the `--mode json` event stream (one JSON object per line):

- success (from the grader), wall time (measured by the runner),
- `input` / `output` / `cacheRead` / `cacheWrite` tokens and `cost.total`, summed over
  assistant `message_end` events,
- turn count, tool-call histogram, `delegate` count and the specialist names requested,
- escalation signals: `ask_orchestrator` calls plus `recommend=investigate|plan|review`
  markers surfaced in delegate results,
- upstream failures from `auto_retry_end { success: false }`.

## How to run

```bash
# validate the graders first (no model calls, ~1s)
node evals/selftest.mjs

# full set, both arms (background + poll: each run takes ~10-60s, 16 runs total)
nohup node evals/runner.mjs --out=evals/results.json --log=/tmp/evalrun/runner.log \
  > /tmp/evalrun/runner.stdout 2>&1 &

# a reduced set / one arm / first N tasks
node evals/runner.mjs --tasks=t1-hello,t3-range-bug,t5-csv,t7-refactor-multifile
node evals/runner.mjs --arms=A --limit=3

# regenerate the markdown from raw results
node evals/report.mjs

# fold a targeted re-run back into the main results file
node evals/merge.mjs evals/results.json /tmp/evalrun/t5-rerun.json --out=evals/results.json
```

Flags: `--tasks=a,b` (subset), `--arms=A,B`, `--timeout=<sec>` per run (default 300,
kills the process group on expiry and records `status=timeout`), `--scratch=<dir>`
(default `/tmp/evalrun`), `--out`, `--log`, `--provider`, `--model`.

Results are written to `results.json` **after every run**, so a killed runner still
leaves partial results. The runner never crashes on a bad run: an agent that hangs,
dies, or trips an upstream 5xx is recorded as a failed run with a status and an error
note, and the harness continues.

## Files

| path | role |
| --- | --- |
| `tasks.json` | 8 tasks, trivial → hard, each with prompt + grader name |
| `fixtures/<id>/` | seed files copied into each scratch dir |
| `checks/<id>.mjs` | external graders (exit 0 = pass) |
| `runner.mjs` | runs both arms, captures metrics, persists `results.json` |
| `report.mjs` | renders `RESULTS.md` from `results.json` |
| `merge.mjs` | folds targeted re-runs back into `results.json` (keyed by task+arm) |
| `selftest.mjs` | proves every grader rejects the fixture and accepts a reference solution |
| `results.json` | raw run records |
| `RESULTS.md` | generated table + method note |

## Results (measured)

The numbers live in [`RESULTS.md`](./RESULTS.md), generated from `results.json`. Recorded run:
`opencode-go/deepseek-v4-flash`, repo commit `ac5edf0`, 8 tasks × 2 arms = 16 runs, 623s total wall time.

| metric | ARM A — single agent | ARM B — orchestrator |
| --- | --- | --- |
| success | 8/8 (100%) | 8/8 (100%) |
| avg wall time | 13.5 s | 64.4 s (4.8×) |
| total cost | $0.0069 | $0.0267 (3.9×) |
| avg cost / run | $0.0009 | $0.0033 |
| avg tokens / run | 10,405 | 64,766 (6.2×) |
| delegates | 0 | 10 (all `coder`) |
| escalation signals | 0 | 0 |
| errors / timeouts | 0 | 0 |

Read honestly: on this task set the orchestrator **matched** the single agent on
correctness and paid roughly **4–6× in cost and time** to do it. At this scale it did not
earn its keep. The interesting part is *where* the cost goes: ARM B is dominated by the
orchestrator's own planning/verification turns on top of a sub-agent that costs roughly
as much again (see limit #2). The tasks are small enough that a single agent finishes
before the delegation round-trip pays off.

One caveat from an earlier pass is recorded in `RESULTS.md`: the first full run had ARM A
fail `t5-csv` on the assertion `parseCSV("") === [[""]]`. The prompt did not specify
empty-input semantics and the agent returned `[]` — a defensible reading. The **prompt was
tightened** to state the convention (the grader was left untouched) and `t5-csv` was
re-run for both arms. Both now pass; the repair is noted in `results.json` `meta.note`.

## Limits — what this does not prove

Read this before quoting any number above.

1. **n is tiny and single-seeded.** 8 tasks, one run each per arm. Percentages are
   directional; a single flaky upstream error moves the success rate by 6 points. This
   is a smoke benchmark, not a statistically powered study.
2. **ARM B cost is a lower bound.** The orchestrator's delegated sub-agents run as child
   sessions whose token usage is *not* surfaced in the parent `--mode json` event stream.
   The runner can only sum what the parent session observes, so ARM B's reported
   tokens/cost under-count the true spend of whatever the specialists consumed. The
   orchestrator therefore looks cheaper than it is; treat ARM B cost as `>=` the table.
3. **Provider noise is real.** `opencode-go` intermittently returns upstream 5xx
   (`auto_retry_end { success: false }`) after its own retries. Those runs are recorded
   as `status=upstream-error` and counted as failures — they are model-provider failures,
   not harness or orchestrator behaviour.
4. **Graders are smoke tests.** They check observable behaviour, not quality. A passing
   run can be ugly, over-engineered, or accidentally correct. A run that fails a grader
   may still have produced "reasonable" code that missed one assertion.
5. **Fixtures are small and synthetic.** No legacy codebase, no large repo navigation, no
   hidden requirements. The orchestrator's real edge (scoping, review, multi-file
   discipline) is under-represented at this scale.
6. **Only one model.** All runs use `opencode-go/deepseek-v4-flash`. Conclusions do not
   transfer to other models or providers without re-running.
7. **Wall time includes provider latency.** Latency here is dominated by the remote model
   and by the orchestrator serialising planning → delegation → verification, not by local
   CPU.

## What would make it real

- More tasks (30+), multiple seeds per task, and a second model, to get error bars.
- Instrument the orchestrator to emit sub-agent token usage into the parent stream so
  ARM B cost stops being a lower bound.
- Held-out, non-toy tasks in a real repo, graded by the repo's own test suite.
