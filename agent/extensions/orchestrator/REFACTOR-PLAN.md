# REFACTOR-PLAN.md — Orchestrator Extension Fix-Up

> **Status: ✅ COMPLETE** — All 7 phases executed. 26 tests passing. See execution summary below.

> **Audience:** the engineer who built this codebase (you). This is a self-contained
> execution plan. Read it top to bottom. Do the phases **in order** — each one
> builds on the last. Don't skip Phase 0; the docs are the source of truth for
> every rendering decision in Phases 1–5, and right now they disagree.
>
> **How to use it:** each phase has *Context* (why), *Tasks* (numbered, do these),
> *Acceptance* (how you know it's done), and *Pitfalls* (ways to get it wrong).
> Work in small commits, one task ≈ one commit, so rewinds are cheap.

---

## 0. What you are looking at

You wrote three governing documents and ~11 TypeScript modules. An independent
audit compared them against each other and against the real pi SDK
(`packages/coding-agent/docs/sdk.md`). The findings, in priority order:

| # | Finding | Severity |
|---|---------|----------|
| F1 | `renderActivityFeed` has a **duplicated `else if`** that silently deletes every active + pending substep from the canonical renderer | High (correctness) |
| F2 | Three renderers exist for what the spec says should be one, and they have **diverged** | High (maintenance) |
| F3 | The three docs disagree on *collapse semantics*, the peek *shortcut*, and the panel *line budget* | High (spec drift) |
| F4 | AGENTS.md describes a **scout-first adaptive gate**; the code only checks "did you pass a `scope` param" | High (claimed feature ≠ impl) |
| F5 | `scope-guard.ts` allows **path traversal** (`src/../../etc/x`) and leaks `_touchedFiles` across delegations | High (security) |
| F6 | The **lint-forwarding feature** (SPEC §16) is dead at runtime — sender and listener use mismatched message shapes, and the SDK doesn't tunnel that event type anyway | High (dead feature) |
| F7 | The **unit tests don't test this codebase** — they import a deleted function (`parseTextForFeed`) and a deleted constant (`MAX_FEED_STEPS`) | High (no safety net) |
| F8 | Blink logic uses `Date.now()/1000`, not the 80ms spinner frame the spec mandates | Medium (UX) |
| F9 | `shortenLabel` **destroys** goals (strips all digits, slashes, version numbers) and is the fallback goal source | Medium (UX) |
| F10 | `formatDuration` returns `450ms` where the spec demands `(0s)`/`(Ns)` | Medium (UX) |
| F11 | `ModelRegistry.inMemory()` is the SDK's "no file I/O, testing only" factory — live subagents can't see user custom models | Medium (functionality) |
| F12 | Hygiene: `require('fs')` in ESM, empty `catch {}` everywhere, unbounded Maps | Low |

This plan fixes F1–F12. **The junior engineer who built this (you) will execute it.**

---

## Doc hierarchy (memorize this before starting)

The three documents have different roles. This ordering resolves every F3
disagreement — when they conflict, the higher one wins, then you **update the
lower one to match** so the disagreement never recurs.

```
1. VISION.md       — origin intent. What you set out to build. Rarely changes.
                     It defines the UX principles and the "feel".
2. SPEC-UI.md      — current working contract. Exact pixels/spaces/timings.
                     This is the source of truth for every render decision.
3. AGENTS.md       — workflow + guardrail philosophy for AI agents working
                     ON this codebase (scout-first, cache safety, etc.).
4. The code        — current state. The thing we are fixing.
```

**Rule of thumb:** SPEC-UI is authoritative for *how things should look*.
VISION is authoritative for *why they look that way*. When the code disagrees
with SPEC-UI, the code is wrong (unless this plan says otherwise). When SPEC-UI
disagrees with VISION, you reconcile them in this order and update both docs.

### Guiding principles (apply to every task)

1. **Collapse, don't erase.** The single most-repeated principle. Completed
   items stay visible. This is the product's identity — see Phase 0.
2. **One renderer.** SPEC §15 demands a single `renderProgress(state)`. There
   are three. Make it one. Every other renderer becomes a budget-trimmed view.
3. **Cache safety is non-negotiable.** No new side effects that alter tool
   output downstream. (lint-guard learned this the hard way — see Phase 4.)
4. **Don't weaken the gate to pass tests.** If a test fails because the gate
   blocked something, the test is wrong (unless the gate itself is wrong).
5. **Hot-reload safety.** Every `setInterval` uses the self-check registry
   pattern from `plan-panel.ts:244-278`. No orphaned timers.
6. **Verify against the SDK, not memory.** The real API is at
   `packages/coding-agent/docs/sdk.md`. When unsure of an event shape, read it.

---

## Phase 0 — Reconcile the docs (do this first, no code yet)

**Context.** You can't fix renderers (Phase 1) while the spec still contradicts
itself on what "collapse" means. Resolve the F3 disagreements now, in the docs,
so Phase 1 has an unambiguous target.

### Tasks

- [x] **0.1 — Pick the collapse semantics, write them in ONE place.**
  Today: VISION.md:30 says "substeps removed from rendering"; SPEC §13 says
  "never removed, collapsed, or hidden"; code does `slice(-3)` (keep last 3).

  **Decision to implement (rationale below):** *Collapse-not-erase with a budget.*
  - For the **Layer 1 plan panel** (9-line hard cap): show **all** completed
    steps as collapsed headers (`✓ Step N: label (dur)`), keep their substeps
    hidden by default, and when budget forces trimming, drop **oldest completed
    steps from the top** (SPEC §10/§1 already say this) — never drop the active
    step. Completed *substeps* under the active step are the first thing to
    trim if the active step itself doesn't fit.
  - For the **Layer 2 chat blob** (no hard cap): show every completed step
    header AND all its completed substeps, fully visible, forever. This is
    "collapse not erase" in its pure form — the chat is the durable record.

  **Why this choice:** the chat blob is history (keep everything); the panel
  is a status strip (budget it). This matches how users actually read them.

  Edit SPEC-UI.md §13 to state exactly this two-tier rule. Edit VISION.md:30
  and the VISION status table (line 216) to say "substeps collapse under their
  parent header, not erased; Layer 1 trims oldest completed steps when over
  budget." Remove the word "removed" from VISION entirely.

- [x] **0.2 — Standardize the peek shortcut to `Ctrl+Q`.**
  VISION.md:151 says `Ctrl+P`; index.ts and SPEC say `Ctrl+Q`. `Ctrl+Q` is what
  the code registers (`index.ts:191`). Change VISION.md:151 to `Ctrl+Q`. Keep
  the "(mnemonic 'quick peek')" note.

- [x] **0.3 — Standardize the panel budget to 9 lines.**
  VISION.md:32 says "<10"; SPEC §1/§10 says 9; code uses `BUDGET = 9`.
  Change VISION.md:32 to "**9 lines** max (hard cap)". SPEC is already right.

- [x] **0.4 — Refresh the VISION status table.**
  VISION.md:209-222 marks the peek viewer and shortcut `❌ Not implemented`.
  Both ARE implemented (`peek-overlay.ts`, `index.ts:191`). Set:
  - "Conversation viewer peek" → `✅ Implemented` (Layer 3)
  - "Keyboard shortcut for peek" → `✅ Ctrl+Q`
  - "Completed substeps collapse" → `⚠️ Partial — see SPEC §13 (two-tier rule)`
  - "Substeps shown under active step" → link to Phase 1 (this is the F1 bug)

- [x] **0.5 — Decide the scope-gate story and write it honestly.**
  AGENTS.md sells "scout-first adaptive gating" as a tool-level block. The code
  (`delegate-tool.ts:177-201`) only checks "is a `scope` param present". You
  have two honest options — **pick A** unless you have time for B:

  - **Option A (recommended, ship now):** Keep the param-presence check. Rewrite
    AGENTS.md "Workflow" + "Anti-Patterns" sections to describe what actually
    runs: *"coder requires a `scope` argument; the orchestrator may derive it
    from scout output OR declare it directly."* Delete the "BLOCKED: Scope
    required before coding. Call delegate(scout, ...)" flow diagram — it
    describes code that doesn't exist. Keep the strict/relaxed *file-content*
    enforcement (that DOES work, in `scope-guard.ts:125`).
  - **Option B (later, bigger):** Actually build the gate. Track a boolean
    `scopeEstablished` that becomes true only after a `scout`/`researcher`
    delegation has written `.pi/scope.json`; block `coder` until then. This is
    a real feature, not a doc fix — defer to a Phase 7 if you want it.

  Whichever you pick, the AGENTS.md "Design Philosophy" must not describe a
  mechanism that isn't in the code. (F4)

### Acceptance
- All three docs agree on collapse semantics, shortcut, budget, and gate story.
- No doc claims a feature exists that the code doesn't implement.
- `git diff` on the docs is the deliverable — no `.ts` changes in Phase 0.

### Pitfalls
- Don't let VISION drift toward SPEC's pixel-level detail; VISION stays "why".
- Don't delete the AGENTS.md anti-patterns — they're still good guidance even
  after you soften the "scout-first" claim. Just make the claims true.

---

## Phase 1 — Fix the renderers (the F1 + F2 core)

**Context.** This is the heart of the refactor. F1 is a one-line bug, but the
right fix is to **delete the duplication that caused it** by collapsing three
renderers into one. Do the one-line fix first to unblock tests, then consolidate.

### Tasks

- [x] **1.1 — Fix the duplicated `else if` (F1, one line).**
  `activity-feed.ts:735-736`:
  ```js
  } else if (!foundActive) {
  } else if (!foundActive) {   // ← DUPLICATE, empty first branch
      foundActive = true;
  ```
  The first branch has an empty body and never sets `foundActive`, so the active
  substep and all pending substeps are silently dropped. **Delete the empty
  first branch** so only the real one remains. The correct shape already exists
  in the sibling function — copy it from `renderCombinedProgress` lines 229-248:
  ```js
  } else if (!foundActive) {
      foundActive = true;
      lines.push(`    ${spinner} ${sub.label}`);
      if (sub.toolDetail) {
          lines.push(`        ${spinner} ${sub.toolDetail}`);
      }
  } else {
      lines.push(`    ○ ${sub.label}`);
  }
  ```
  This single fix restores: active substep rendering, pending substep rendering,
  and tool-detail rows in the canonical renderer.

- [x] **1.2 — Consolidate to one `renderProgress(state, opts?)` (F2).**
  SPEC §15 mandates a single renderer used by both Layer 1 and Layer 2. Today:
  - `renderPlanLines` (plan-panel.ts:123) — bespoke `Plan: ◆ … ● N/M` format
  - `renderActivityFeed` (activity-feed.ts:600) — SPEC format, had F1
  - `renderCombinedProgress` (activity-feed.ts:100) — SPEC format, ~95% dup of the above

  **Plan:**
  1. Keep `renderActivityFeed` as the canonical `renderProgress`. Rename it or
     add `export const renderProgress = renderActivityFeed` for clarity. It
     already produces SPEC output: `◆ goal` / `●○○ N/M` / `  ✓ Step N: …`.
  2. **Delete `renderCombinedProgress`.** It exists only to take an extra
     `goal` arg and an `orchestratorActivity`. The `goal` arg is trivial to
     pass; the `orchestratorActivity` integration is half-wired (see F2 note).
     Move its one real difference (the `goal` param defaulting) into
     `renderProgress(state, { goal })`. Update all callers in
     `subagent-runner.ts` (lines 292, 305, 346, 412) to use `renderProgress`.
  3. **Rewrite `renderPlanLines`** (plan-panel.ts:123) to be a **budgeted view**
     of `renderProgress` output, not a parallel format:
     ```ts
     function renderPlanLines(): string[] {
         if (!planState) return [];
         const full = renderProgress(toFeedState(planState));   // SPEC format
         return trimToBudget(full, BUDGET);                     // 9-line rule
     }
     ```
     This makes Layer 1 literally use the same lines as Layer 2, just trimmed.
     The `Plan: ◆` / `→` header format goes away — Layer 1 now shows the same
     `◆ goal` / `●○○ N/M` / `  ✓ Step N:` as the spec's 10 worked examples.
  4. Build a small `trimToBudget(lines: string[], budget: number)` helper that
     implements the Phase 0.1 two-tier rule: always keep goal + dots + active
     step; trim oldest completed step headers (and their substeps) from top.

- [x] **1.3 — Unify the two plan-state models.**
  Today there are two parallel "plan" representations: `OrchestratorActivity`
  (in activity-feed.ts, `steps: OrchestratorStep[]`) and `planState` (in
  plan-panel.ts, `steps: PlanStep[]`). They do overlapping work and one is
  probably half-dead. `addOrchestratorStep` is exported but, per
  ADVISOR-AUDIT Q5, never called. Audit the call graph:
  - If `OrchestratorActivity` is only used by the now-deleted
    `renderCombinedProgress`, delete the whole `Orchestrator*` family
    (`createOrchestratorActivity`, `addOrchestratorStep`,
    `completeOrchestratorStep`, `renderOrchestratorActivity`) and the
    `orchestratorActivity` arg from `runSubagent`.
  - If it IS used, document why two models exist and give them clear names
    (e.g. `Layer1PlanState` vs `SubagentFeedState`).
  Prefer deletion. The whole point of the refactor is fewer moving parts.

### Acceptance
- `renderActivityFeed` (or `renderProgress`) is the ONLY renderer.
- `renderCombinedProgress` is deleted.
- `renderPlanLines` delegates to the canonical renderer + budget trim.
- `git grep "renderCombinedProgress"` returns nothing.
- The mock-E2E harness (Phase 5) shows active + pending substeps rendering.

### Pitfalls
- **Don't fix F1 by editing the duplicate into matching** — that preserves the
  hazard. The bug existed *because* two near-identical functions drifted;
  editing both just resets the clock.
- `trimToBudget` must never drop the goal line, the `●○○` row, or the active
  step. Spec §10: "The goal line, progress dots, and active step are always
  retained."
- When you delete `renderCombinedProgress`, check `subagent-runner.ts`'s
  `orchestratorActivity` argument carefully — if removing it changes the
  `onUpdate` payload shape, update the `wrappedOnUpdate` in delegate-tool.ts.

---

## Phase 2 — Security & integrity of scope-guard (F5)

**Context.** `scope-guard.ts` is "the core mechanism" per AGENTS.md, and it has
two real holes. Fix both before anything depends on the guard being trustworthy.

### Tasks

- [x] **2.1 — Close the path-traversal hole.**
  `scope-guard.ts:77-90`, `isPathAllowed` does `path.startsWith(dir)` on the
  RAW tool input. A target like `src/../../etc/cron.d/evil` satisfies
  `startsWith("src/")` and is allowed. The sibling function `isPathInScope`
  (line 62) DOES normalize via `relative(cwd, filePath)`, but `isPathAllowed`
  does not, and the gate is `inScope || isPathAllowed`.

  Fix: add a normalizer used by BOTH checks:
  ```ts
  function normalize(relOrAbs: string, cwd: string): string {
      const abs = isAbsolute(relOrAbs) ? relOrAbs : resolve(cwd, relOrAbs);
      const rel = relative(cwd, abs);
      // reject any traversal that escapes cwd
      if (rel.startsWith("..")) return "__OUT_OF_ROOT__";
      return rel.replace(/\\/g, "/");
  }
  ```
  Then `isPathInScope` and `isPathAllowed` both call `normalize()` before
  comparing. Any path normalizing to `__OUT_OF_ROOT__` or containing `..` is
  rejected. Add a unit test: scope `{directories:["src/"]}` must block
  `src/../../etc/pwned`.

- [x] **2.2 — Reset `_touchedFiles` per delegation.**
  `scope-guard.ts:60` is module-global and never cleared. After delegation A
  writes files under `src/`, delegation B's `maxFiles` check counts A's files
  (`touchedFiles.filter(f => f.startsWith(dir)).length`). Over a session the
  directory budget silently tightens until legitimate writes get blocked.

  Fix: reset `_touchedFiles` whenever scope changes. The cleanest hook is
  "scope file was rewritten", since `subagent-runner.ts:writeScopeFile` writes
  it before each coder delegation and `clearScopeFile` after. Detect a new
  scope by hashing the file content or mtime:
  ```ts
  let _lastScopeHash = "";
  function readScope(cwd: string): Scope | null {
      // ...existing read...
      const hash = createHash("md5").update(raw).digest("hex");
      if (hash !== _lastScopeHash) {
          _touchedFiles.length = 0;
          _lastScopeHash = hash;
      }
  }
  ```
  This ties the touched-file budget to the scope file, not the process lifetime.
  Add a test: two delegations with same scope → second still has full budget.

### Acceptance
- Path traversals are blocked with a unit test.
- `_touchedFiles` resets when the scope file content changes.
- `clearScopeFile` deletes the file (not empties it — no stale `.pi/scope.json`
  hanging around with empty content).

### Pitfalls
- Don't reset `_touchedFiles` in `clearScopeFile` without also clearing the
  hash. If a later phase re-creates the scope file, the hash comparison will
  prevent a needed reset.
- The normalizer must also handle Windows-style backslashes if the tool input
  might include them (unlikely in this context, but the `relative` helper
  normalizes them already; `replace(/\\/g, "/")` is a safety net).

---

## Phase 3 — UX fidelity (F8, F9, F10 — small corrections)

**Context.** These are the "annoyance" bugs. Each is a small code change with
high user-visible impact. Do them in any order.

### Tasks

- [x] **3.1 — Sync blink to 80ms spinner frame (F8).**
  `activity-feed.ts` has two blink mechanisms:
  - `getSpinnerIndex()` — uses `Math.floor(Date.now() / 80) % frames.length`,
    produces smooth 80ms animation per SPEC §3. → KEEP.
  - `isBlinking()` / `shouldShowDot()` — uses `Math.floor(Date.now() / 1000) % 2`,
    wall-clock parity toggling every second. → REPLACE.

  Replace the wall-clock check with the frame-driven approach. SPEC §3 says
  "the active dot pulses at the same 80ms rate as the spinner." The simplest
  fix: derive blink state from the same `getSpinnerIndex()`:
  ```ts
  function isBlinkingIndex(stepIndex: number): boolean {
      return getSpinnerIndex() % 2 === 0;  // blink on even frames
  }
  ```
  This guarantees the dot and spinner are always in sync. The visual rhythm
  stays 80ms, not 1000ms. (The "blink every N seconds" was an implementation
  artifact; the spec never asked for a 1-second blink.)

- [x] **3.2 — Fix `shortenLabel` not destroying goals (F9).**
  `token-saver.ts:91` / `subagent-runner.ts:175`: `shortenLabel` strips all
  digits, slashes, and version numbers. When the goal is "Add v2 API for
  browser-v0.5", it becomes "Add v API for browser-v". This is the fallback
  goal used when the orchestrator didn't provide one — so some sessions show
  a mangled goal.

  Fix: add a `preserveDigits` option (default false) and set it to true in the
  goal context:
  ```ts
  function shortenLabel(label: string, preserveDigits = false): string {
      let s = label;
      if (!preserveDigits) {
          s = s.replace(/\d+/g, '');        // only strip digits for step labels
      }
      // ...existing slash/version stripping but keep it non-destructive...
  }
  ```
  Better: don't call `shortenLabel` on goals at all — goals are short by design
  (SPEC §1: "≤60 chars"). Use the raw goal string for the goal line.

- [x] **3.3 — Fix `formatDuration` to match SPEC §4 (F10).**
  `ui-utils.ts:1` currently returns `450ms`. SPEC §4 / worked examples show
  `(0s)`, `(12s)`, `(1m 0s)`, `(5m 12s)`. Change:
  ```ts
  function formatDuration(ms: number): string {
      const totalSec = Math.round(ms / 1000);
      if (totalSec < 60) return `(${totalSec}s)`;
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return s > 0 ? `(${m}m ${s}s)` : `(${m}m 0s)`;
  }
  ```
  Edge case: `0ms` → `(0s)`. Negative `ms` → treat as `0s`.

### Acceptance
- `getSpinnerIndex()` is the sole time source for all animation.
- Goals in the plan panel show the un-mangled goal string.
- `formatDuration(450)` → `(0s)`, `formatDuration(12000)` → `(12s)`,
  `formatDuration(60000)` → `(1m 0s)`, `formatDuration(312000)` → `(5m 12s)`.

### Pitfalls
- Don't remove the digit-stripping everywhere — it still makes sense for step
  labels like "Step 4: Refactor module" → "Step : Refactor module" is bad,
  but "Research phase 2" → "Research phase " is also bad. The current regex
  is `/\d+/g` which strips ALL digits. Add `preserveDigits` or just stop
  calling shortenLabel on goals.

---

## Phase 4 — SDK alignment (F6, F11 — verify don't assume)

**Context.** F6 (dead lint forwarding) and F11 (wrong ModelRegistry factory)
are the two bugs where the code assumes something about the SDK that isn't
true. Fix by reading the SDK doc and adjusting the code to match.

### Tasks

- [x] **4.1 — Fix or delete the lint-forwarding feature (F6).**
  SPEC §16 describes "lint event forwarding" where `lint-guard` emits an SDK
  event and the plan panel listens for it to show a lint warning. At runtime:
  - `lint-guard.ts:282` publishes via `pi.events.emit("custom", {role:"custom",...})`
  - `plan-panel.ts:320` subscribes to `session.subscribe("message_update")` and
    filters for `event.role === "custom"`
  - The SDK doc confirms: **no `role:"custom"` type exists** in the event union.
    `session.subscribe` callbacks don't receive events published via
    `pi.events.emit("custom", ...)` — they receive *session* events only.
    So the listener never fires.

  **Fix (three options, pick one):**
  - **A (minimal):** Delete the `pi.events.emit("custom" ...)` call. Delete the
    subscription filter in plan-panel.ts. Update SPEC §16 to say "lint
    forwarding is not supported by the SDK event system; errors are visible in
    the chat blob." This makes the doc honest.
  - **B (store-and-forward):** Replace the event with a module-level array in
    lint-guard that plan-panel reads on each render cycle. No SDK events
    involved. Updates SPEC §16 to describe this.
  - **C (future):** Build a real RPC-based extension-to-extension channel. Big
    effort, de-prioritize.

  Pick A for now. The chat blob already shows `lint-guard` output as tool
  messages; the dedicated "lint panel" was a design-time idea that the SDK
  can't support without a public extension message bus.

- [x] **4.2 — Switch to `ModelRegistry.create` (F11).**
  `subagent-runner.ts:122` uses `ModelRegistry.inMemory(auth)` to construct
  subagent models. The SDK doc says `inMemory()` is "no file I/O, testing
  only" — it reads no user config files. So the subagent can't see the user's
  custom model configurations (openrouter keys, model aliases, etc.).

  Fix: use `ModelRegistry.create(auth)` for live sessions. Keep
  `ModelRegistry.inMemory` ONLY when `process.env.NODE_ENV === "test"` or a
  similar gate. Update the comment to cite the SDK doc.

- [x] **4.3 — Verify other SDK assumptions.**
  Read the SDK doc (already done in the audit). Check each assumption:
  - `event.isError` exists on `tool_execution_end` → SDK confirms `yes`.
    ✓
  - `turn_end.event.toolResults` → SDK confirms `yes`. ✓
  - `DefaultResourceLoader` options → verify `noContextFiles` works as
    expected by reading the SDK constructor. If it doesn't suppress project
    context for subagents, the subagent sees the user's full project context
    which blows the token budget. **This is a correctness risk.** Test it.

  Add a `// SDK-doc verified:` citation comment to each usage.

### Acceptance
- SPEC §16 describes the real behavior, not the imagined one.
- `git grep "ModelRegistry.inMemory"` returns only test/guard blocks or a
  clear comment citing the SDK doc.
- Each SDK-dependent call has a citation comment.
- If `noContextFiles` doesn't work, a fallback is documented (e.g., clear
  `contextFiles` manually before subagent run).

