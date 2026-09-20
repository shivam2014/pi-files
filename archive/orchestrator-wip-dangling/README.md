# Archival: legacy dev-copy orchestrator lineage + dangling 2026-08-02 WIP

> **Archival only. This is NOT part of `extensions/orchestrator/` and must never be merged into the code tree. It preserves a legacy dev-copy lineage (re-init of 2026-07-18) that canonical history does not contain.**

## What this is

A durable, out-of-code-path preservation of the **8-commit re-init "dev copy"**
of the orchestrator extension and its **dangling (`e3a76a3`) 2026-08-02 WIP
commit**. The canonical system of record is `/Users/shivam94/pi-files`
(232 commits, remote `github.com/shivam2014/pi-files`). This dev copy is a
separate re-initialisation born 2026-07-18 (initial commit `1a08d89`) whose
lineage **shares zero SHAs with canon** — it is a parallel history, not a
branch of canon.

Two byte-identical copies of that dev copy existed:

- live: `/Users/shivam94/.pi/agent/extensions/orchestrator` (no remote)
- duplicate: `~/pi-files/extensions/orchestrator/.git` (same HEAD `7ebb02e`,
  same SHA-list md5, same dangling object)

The dangling commit `e3a76a3` was unreferenced, unprotected and GC-eligible in
both copies and existed nowhere in canon. This archive makes its bytes
permanent without ever placing them on the code path.

## Capture metadata

- **Captured:** 2026-09-20
- **Source (live) repo:** `/Users/shivam94/.pi/agent/extensions/orchestrator`
- **Archive tag created in live repo:** `archive/2026-08-02-wip` -> `e3a76a3`
  (makes the commit reachable so the bundle includes it)
- **md5 of the live SHA list (main, 8 commits):** `d12726b1f0bceaa0d9869c135a501a91`
  (`git rev-list main | md5`)
- **Bundle:** `live-lineage-8commits.bundle` — 726,034 bytes, md5 `f3d46d540d92989e51dc176d967a5ff7`
- **Human diff:** `wip-2026-08-02.diff` (8c59e8d..e3a76a3) — 83,355 bytes, md5 `509956a1d19f73bcef04c9d9c7518d1b`

### The 8 dev-copy commits (main)

| # | SHA | Date | Subject |
|---|-----|------|---------|
| 1 | `1a08d89ade4216e66bb1f3a6c86bd5345ae69f38` | 2026-07-18 22:33:22 +0200 | feat(orchestrator): structured error propagation from subagent delegation |
| 2 | `eee4bf6e7e240179269491e0f7c7572d2b4edc50` | 2026-07-20 14:53:15 +0200 | feat(orchestrator): live token streaming + token/elapsed in delegation results |
| 3 | `90d9fa7841298de4a6965d05c262872a901a35e1` | 2026-07-20 22:23:32 +0200 | fix(orchestrator): live token breakdown from correct SDK events |
| 4 | `8c59e8d3f7190e3b9666c3e523116dc7369ec51c` | 2026-07-23 19:26:37 +0200 | feat(orchestrator): add loop engine v2 foundation |
| 5 | `a1a30c281554a97542e3912be462069d6cd3f8ee` | 2026-09-19 15:38:02 +0530 | checkpoint: shared WIP baseline (3 concurrent sessions) |
| 6 | `8baf2702c76ff92b80eb206ce26083dcb0cb0da0` | 2026-09-19 15:43:27 +0530 | chore: add .gitignore for runtime artifacts (diagnostics/, node_modules/, plan state) |
| 7 | `fb9878c93332726c7b7303e89b8df9f148493679` | 2026-09-19 23:44:21 +0530 | fix(orchestrator): scope guard fail-closed + per-delegation scope resolution |
| 8 | `7ebb02e407bb06cea44da9a5eb483fefa48a16fa` | 2026-09-20 02:02:47 +0530 | fix(orchestrator): scope guard resolves delegation cwd; no shared-file fallback for subagents |

HEAD of the dev copy = `7ebb02e4...` (#8). It has **no remote**.

### The dangling commit `e3a76a3`

- **Full SHA:** `e3a76a321b2308a7de7012a494346514760f074e`
- **Date:** 2026-08-02 10:43:47 +0200
- **Subject:** `WIP on main: 8c59e8d feat(orchestrator): add loop engine v2 foundation`
- **Parents:** `8c59e8d3f7190e3b9666c3e523116dc7369ec51c` (base) and
  `81d770e2c261248e7fd1b9ac726acd2af2a51e04` (`index on main: 8c59e8d ...`)
- **Tree:** `cccafc3721a48ed873c1891b883df10894804adf`
- **Nature:** a `git stash` merge commit (WIP work-tree + index parents). It was
  dangling/unreferenced/protected by nothing in both copies.

## Part 1 classification — `e3a76a3` is real-but-superseded WIP, no artifacts

`e3a76a3` changes 8 files, **all `.ts` source** (681 insertions / 291 deletions
vs `8c59e8d`). Per-file classification against canon:

| File | Class | Note |
|------|-------|------|
| `loop-engine.ts` | **(i) present** | byte-identical to canon HEAD (blob `684d531d`) |
| `delegate-pipeline.ts` | **(ii) superseded** | this exact blob landed in canon at `c73684a` (2026-08-02 10:54) then evolved; canon HEAD differs |
| `delegate-tool.ts` | **(ii) superseded** | same — landed in canon `c73684a`, later replaced |
| `prompt-builder.ts` | **(ii) superseded** | same — landed in canon `c73684a`, later replaced |
| `prompt-builder.test.ts` | **(ii) superseded** | same — landed in canon `c73684a`, later replaced |
| `subagent-runner.ts` | **(ii) superseded** | same — landed in canon `c73684a`, later replaced |
| `types.ts` | **(ii) superseded** | same — landed in canon `c73684a`, later replaced |
| `delegate-controller.test.ts` | **(ii) superseded** | exact blob not in canon objects, but canon HEAD is a strict superset (only 1 line differs; every added symbol also present in canon) |

- **(iii) genuinely absent from canon:** none.
- **(iv) runtime/generated artifacts (plan state, diagnostics, logs, `.pi/`, caches, snapshots-as-output):** **none** — every changed path is hand-written `.ts` source.

**Verdict:** `e3a76a3` is a **mix of real work that is now obsolete**:
genuine development WIP (a stash) whose content was **already landed into canon**
by the later same-day commit `c73684a` and then **evolved past** there. It
contains **no unique content** and **no legacy artifacts**. Therefore nothing in
it may re-enter the code tree as new content; it is preserved for provenance
only.

## How to use this archive

```bash
# Inspect the lineage without touching any code path:
git clone archive/orchestrator-wip-dangling/live-lineage-8commits.bundle /tmp/inspect
git -C /tmp/inspect log --oneline --all          # 8 main commits + tags
git -C /tmp/inspect cat-file -t e3a76a3          # -> commit
git -C /tmp/inspect show e3a76a3                 # the WIP

# Human-readable diff:
less archive/orchestrator-wip-dangling/wip-2026-08-02.diff
```

**Do not** copy anything from this bundle into `extensions/orchestrator/`.
**Do not** merge, rebase, or cherry-pick this lineage into canon.
