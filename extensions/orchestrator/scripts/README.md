# scripts/ — the prompt oracle

The **prompt oracle** is this directory's pair of offline renderers: `build-system-prompt.mjs` for the
orchestrator prompt and `render-specialist-prompt.mjs` for any named specialist/subagent prompt. Given
a cwd (and, for specialists, the delegation scope + budget), each reproduces — with no provider call —
the exact system text pi would send, by bundling the extension's TypeScript at **runtime** (esbuild, temp
dir) and driving the real pi SDK code paths, so a render always describes the *live* codebase rather than
a snapshot. `--chain` additionally runs the loaded extension chain's `before_agent_start` rewrites, which
is what makes the orchestrator render byte-identical to a live capture (other installed extensions, e.g.
token-saver's tone block, are part of the real text). `--diff CAPTURE.json` compares a render with a
preserved `prompt-dump` capture and exits 1 on any difference, which is how the `__fixtures__` gate keeps
the oracle honest; regenerate a fixture by copying a fresh `systemPrompt` into
`{ cwd, piVersion, note, systemPrompt }` — never the whole payload, which carries the conversation.

Ground truth for both is the `prompt-dump` extension (`../prompt-dump.ts`), which captures the
payload's leading system text. Diff a render against a capture with `--diff`.

## build-system-prompt.mjs

```bash
node scripts/build-system-prompt.mjs [--cwd DIR] [--json] [--base-only] [--skills] [--chain] [--diff CAPTURE.json] [--pi-root DIR] [--allow-old-pi]
```

- default: final orchestrator prompt to stdout, verbatim
- `--cwd DIR`: render for DIR (default `process.cwd()`)
- `--json`: `{ cwd, piVersion, charCount, lineCount, systemPrompt, baseCharCount, source }`
- `--base-only`: pi's base prompt only (starts `You are an expert coding assistant`)
- `--skills`: the discovered skill names (one per line)
- `--chain`: the loaded extension chain (`emitBeforeAgentStart`) — byte-for-byte the live-run text,
  including other installed extensions' prompt rewrites (e.g. token-saver's tone block)
- `--diff FILE`: unified diff against a capture's `systemPrompt`; exit 1 if they differ
- `--pi-root DIR`: render from this pi install (must be `@earendil-works/pi-coding-agent`)
- `--allow-old-pi`: permit rendering from a pi older than `1.3.0` (blocked by default)

Exit codes: `0` ok / identical, `1` diff found, `2` prompt could not be resolved (stderr).

### pi-root resolution + version guard

Render from the pi the RUNNING session uses, not from a stale copy:

1. `--pi-root DIR`
2. `PROMPT_SIM_PI_ROOT` (test hook)
3. the install providing the `pi` executable (`command -v pi` → realpath → walk up to the package root)
4. the `.hermes` global install (`~/.hermes/node/lib/node_modules/...`)
5. the copy under the extension's `node_modules` (last resort; in this environment 0.80.3)

A candidate older than `MIN_PI_VERSION` (`1.3.0`) is **skipped** when a newer one exists and the
skipped paths/versions are printed to stderr (`[skipped older: pi 0.80.3 at …]`). If every candidate
is old, resolution **fails with exit 2 naming each path/version**; `--allow-old-pi` overrides.
Rendering from the 0.80.3 copy silently produced 38,655 chars vs the live 27,494 — the guard exists
so that never happens again. Normal mode prints `build-system-prompt: pi <version> (<origin>: <root>)`
to stderr; `--json` carries `piVersion`.

### How it works

1. **base prompt** — `DefaultResourceLoader({cwd, agentDir, additionalExtensionPaths:[index.ts]})` +
   `createAgentSession` (SDK, `SessionManager.inMemory()`, offline), then `bindExtensions({})` so
   `session_start` (tool freeze, `index.ts:125-137`) and `resources_discover` (skills,
   `index.ts:171-186`) fire exactly like a live boot (`agent-session.js:2649-2653`). Then
   `session.systemPrompt`. pi >= 1.3 has **no `AuthStorage`/`ModelRegistry` session options** and
   `createAgentSession` does not accept `additionalExtensionPaths` (`sdk.js:69-120`) — extensions go
   in through the loader (`resource-loader.js:258`). Legacy (<1.3) installs use the old option shape.