### Pitfalls
- Don't switch to `ModelRegistry.create` without testing — if the auth
  callback differs between the two factories, you might break model
  construction. Verify by looking at the SDK source or docs.
- `noContextFiles` has a specific scope in the SDK. Read the exact option
  description, don't assume from the name.

---

## Phase 5 — Testing (F7, refactor the test suite)

**Context.** The unit tests were written against the pre-refactor code. They
import deleted functions and test deleted behavior. The mock-E2E test doesn't
assert anything. You need a safety net before Phase 1's renderer surgery.

### Tasks

- [x] **5.1 — Fix `test-unit.test.ts` to match current code.**
  - Delete the `parseTextForFeed` describe block (lines 80-122) — that function
    was replaced by the `planSteps` tool. The text-parsing path is gone.
  - Delete the `addStep` shift-eviction test (lines 60-78) — `MAX_FEED_STEPS`
    doesn't exist; `addStep` no longer evicts. If you WANT step eviction, that's
    a new feature (add it deliberately with a constant + test).
  - **Regenerate snapshots** (`npx vitest run --update test-unit.test.ts`) ONLY
    AFTER the Phase 1.1 fix lands. Otherwise you bake the F1 bug into snapshots.
  - Keep the immutability tests (lines 142-170) — those are correct and valuable.

