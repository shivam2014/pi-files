# scope-guard

A subagent physically can't write outside its approved scope.

## What it solves

An orchestrator hands a subagent a scope: the files it may touch. scope-guard enforces that scope at the tool level. Any `write` or `edit` targeting a file outside the scope is blocked before it executes.

## How it works

- Reads `.pi/scope.json` (relative to cwd).
- No scope file → pass-through, zero overhead (invisible outside a delegation).
- Scope file present → only approved files can be modified or created.
- Zero coupling to the orchestrator module: the file path and schema are the shared contract, not a code import.

## Fail-closed (ADR-0002)

The orchestrator's `ScopeGuard` is fail-closed: a missing, malformed, or stale `.pi/scope.json` blocks all writes. See `docs/adr/0002-scope-file-fail-closed.md`. This standalone adapter sits at the tool layer and uses the same `tool_call` + block pattern (`lint-guard.ts` is its template).

## Scope fields

`filesToModify`, `filesToCreate`, `directories`, `maxFiles`, `maxLinesPerFile`, `changeType`, `gateMode`, `boundaries`. Glob patterns (`*`, `**`, `?`) are supported.

## Enforcement details

- Directory entries allow up to `maxFiles` files under that directory.
- `maxLinesPerFile` is enforced on `write` (skipped when `gateMode` is `relaxed`).
- A blocked call returns an error to the subagent. The subagent keeps running and can request scope expansion via `ask_orchestrator`.

## Source

`scope-guard.ts` — same `tool_call` + block pattern as `lint-guard.ts`.