2. **transform** — `--chain`: `runner.emitBeforeAgentStart({messageType:"print"}, session._baseSystemPromptOptions)`
   then `buildSystemPrompt(result.systemPromptOptions)` (`runner.js:1121`, forced prompt at
   `runner.js:1149-1151`). Plain mode: `buildOrchestratorPrompt()` from `../prompt-builder.ts` via an
   esbuild bundle in a temp dir (`node --experimental-strip-types` cannot load it — parameter
   properties in transitive imports).
3. **skills** — `_baseSystemPromptOptions.skills` unioned with the extension's `resources_discover`
   paths.

### Known limits

- **Plain mode ≠ live text.** `buildOrchestratorPrompt()` alone: no other extensions' rewrites, stub
  tool registry, fusion flag from `orchestrator.yml`. Use `--chain` when exact text matters.
- **Per-cwd.** The prompt embeds cwd-dependent content (context files, skills, pi docs paths).
- **Runtime reads.** prompt-builder/specialists are read from disk every run (no snapshot) — diff
  against a real capture in CI if the exact text must not drift.
- **Private fields.** `_baseSystemPromptOptions`/`_extensionRunner` are read directly; on rename the
  script falls back to the direct `buildSystemPrompt` path and says so in `source`.
- **Temp dirs.** esbuild bundles land in `os.tmpdir()` and are removed on exit.

## render-specialist-prompt.mjs

```bash
node scripts/render-specialist-prompt.mjs --specialist NAME [--cwd DIR] [--json] [--diff CAPTURE.json]
       [--scope-json FILE] [--budget-json FILE] [--pack "a,b"] [--pi-root DIR] [--allow-old-pi]
node scripts/render-specialist-prompt.mjs --all [--cwd DIR]
```

- `--specialist NAME`: `scout`, `coder`, `reviewer`, `researcher`, `writer` (from `SPECIALISTS`)
- `--all`: compact table `name | tools | chars | skills-section | first line`
- `--json`: `{ specialist, cwd, piVersion, tools, charCount, lineCount, skillsSectionPresent, prompt }`
- `--diff FILE`: unified diff against a capture; exit 1 if they differ
- `--scope-json FILE`: delegation scope (same fields as the `delegate()` scope object) — appended
  byte-for-byte as `subagent-runner.ts:1121-1132` does
- `--budget-json FILE`: `{ maxExplorationCalls, maxFiles, maxTurns }` override section
- `--pack "a,b"`: skills override; resolves as defaults ∪ override (`specialists.ts:649-653`)
- `--pi-root` / `--allow-old-pi`: same resolution + guard as above

### How it works (mirrors `subagent-runner.ts:1105-1146`)

1. `DefaultResourceLoader({ noSkills: true, additionalSkillPaths: <pack ∩ disk>, noContextFiles: true,
   systemPromptOverride: () => systemPrompt + scope + budget + buildSkillSection(...) })`
2. `createAgentSession({ tools: specialist.tools + runner extras, excludeTools })`
3. `bindExtensions` + `emitBeforeAgentStart` → the full extension chain (token-saver's tone block
   included), rendered through `buildSystemPrompt`.