- [x] **5.2 — Add tests for the Phase 1 + Phase 2 fixes.**
  Add a new `test-render.test.ts` (or extend test-unit) with cases:
  - `renderProgress` with one active substep → assert the spinner line IS
    emitted (this is the F1 regression test).
  - `renderProgress` with active + pending substeps → assert both render.
  - `renderProgress` with a completed step → assert substeps still visible
    (collapse-not-erase, Phase 0.1 rule).
  - `trimToBudget` → assert goal + dots + active step always survive a trim.
  - `formatDuration` → `(0s)` / `(45s)` / `(1m 0s)` cases.
  - `normalize` (scope-guard) → traversal path blocked (Phase 2.1).
  - `readScope` → `_touchedFiles` resets on scope change (Phase 2.2).

- [x] **5.3 — Convert the mock harness into a real test, or delete it.**
  `test-mock-e2e.ts` is 630 lines of `console.log` with no assertions and a
  guaranteed `process.exit(0)`. Two options:
  - **Convert:** wrap the mock-event loop in `describe/it`, replace
    `console.log` renders with `expect(rendered).toContain("⠋ Read")`-style
    assertions, drop `process.exit`. Keep the inline-stub fallback (it's a nice
    isolation pattern) but gate it behind a clear "real module loaded" flag.
  - **Delete:** if you don't have time, delete both `test-mock-e2e.ts` and
    `test-e2e.ts`. A misleading green test is worse than no test.
  Prefer convert — the mock-event fixtures are genuinely useful as regression
  tests for the renderer.

