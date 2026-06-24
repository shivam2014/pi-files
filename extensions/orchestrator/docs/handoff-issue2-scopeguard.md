# Handoff: Issue 2 — ScopeGuard

## Session summary
- Issue 1 (ScopeManager) completed, reviewed, committed (`ad71c4c`), pushed.
- 4 review issues identified and fixed (unused import, `gateMode` optional, `require(fs)` style, `writeScope` signature).
- Issue #17 on GitHub updated to reflect actual implementation.

## Completed artifacts
- `scope-manager.ts` — ScopeManager class (normalize, gateMode, writeScope, readScope, clearScope)
- `scope-manager.test.ts` — 13 tests, all green
- `types.ts` — re-exports Scope/ScopeGateMode from scope-manager
- 134 tests pass, 0 type errors

## Next issue: Issue 2 — ScopeGuard (zero-coupled enforcement adapter)
**GitHub:** #23 (blocked by #17 ✅ — now resolved)

**Key design constraints:**
- ScopeGuard must remain **zero-coupled** to orchestrator module — reads `.pi/scope.json` directly, no imports from orchestrator
- Fail-closed: missing/stale/malformed `.pi/scope.json` blocks all writes
- Emit `ScopeExpansionRequest` when expansion is allowed
- Already exists at `/Users/shivam94/.pi/agent/extensions/scope-guard.ts` — review and refactor rather than build from scratch

**Existing scope-guard.ts** (at extensions root, NOT in orchestrator/ dir):
- Reads `.pi/scope.json` directly (raw JSON parse)
- Has own scope cache with 1s throttle (`_cachedScope`, `_lastScopeRead`)
- Has own `_touchedFiles` array tracking per-session file writes
- `isPathInScope` checks direct file match + wildcard `/*` suffix
- `isPathAllowed` checks file lists + directory-level with `maxFiles` cap
- Blocks `write`/`edit` tool calls outside scope
- Line count enforcement on `write` (skipped if `gateMode === 'relaxed'`)
- `resetTouchedFiles()` export for testing
- No version/schema validation — despite ADR-0001 and ADR-0002 documenting it

**ADR constraints:**
- ADR-0001: scope-file-json-seam — ScopeGuard reads `.pi/scope.json` as JSON, not via a module
- ADR-0002: scope-file-fail-closed — missing/stale/malformed file = block all writes

**Suggested approach:**
1. Read existing scope-guard.ts first — it already implements most of what Issue 2 asks for
2. Use TDD for the test-first seams
3. Add version/schema validation
4. Review against Issue 2 acceptance criteria

## Before starting
- Read PRD.md for full context
- Read CONTEXT.md for domain glossary
- Read ADR-0001 and ADR-0002 in docs/adr/
- Read existing `/Users/shivam94/.pi/agent/extensions/scope-guard.ts`

## Git notes
- Remote: `https://github.com/shivam2014/pi-files.git`
- Branch: `main`
- Canonical working copy: `~/.pi/agent/extensions/orchestrator`
- Git backup: `~/pi-files` → sync before commit
