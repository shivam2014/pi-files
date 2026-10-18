# pi-files orchestrator eval — results

Generated: 2026-09-19T09:10:50.440Z

| field | value |
| --- | --- |
| run id | `2026-09-19T08-55-33-205Z` |
| repo commit | `ac5edf0` |
| provider / model | `opencode-go` / `deepseek-v4-flash` |
| tasks | 8 |
| per-run timeout | 300s |
| runs recorded | 16 |
| total wall time | 623.0s |
| run note | t1-t8 run 2026-09-19T08-55Z (16 runs) with t5-csv (both arms) re-run at 2026-09-19T09-08Z after the t5 prompt was tightened to specify parseCSV('') semantics. All other runs unchanged. |

## Method (short)

Each task runs twice in a fresh scratch dir seeded from the same fixture:

- **ARM A — single agent:** `pi --provider <p> --model <m> --print --mode json --no-extensions --no-skills --no-context-files`
- **ARM B — orchestrator:** the same invocation **without** the disable flags, so the globally-installed orchestrator extension auto-loads and owns planning + delegation.

Pass/fail comes only from an external grader script (`evals/checks/<id>.mjs`, exit 0 = pass) that runs in the scratch dir and is never visible to the agent. Token/cost numbers are parsed from the `--mode json` event stream (`message_end` usage), delegated work included only as far as the parent session observes it. See `README.md` for the full method and limits.

## ARM A — single-agent

Runs: **8** · Passed: **8/8 (100%)** · Errors/timeouts: 0

Total cost **$0.0069** · avg cost/run $0.0009 · avg tokens/run 10405 · avg wall 13.5s

Total delegates: 0 · total escalation signals: 0

| task | diff | pass | wall (s) | in tok | out tok | cache tok | cost | turns | deleg. | escal. | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| t1-hello | trivial | ✅ | 7.4 | 1399 | 162 | 2048 | $0.0003 | 2 | 0 | 0 | ok |
| t2-fizzbuzz | easy | ✅ | 8.3 | 1739 | 553 | 6400 | $0.0006 | 4 | 0 | 0 | ok |
| t3-range-bug | easy | ✅ | 7.4 | 1714 | 574 | 6400 | $0.0006 | 4 | 0 | 0 | ok |
| t4-add-tests | medium | ✅ | 11.3 | 2345 | 665 | 8960 | $0.0008 | 5 | 0 | 0 | ok |
| t5-csv | medium | ✅ | 10.9 | 1877 | 1578 | 8192 | $0.0013 | 4 | 0 | 0 | ok |
| t6-dedupe-perf | hard | ✅ | 11.5 | 1830 | 490 | 6144 | $0.0006 | 5 | 0 | 0 | ok |
| t7-refactor-multifile | hard | ✅ | 31.4 | 2220 | 981 | 7168 | $0.0009 | 6 | 0 | 0 | ok |
| t8-router | hard | ✅ | 19.8 | 2776 | 2174 | 14848 | $0.0018 | 6 | 0 | 0 | ok |

## ARM B — orchestrator

Runs: **8** · Passed: **8/8 (100%)** · Errors/timeouts: 0

Total cost **$0.0267** · avg cost/run $0.0033 · avg tokens/run 64766 · avg wall 64.4s

Total delegates: 10 · total escalation signals: 0

| task | diff | pass | wall (s) | in tok | out tok | cache tok | cost | turns | deleg. | escal. | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| t1-hello | trivial | ✅ | 31.3 | 15835 | 513 | 29440 | $0.0028 | 3 | 1 | 0 | ok |
| t2-fizzbuzz | easy | ✅ | 39.4 | 16135 | 656 | 29696 | $0.0029 | 3 | 1 | 0 | ok |
| t3-range-bug | easy | ✅ | 44.8 | 16663 | 603 | 29696 | $0.0029 | 3 | 1 | 0 | ok |
| t4-add-tests | medium | ✅ | 59.8 | 16583 | 799 | 29696 | $0.0031 | 3 | 1 | 0 | ok |
| t5-csv | medium | ✅ | 69.9 | 16424 | 1200 | 47104 | $0.0033 | 6 | 1 | 0 | ok |
| t6-dedupe-perf | hard | ✅ | 84.0 | 17756 | 1647 | 84480 | $0.0039 | 7 | 1 | 0 | ok |
| t7-refactor-multifile | hard | ✅ | 95.2 | 17473 | 1525 | 60416 | $0.0037 | 5 | 2 | 0 | ok |
| t8-router | hard | ✅ | 90.7 | 17450 | 2080 | 64256 | $0.0041 | 5 | 2 | 0 | ok |

## Head-to-head

| metric | ARM A | ARM B |
| --- | --- | --- |
| success rate | 100% | 100% |
| passes / runs | 8/8 | 8/8 |
| avg wall (s) | 13.5 | 64.4 |
| total cost | $0.0069 | $0.0267 |
| avg cost / run | $0.0009 | $0.0033 |
| avg tokens / run | 10405 | 64766 |
| total delegates | 0 | 10 |
| total escalations | 0 | 0 |
| errors / timeouts | 0 | 0 |

## Failures & anomalies

None in the recorded run: every run completed with `status=ok` and passed its grader.

One grader caveat carried over from an earlier pass: in the first full run, ARM A failed `t5-csv` on the assertion `parseCSV("") === [[""]]`, because the original prompt did not specify empty-input semantics and the agent returned `[]` instead. The task prompt was tightened to state the convention explicitly (the grader was left untouched) and `t5-csv` was re-run for both arms — both now pass. See the run note above.

## Limits

- **Single model, single seed.** n is tiny; treat percentages as directional, not statistically meaningful.
- **ARM B token accounting is a lower bound.** The orchestrator's child/sub-agent token usage is not surfaced in the parent `--mode json` event stream, so ARM B cost under-counts whatever the delegated specialists consumed.
- **Noisy provider.** `opencode-go` occasionally returns upstream 5xx (`auto_retry_end`); such runs are recorded with `status=upstream-error` and count as failures rather than being retried.
- **Grader is a smoke test.** The success checks verify observable behaviour, not code quality, so a passing run can still be ugly.

Full discussion in `evals/README.md`.