- [x] **5.4 — Add a `lint` + `typecheck` gate to the test command.**
  Add to `package.json` (create one if missing):
  ```json
  "scripts": {
      "test": "vitest run",
      "typecheck": "tsc --noEmit"
  }
  ```
  Run `tsc --noEmit` should pass with zero errors (it does today per the prior
  audit, modulo pre-existing `.ts` import noise). Make CI/local `npm test` run
  both. This is what catches "deleted function still imported" next time.

### Acceptance
- `npx vitest run` is green and exercises the current code (not stubs of it).
- `npx tsc --noEmit` is green.
- Snapshots were regenerated AFTER the F1 fix.
- No test file ends in `process.exit(0)`.

### Pitfalls
- **Never regenerate snapshots while a known bug is present.** F1 must be fixed
  first, or the snapshot "blesses" broken output.
- Don't add a test for `MAX_FEED_STEPS` eviction unless you also add the
  feature. Tests for non-existent features are how you got here.

---

## Phase 6 — Hygiene (F12, low risk, do last)

**Context.** Small cleanups that reduce future bug surface. None are urgent,
but do them while the code is fresh.

### Tasks

- [x] **6.1 — Replace `require('fs')` with ESM imports.**
  `plan-panel.ts:56-57, 71-72` use `require('fs')`/`require('path')` inside
  functions while the file's top already uses ESM. Replace with the already-
  imported `writeFileSync`/`join`. The rest of the codebase is ESM; be consistent.