**Why the orchestrator extension is excluded from the loaded set:** `subagent-runner` sets
`PI_ORCHESTRATOR_SUBAGENT=1`, but `index.ts:88-95` defensively deletes that flag when
`subagentSessions.size === 0` — which is always true in a standalone process (the SDK loads each
`.ts` extension through its own jiti instance, `loader.js:477-481`, so the renderer cannot populate
the parent's map). Loading every discovered extension except `orchestrator/index.ts` is behaviorally
identical for a subagent: its `before_agent_start`/`session_start`/`resources_discover` handlers all
return early while that flag is set.

### Known limits

- **Delegation-specific text** (scope, budget, `{sessionId}` substitution) only appears when passed
  via `--scope-json`/`--budget-json`; those values live in the orchestrator's session, not on disk.
- **Needs the running pi 1.3.0 install.** Resolution skips anything older (see above); the gate is red
  on a 0.80.x-only machine by design.
- **The extension tree is always the live one.** Discovery walks `<agentDir>/extensions` (`~/.pi/agent`),
  so a render launched from a *copy* of this tree (e.g. the `~/pi-files` backup) still loads the live
  extensions, and the `orchestrator/index.ts` exclusion — which compares against `<EXT_DIR>/index.ts` —
  misses: the orchestrator extension then loads and appends its own `## Session-Start Protocol` /
  `## Capabilities` sections (32,513 chars vs the captured 14,229). Run the gate from the live tree until
  the exclusion is made path-independent (resolve `<agentDir>/extensions/orchestrator` by identity, not by
  one hard-coded path).
- **Per-cwd.** The prompt embeds cwd-dependent content (context files, skills, pi docs paths).
- **Fixtures hold prompt text only.** A capture's `payload`/`messages` (the whole conversation) must never
  be copied into `__fixtures__`; the gate fixtures carry `cwd`/`piVersion`/`note`/`systemPrompt` and nothing else.
- **Other extensions' per-mode behavior** is reproduced by loading them, not simulated — an extension
  that inspects the delegation (env, scope file) can still diverge.
- **Skills section asymmetry (by design in pi):** `dist/core/system-prompt.js:101-109` injects the
  `<skills>` block only when a skill-file-reading tool (`read`/`bash`) is declared. Specialists
  declare `read`/`bash` → they get the full skill index; the orchestrator declares none → no block.
  This tool makes that asymmetry visible per specialist (`skillsSectionPresent` / the `--all` table).

## prompt-dump evidence layout

`../prompt-dump.ts` names captures `payload-orch-<ISO>-<n>.json` (system head contains
`You are an orchestrator`) or `payload-sub-<ISO>-<n>.json` (everything else) and keeps
`MAX_DUMP_FILES` (=10) **per kind**, so a burst of subagent captures can never evict orchestrator
ones. Legacy/unknown-kind names form their own pool and keep whole-directory pruning. Copy dumps you
need to keep out of `/tmp/prompt-dump` — the per-kind cap still prunes.

## Tests

```bash
cd ~/.pi/agent/extensions
npx vitest run orchestrator/build-system-prompt.test.ts orchestrator/prompt-dump.test.ts
```

### The gate: `__fixtures__` + `oracle-gate.test.ts`

`scripts/__fixtures__/` holds prompt **text only** — no messages, no payload, no conversation:

| fixture | source | size |
|---|---|---|
| `orchestrator-prompt.json` | live orchestrator run, `cwd /private/tmp` | 27,494 chars / 28,306 B |
| `coder-prompt.json` | live coder specialist run, `cwd …/Documents/Resume` | 14,229 chars / 14,863 B |
| `coder-scope.json` | the delegation scope that run used (needed for a byte-exact coder render) | 839 B |

`../oracle-gate.test.ts` renders against them and asserts exit 0 (`no differences` for the
two renderers to still agree with the captures they were built from):

```bash
cd ~/.pi/agent/extensions
npx vitest run orchestrator/oracle-gate.test.ts
```

To regenerate a fixture from a fresh capture: run a session with `prompt-dump` enabled, take the
newest `/tmp/prompt-dump/payload-orch-*.json` (or `payload-sub-*`), and copy **only** its `systemPrompt`
into the fixture's `{ cwd, piVersion, note, systemPrompt }` shape — then re-run the gate; the diff hunk
it prints names the section that drifted.
