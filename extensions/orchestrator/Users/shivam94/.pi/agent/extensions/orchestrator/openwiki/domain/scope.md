# Scope System

The scope system enforces filesystem boundaries for each delegation. It is the **safety mechanism** that prevents subagents from writing outside their allowed area.

## Core Concepts

### ScopeManifest (Input/Authoring View)

The raw scope provided by the orchestrator or extracted from subagent output:

```typescript
{
  filesToCreate: string[],    // Files the subagent may create
  filesToModify: string[],    // Files the subagent may modify (supports globs)
  directories: string[],      // Directories the subagent may access
  maxFiles: number,           // Maximum number of files
  maxLinesPerFile: number,    // Maximum lines per file
  gateMode: GateMode,         // Enforcement strictness
  boundaries: ScopeBoundary[] // Additional boundary rules
}
```

### ResolvedScope (Enforcement View)

The normalized, flat enforcement view produced by `ScopeManager.normalize()`:
- All patterns resolved
- Defaults filled
- Ready for enforcement by `ScopeGuard`

### GateMode

Derived from `changeType`:
- **strict**: Multi-file changes, full enforcement
- **relaxed**: Single-file changes, reduced enforcement

### GlobPattern

A `filesToModify` or `filesToCreate` entry containing wildcard metacharacters (`*`, `?`, `[`, `{`). Uses picomatch syntax alongside exact paths. Each entry is independent — no negative/deny patterns.

### LiteralSegment

A path component without glob metacharacters. The ask-resolver specificity gate requires at least one literal segment for a pattern to count as "concrete." For example:
- `tests/**` → literal segment `tests` ✓
- `*.test.ts` → no literal segments ✗

## Enforcement Flow

```
Subagent tries to write file
    │
    ▼
ScopeGuard.isPathAllowed(filePath, operation)
    │
    ├── Read operation → always allowed
    │
    └── Write/Check operation:
        ├── 1. Exact match in allowed set → allowed
        ├── 2. Glob pattern match (picomatch) → allowed
        ├── 3. Directory prefix match → allowed
        └── 4. No match → BLOCKED
                │
                ▼
        ScopeExpansionRequest emitted
        (orchestrator decides whether to expand)
```

## The JSON File Seam

**ADR-0001:** Scope enforcement uses `.pi/scope.json` as the seam between writer (ScopeManager) and reader (ScopeGuard).

- **ScopeManager** writes the file with schema version
- **ScopeGuard** reads and validates against the schema
- Both validate independently — no shared type import
- Version mismatch treated as stale/malformed → fail-closed

**ADR-0002:** Malformed or missing scope file blocks **all** writes. Fail-closed.

## Scope Lifecycle

1. **Clear**: `clearScope()` runs in `before_agent_start` and after every delegation
2. **Resolve**: `resolveScope()` determines scope per delegation
3. **Write**: `writeScope()` persists to `.pi/scope.json`
4. **Enforce**: `ScopeGuard.isPathAllowed()` checks every write
5. **Expand**: `ScopeExpansionRequest` emitted on violation (orchestrator decides)
6. **Clear**: Scope removed after delegation completes

**Critical:** Scope is ephemeral. Never depend on it persisting across turns.

## Scope Policy

`scope-policy.ts` provides default scopes per specialist:

- **Writer**: Doc-friendly scope (limited to documentation files)
- **Read-only** (scout, reviewer, researcher): No write access

The orchestrator can provide explicit scope via the `scope` parameter on `delegate()`.

## Expansion Requests

When a subagent writes outside scope:
1. `ScopeGuard` emits `ScopeExpansionRequest`
2. Orchestrator receives the request with full conversation history
3. Orchestrator decides: approve expansion, redirect, or block
4. If approved: `ScopeManager` rewrites `.pi/scope.json` with expanded allowed set

**Important:** The orchestrator decides, not the end user. The orchestrator has full context.

## What to Watch Out For

- **Fail-closed is non-negotiable**: Never weaken scope enforcement to pass tests (anti-pattern from AGENTS.md)
- **Glob patterns use picomatch**: Test glob patterns with picomatch directly if behavior seems wrong
- **Scope is per-delegation**: Each `delegate()` call gets its own scope. Scope does not accumulate.
- **Clear on every turn**: `clearScope()` runs in `before_agent_start`, ensuring no stale scope
- **Coder scope is mandatory**: Delegating to `coder` without scope blocks the delegation
- **Schema versioning**: `.pi/scope.json` has a schema version. Mismatch = fail-closed.

## Related Files

- `/scope-manager.ts` — Scope normalization, read/write, resolve
- `/scope-guard.ts` — Enforcement adapter
- `/scope-policy.ts` — Default policies
- `/scope-guard.test.ts` — Enforcement tests
- `/scope-manager.test.ts` — Manager tests
- `/docs/adr/0001-scope-enforcement-json-seam.md` — ADR
- `/docs/adr/0002-scope-file-fail-closed.md` — ADR
- `/docs/adr/0006-scope-glob-patterns.md` — ADR (draft)