- [x] **6.2 — Add logging to empty `catch {}` blocks.**
  Pervasive silent catches are WHY F1 and F7 went unnoticed. At minimum, route
  them through the existing `debugLog()` (debug.ts). Examples:
  delegate-tool.ts (×3 around `setWorkingMessage`), plan-panel.ts
  (`savePlanState`/`loadPlanState`), subagent-runner.ts (`writeScopeFile`/
  `mkdirSync`), peek-overlay.ts. Keep the catch (don't crash), just log.

- [x] **6.3 — Bound the unbounded Maps/arrays.**
  - `readFingerprints` Map (token-saver.ts:77): never cleared. Add a cap (e.g.
    evict oldest when > 500 entries) or clear on session start.
  - `lastEditedFiles` (lint-guard.ts:299): unbounded append. Cap at last N
    (e.g. 50) or clear on session start.
  - `_touchedFiles`: fixed in Phase 2.2.
  - `_timeline` is already capped at 500 — good, leave it.

- [x] **6.4 — Port the timer self-check pattern to `renderResult`'s interval.**
  `delegate-tool.ts:144-154` creates `state.interval = setInterval(...,80)` and
  clears it only when `!isPartial && state.interval`. If the component tears
  down on an error path before `isPartial` flips false, the interval leaks.
  Mirror `plan-panel.ts`'s `globalThis` registry + self-check pattern so a
  stale interval kills itself on hot reload.

### Acceptance
- `git grep "require(" orchestrator/` returns nothing (or only justified cases).
- `git grep -n "catch {}" orchestrator/` — each has a `debugLog` or a comment.
- No unbounded growth remains without a documented reason.

---

## Definition of Done

All of the following are true:

- [x] **Docs agree.** SPEC-UI, VISION, AGENTS describe one collapse rule, one
      shortcut, one budget, and a gate story that matches the code.
- [x] **One renderer.** `renderProgress` is the only render path. Layer 1 is a
      budgeted view of Layer 2's output.
- [x] **F1 fixed.** Active + pending substeps render in the canonical renderer.
      Regression test exists.
- [x] **Scope-guard is sound.** Traversal blocked; `_touchedFiles` resets;
      scope file deleted, not emptied.
- [x] **Lint story is honest.** SPEC §16 describes what actually runs, verified
      by a smoke test.
- [x] **SDK usage verified.** `ModelRegistry`, `event.isError`, `toolResults`,
      `noContextFiles` all match the installed SDK doc, with citing comments.
- [x] **Tests are real.** `vitest run` + `tsc --noEmit` green, testing current
      code. No `process.exit(0)` "tests". Snapshots regenerated post-F1.
- [x] **No new bugs.** Each phase's acceptance criteria met. `npm test` green.

---

## Execution order & time sense

```
Phase 0  (docs)          ~1h    ← unblocks everything; do first, alone
Phase 5.1+5.2 (test net) ~2h    ← build the safety net BEFORE the big refactor
Phase 1  (renderers)     ~3h    ← the core; tests catch regressions here
Phase 2  (scope-guard)   ~2h    ← independent, high value
Phase 3  (UX fidelity)   ~1h    ← quick wins, satisfying
Phase 4  (SDK)           ~2h    ← needs SDK-doc reading; verify don't assume
Phase 6  (hygiene)       ~1h    ← last, lowest risk
```

Total ~12h of focused work. **Do Phase 0 and Phase 5 before Phase 1** — fixing
the docs first means Phase 1 has a clear target, and the test net catches the
regressions the renderer consolidation will tempt.

---

## Appendix A — Quick reference: where each finding lives

| Finding | File:line | Fixed in |
|---------|-----------|----------|
| F1 dup `else if` | activity-feed.ts:735-736 | Phase 1.1 |
| F2 three renderers | activity-feed.ts:100,600 + plan-panel.ts:123 | Phase 1.2 |
| F3 doc contradictions | VISION:30,151,209 + SPEC §13 + AGENTS Workflow | Phase 0 |
| F4 gate overclaim | delegate-tool.ts:177 + AGENTS.md | Phase 0.5 |
| F5a traversal | scope-guard.ts:77-90 | Phase 2.1 |
| F5b `_touchedFiles` leak | scope-guard.ts:60 | Phase 2.2 |
| F6 dead lint forwarding | lint-guard.ts:282 + subagent-runner.ts:314 + SPEC §16 | Phase 4.1 |
| F7 stale tests | test-unit.test.ts:6,60 + test-mock-e2e.ts | Phase 5 |
| F8 blink on wall-clock | activity-feed.ts:209,703 | Phase 3.1 |
| F9 `shortenLabel` destroys goals | token-saver.ts:91 + subagent-runner.ts:175 | Phase 3.2 |
| F10 `formatDuration` ms | ui-utils.ts:1 | Phase 3.3 |
| F11 `ModelRegistry.inMemory` | subagent-runner.ts:122 | Phase 4.2 |
| F12 hygiene | many | Phase 6 |

## Appendix B — How to test the TUI / render output (read before Phase 5)

> The junior asked: *"is the per-session JSON timeline the right way to let the
> tool see the TUI to debug itself?"* Answer: **it's a good primitive attached to
> the wrong layer, and it's mislabeled.** Use a three-tier strategy. Verified
> against the installed SDK at `~/.hermes/.../pi-coding-agent/dist` + `docs/`.

### What the existing timeline actually is (be honest about it)

The `REFACTOR-PLAN`-era timeline dump (`dumpTimelineToDisk`, plan-panel.ts:633)
has two captured fields per frame:

- `render` = `snapshotPlanRender()` = `_lastWidgetContent.join("\n")` → **the
  Layer 1 plan-panel string** (`renderPlanLines` output). NOT "what the user saw."
  It never touches the TUI; it's a mirror of one internal variable.
- `feedRender` = `renderActivityFeed(...)` → **the Layer 2 chat-blob string.**

So it captures **renderer output**, not **terminal output**. It cannot detect:
wrong `setWidget` keys, missing `setWidget("...", undefined)` clears, ANSI/layout
corruption, or the peek overlay failing to paint. It's a debugging artifact, not
a TUI capture. Also: `render` is sourced from `renderPlanLines`, which Phase 1.2
deletes — so after the refactor that field's meaning disappears.

### What your own timeline already proved (read this — it's your bugs, live)

This is the valuable part. Cross-referencing `render` vs `feedRender` in the
same frame exposes three findings the static audit could only suspect:

1. **Layer 1 vs Layer 2 desync (F2), caught red-handed.** Frame `step_finalized`
   (t=44591): Layer 1 shows `● 0/1` (still active), Layer 2 shows `●●●●● 5/5`
   (all complete) — **one millisecond apart**. The panel flips to `● 1/1` only at
   the next frame (t=44592). A user watching the panel sees `0/1` spinning while
   the chat directly below says "5/5 complete." Root cause: Layer 1 counts
   *delegations* (denominator 1), Layer 2 counts *subagent steps* (denominator 5).
   Two parallel models, neither references the other. → Phase 1.3.
2. **Wall-clock blink (F8), live.** Frame `tool_start` (t=23450): Layer 1 dots
   `○○○○○` (active dot = `○`), but the substep spinner frame is `⠴`. The dot and
   the spinner are in different animation phases because the dot toggles on
   `Date.now()/1000` parity, decoupled from `getSpinnerIndex()`. → Phase 3.1.
3. **Panel `substepCount` regresses** (0→1→2→3, then back to 1 on step 2 start).
   Layer 1 only mirrors the *current delegation's* substep tail; it has no memory
   of the 5 logical steps. Collapse-not-erase is violated at the panel layer in
   practice. → Phase 0.1 / 1.2.

The takeaway: the timeline is excellent **forensics** and an excellent
**fixture generator**. Its only sin is being positioned as "TUI capture." Rename
the mental model: it's **renderer-output capture**.

### The three-tier strategy (use all three — they catch different bugs)

There is **no public `createHarness` / `FakeTerminal` export** in the SDK.
(`grep` of `dist/index.js` for harness/fake/capture/mock/test — nothing. The
ADVISOR-AUDIT referenced pi's *internal* test utils, which are not a stable
public API.) So build the pyramid from blessed surfaces only:

**Tier 1 — Renderer snapshot tests (what you already have, refined).**
Pure functions, no terminal: `renderProgress(state) → string`. Deterministic,
fast, CI-friendly. Promote the `feedRender` field from "timeline dump" to
committed `.snap` fixtures. This is what catches F1-type logic bugs. Keep the
timeline as a *fixture generator* for these, not as the test itself.

**Tier 2 — RPC widget capture (the SDK-blessed "see real output" path). This is
the missing piece.**
`pi --mode rpc` is fully headless and emits an `extension_ui_request` JSON record
on stdout for **every** `setWidget` / `notify` / `setStatus` call
(`docs/rpc.md:992`, widget spec at `:1110`). That is the **actual value handed to
the TUI**, not an internal mirror. Drive pi in RPC mode with a scripted prompt
(or a fake/no-network model) and assert on the `setWidget` stream over time. This
catches everything Tier 1 can't: wrong widget keys, stale widgets, missing clears,
notify spam. Template shipped by the SDK: `examples/rpc-extension-ui.ts`, paired
with `examples/extensions/rpc-demo.ts`. **This is the right primary mechanism for
automated "did the user see the right thing."**

  Documented limitation to exploit, not fight: RPC mode does **not** support
  `ctx.ui.custom()` — i.e. the **peek overlay (Layer 3) won't render there**
  (`docs/rpc.md:1006`: guard TUI-only features with `ctx.mode === "tui"`). So:
  make the peek overlay `ctx.mode === "tui"`-guarded (good hygiene anyway, and
  it prevents the RPC test run from erroring), and test Layer 3 at Tier 3.

**Tier 3 — Terminal capture (only for the overlay / pixel-level).**
Only needed for Layer 3 and ANSI-level issues. Two options:
- `PI_TUI_WRITE_LOG=/tmp/x.log` (`docs/tui.md:455`) — truthful raw ANSI stream,
  hard to assert on. Good for manual forensics.
- A fake `Terminal` implementing `@earendil-works/pi-tui`'s `Terminal` interface
  that records writes. **Verify whether that interface is exported** from the
  pi-tui package before investing; if it is, this is the cleanest way to assert
  the overlay painted the expected lines.

### Decision rule
- Renderer logic bugs (F1, blink, collapse) → **Tier 1**.
- "Did the right string reach the widget? Is it cleared correctly?" → **Tier 2 (RPC)**.
- Peek overlay / ANSI pixels → **Tier 3**.
- Your JSON timeline → keep as a **Tier 1 fixture generator + session forensics**,
  stop calling it "TUI capture."

### Tasks (fold into Phase 5)
- [x] Rename/demote the timeline: relabel `dumpTimelineToDisk` comments to
      "renderer-output capture (Tier 1 fixture source)," not "TUI capture."
- [x] Build one Tier 2 RPC harness: spawn `pi --mode rpc`, send a scripted
      delegation prompt, collect `setWidget` records, assert the panel string
      matches `renderProgress` output and is cleared at session end. Use
      `examples/rpc-extension-ui.ts` as the scaffold.
- [x] Guard `showPeek()` / Layer 3 with `ctx.mode === "tui"` (currently only the
      shortcut handler guards it at `index.ts:199` — make the component path
      guard too) so the RPC test run doesn't hit `custom()`.
- [x] Convert `feedRender` frames from the timeline into committed `.snap`
      fixtures for the Tier 1 renderer tests (Phase 5.2).

### Pitfalls
- Don't try to assert on the raw ANSI from `PI_TUI_WRITE_LOG` in CI — it's
  unreadable and layout-dependent. Use it for manual debugging only.
- Don't attempt to test the overlay in RPC mode — it can't render there. Either
  use Tier 3 or skip overlay coverage until pi-tui exposes a fakeable Terminal.
- The timeline's `render` field goes away when Phase 1.2 deletes `renderPlanLines`.
  Anything depending on that field (debug commands, fixtures) must move to the
  consolidated `renderProgress` output before Phase 1.2 lands.

---

## Appendix C — SDK doc, the parts that matter here

Verified against `packages/coding-agent/docs/sdk.md` (read it before Phase 4):

- **`session.subscribe(cb)`** returns an unsubscribe function. Documented event
  types are a closed set: `message_update`, `tool_execution_start`,
  `tool_execution_end`, `agent_start`, `agent_end`, `turn_start`, `turn_end`,
  `queue_update`, plus compaction/retry events. **No `role:"custom"` type.**
- **`tool_execution_end`** has `event.isError: boolean`.
- **`turn_end`** has `event.toolResults: Array<{toolName, toolCallId, result, isError}>`.
- **`ModelRegistry.inMemory(auth)`** = no file I/O, testing only.
  **`ModelRegistry.create(auth)`** = reads config files (confirm in your version).
- **`DefaultResourceLoader`** options: `noContextFiles` suppresses project-level
  context files — confirm exactly what it covers before relying on it for
  subagent isolation.

When the SDK doc and this plan disagree, **the SDK doc wins.** Update this plan.
