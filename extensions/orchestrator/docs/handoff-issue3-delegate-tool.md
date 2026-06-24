# Handoff: Issue 3 — Refactor delegate-tool to use ScopeManager

## Session summary
- Issue 2 (ScopeGuard) completed, committed, pushed.
- ScopeGuard with fail-closed, path enforcement, file size checks, expansion requests.

## Completed artifacts
- `scope-guard.ts` — ScopeGuard class (isScopeValid, isPathAllowed, checkFileSize, requestExpansion)
- `scope-guard.test.ts` — 13 tests, all green
- 147 tests pass, 0 type errors

## Next issue: Issue 3 — Refactor delegate-tool to use ScopeManager
**GitHub:** #24 (blocked by #17 ✅ — resolved)

**What to build:**
Update delegate-tool to call ScopeManager.writeScope before a run and ScopeManager.clearScope after a run and in before_agent_start. Remove any in-memory scope cache (_cachedScope). Scope is passed explicitly to downstream modules.

**Key changes needed:**
1. Remove `_cachedScope` module-level variable from delegate-tool.ts
2. Use `ScopeManager` instead: `sm.writeScope(scope)` before delegation, `sm.clearScope()` after
3. Add `sm.clearScope()` to `before_agent_start` handler
4. Remove `extractScopeFromOutput` caching — scope is written to file, not cached in memory
5. Pass scope explicitly through context instead of module-level state

**Key files:**
- `/Users/shivam94/.pi/agent/extensions/orchestrator/delegate-tool.ts` — main target
- `/Users/shivam94/.pi/agent/extensions/orchestrator/subagent-runner.ts` — has writeScopeFile/clearScopeFile that may be consolidated
- `/Users/shivam94/.pi/agent/extensions/orchestrator/scope-manager.ts` — ScopeManager API

**Existing scope flow (to replace):**
- `delegate-tool.ts:39`: `let _cachedScope: Scope | null = null`
- `delegate-tool.ts:308-352`: `extractScopeFromOutput()` — parses ## Scope blocks
- `delegate-tool.ts:470`: `before_agent_start` sets `_cachedScope = null`
- `delegate-tool.ts:490-540`: scope resolution (explicit > cached > defaults)
- `delegate-tool.ts:640-645`: post-execution scope caching from scout/researcher output

**Target flow:**
- `delegate-tool.ts` calls `scopeManager.writeScope(scope)` before delegation
- `delegate-tool.ts` calls `scopeManager.clearScope()` after delegation + in before_agent_start
- No `_cachedScope` variable
- Scope passed via context, not module state

## Before starting
- Read PRD.md for full context
- Read scope-manager.ts for API
- Read delegate-tool.ts for current scope handling

## Git notes
- Remote: https://github.com/shivam2014/pi-files.git
- Branch: main
- Canonical working copy: ~/.pi/agent/extensions/orchestrator
- Git backup: ~/pi-files → sync before commit
