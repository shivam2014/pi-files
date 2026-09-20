# CANON-ONLY.md

Truthful replacement for the record left by commit `fe6dc41` (see note at the end). Files listed here exist in the canon tree (`~/pi-files/extensions/`) but have **no counterpart in the live tree** (`~/.pi/agent/extensions/`), so `sync.sh` would delete them on a `--delete` run. They are **kept** deliberately.

Regenerate the list: `bash ~/.pi/sync.sh` → "drift report (informational only)" section.
Current count (regenerated 2026-09-20): **12 canon-only files, 0 live-only additions** — the live tree is a strict subset of canon.

| # | Path (under `extensions/`) | Kept | Why |
|---|----------------------------|------|-----|
| 1 | `orchestrator/README.md` | keep | docs — extension README exists only in canon |
| 2 | `local-latex/README.md` | keep | docs |
| 3 | `vision-router.README.md` | keep | docs |
| 4 | `token-saver.README.md` | keep | docs |
| 5 | `scope-guard.README.md` | keep | docs |
| 6 | `lint-guard.README.md` | keep | docs |
| 7 | `herdr-agent-state.README.md` | keep | docs |
| 8 | `diagram.README.md` | keep | docs |
| 9 | `vitest.config.ts` | keep | runner config — canon-side vitest setup; the live tree has no test-runner config |
| 10 | `token-saver.test.ts` | keep | the only copy of the token-saver tests |
| 11 | `scope-guard.ts` | keep | root standalone scope guard, diverges from the orchestrator copy (below) |
| 12 | `.gitignore` | keep | repo hygiene — canon ignore rules; the live tree is not a git checkout |

## Root `extensions/scope-guard.ts` — decision: KEPT

- **Diverges** from `extensions/orchestrator/scope-guard.ts`: 208 vs 236 lines; diff shows 386 differing lines (`diff a b | grep -c '^[<>]'`).
- Root version is **standalone**: zero `./scope-manager` imports; the orchestrator copy imports its scope-manager (1 match).
- Nothing in the repo imports the root file, so it is orphaned in the live tree — but it is not a stale duplicate of the orchestrator copy; deleting it would lose a divergent implementation.
- **Stale canon reference**: `package.json` → `"pi".extensions[]` lists `"extensions/scope-guard.ts"` (line 10), yet the live tree loads no root scope-guard. The manifest reference is orphaned relative to the live install.

## Test gap

`token-saver.test.ts` and `vitest.config.ts` are canon-only. The extension actually loads from `~/.pi/agent/extensions/`, which contains **neither file** — so the token-saver tests cannot be run (and are not run) where the extension executes. They only run from the canon clone, against synced code; a regression introduced by live-only edits stays invisible until the next sync.

## `fe6dc41` — empty commit, superseded subject

`fe6dc41` ("chore: drop stale .bak and orphaned scope-guard copy; annotate drift report", 2026-09-20) is an **empty commit**: `git diff-tree --no-commit-id --name-only -r fe6dc41` returns 0 files. Its subject is inaccurate — no `.bak` was tracked (untracked + ignored, nothing to commit) and the root `scope-guard.ts` **was kept**, not dropped. This file supersedes that subject's claims. History is not rewritten.
