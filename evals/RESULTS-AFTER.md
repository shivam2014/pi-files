# pi-files orchestrator eval — RESULTS AFTER skill-index reduction

Measured delta from the skill-index reduction (`noSkills: true` + names-only roster),
committed in `~/.pi/agent/extensions/orchestrator` at tag `baseline-2026-09-19` / commit `a1a30c2`.
Scope: **t1-hello smoke** (ARM B orchestrator + its coder subagent).

## Pre-check — is the measurement valid?

- **fresh spawn per run = YES.** `evals/runner.mjs` launches `pi` as a new detached child
  process per run (`spawn(process.env.PI_BIN || "pi", args, { detached: true, … })`); each
  spawn reloads extension source from disk. No in-process extension reuse.
- **Change is present in the loaded source:**
  - `subagent-runner.ts:913` → `noSkills: true`
  - `specialists.ts:576-583` → compact `buildSkillSection()` using `listAvailableSkillNames()`
  - Confirmed at working tree and at `a1a30c2`; `a1a30c2..HEAD` changes no source.
- ⇒ Measurement is against the changed code, not stale.

## Method

- **BEFORE** = baseline eval run `2026-09-19T08-55-33-205Z` (pre-change), verified against raw artifacts.
- **AFTER** = fresh smoke `node evals/runner.mjs --tasks=t1-hello --out=/tmp/evalrun2/smoke.json`
  (runId `2026-09-19T10-31-28-630Z`). First attempt (`10-29-58-338Z`) discarded: ARM B hit a
  provider **530 upstream error** (in=0/out=0). Corroborating AFTER run: `10-07-36-807Z`.
- Orchestrator usage = sum of assistant `input/cacheRead/output` in the `--mode json` stream.
  Coder subagent usage is **not** in the parent stream; read from the delegate `tokenUsage`
  and the flight-recorder dump (`messages[first assistant].usage.input` = turn-1 input).

## t1-hello — ARM B (orchestrator session)

| metric | BEFORE | AFTER (10:31) | AFTER (10:07) | Δ (10:31) | % (10:31) |
| --- | --- | --- | --- | --- | --- |
| input | 15,835 | 14,408 | 13,334 | −1,427 | −9.0% |
| cacheRead | 29,440 | 24,832 | 24,832 | −4,608 | −15.6% |
| output | 513 | 527 | 436 | +14 | +2.7% |
| cost (USD) | $0.002771 | $0.002552 | $0.002336 | −$0.000219 | −7.9% |
| wall (s) | 31.3 | 84.44 | 28.8 | +53.1 *(provider noise)* | — |
| orchestrator turn-1 input | 14,605 | 12,284 | — | −2,321 | −15.9% |

## t1-hello — coder subagent

| metric | BEFORE | AFTER (10:31) | AFTER (10:07) | Δ (10:31) | % (10:31) |
| --- | --- | --- | --- | --- | --- |
| turn-1 input | 12,151 | 9,687 | 9,673 | −2,464 | −20.3% |
| total input | 13,337 | 10,955 | 11,179 | −2,382 | −17.9% |
| cached | 76,032 | 99,328 | 82,944 | +23,296 | +30.6% |
| output | 1,354 | 2,982 | 1,821 | +1,628 | +120% |
| turns | 7 | 11 | 9 | +4 | — |

## Measured saving

- **Coder turn-1 input: −2,464 tokens (−20.3%)** — the direct target of the change.
- **Orchestrator turn-1 input: −2,321 tokens (−15.9%)**; orchestrator cacheRead −4,608 (−15.6%).
- **ARM B cost: −$0.000219 (−7.9%) fresh run, −$0.000435 (−15.7%) corroborating run** →
  ~8–16% per-run saving on the orchestrator-only billed cost.
- The removed index is smaller than assumed: 47 global skills, name+description ≈ 10,279 chars
  ≈ **2,570 tokens**; minus the names-only roster re-added (~180 tok) ⇒ net ≈ 2,400 tok.
  **The expected 4,000–6,000 token drop was ~2× too high; the true drop is ≈2,400–2,500.**

## Caveats

- Runner ARM B cost bills **only the orchestrator**; the subagent's tokens are in the delegate
  result and are not summed — so the subagent's own prompt shrink saves tokens not shown in cost.
- The AFTER coder took **11 turns vs 7**, so its **aggregate** tokens rose (cached +30.6%,
  output +120%) even though turn-1 fell. This run's net subagent saving is masked by extra turns;
  turn-1 input is the clean, attributable metric.
- n is tiny (1 baseline, 2 after) and the provider (`opencode-go`) is noisy — treat as directional.
