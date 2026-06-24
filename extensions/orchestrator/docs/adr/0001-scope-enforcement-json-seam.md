# ADR 0001: Scope enforcement lives in a JSON file seam

## Status
Accepted

## Context
ScopeManager and ScopeGuard need to share scope state without coupling ScopeGuard to the orchestrator module. AGENTS.md requires zero coupling between the guard and orchestrator internals, so an in-memory reference or direct API call is not acceptable.

## Decision
ScopeManager writes the canonical scope state to `.pi/scope.json`. ScopeGuard reads the raw JSON file directly. The contract between the two components is the file path, the JSON schema, and a version field. ScopeManager owns write semantics; ScopeGuard owns read and enforcement semantics.

## Consequences
ScopeGuard remains independent of the orchestrator module and can be reasoned about, tested, and replaced in isolation. The main cost is duplicated schema knowledge: both writer and reader must agree on fields, types, and version handling. Schema changes must be coordinated, and mismatches are mitigated by the version field and fail-closed behavior defined in ADR 0002.
