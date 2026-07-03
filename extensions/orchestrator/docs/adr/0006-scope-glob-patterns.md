# ADR 0006: Scope glob patterns in existing fields

**Status:** Draft

**Context:** The orchestrator's scope guard requires exact path enumeration in
filesToModify and filesToCreate. This forces the orchestrator to predict every
file the subagent will touch. A common failure: task mentions "update tests"
but scope only lists source files — guard blocks legitimate test file edits.

The orchestrator needs to express "create any test file" or "modify any file
matching a pattern" without enumerating every path.

Alternative approaches considered:
- New autoAllowPatterns field (schema expansion, more complex)
- Separate allow/deny lists (over-engineered for v1)
- Directory-only scopes (fails for co-located test/source files)
- Subagent-initiated scope expansion (inverts orchestrator authority)

**Decision:** Add glob pattern support to the existing filesToModify and
filesToCreate fields. No new fields. The guard checks in order:
1. Exact path match → ALLOW
2. Glob pattern match → ALLOW
3. Directory prefix match → ALLOW
4. BLOCK

Minimatch is the glob library (check if already in deps; add if not).

The ask-resolver resolve() gate is updated: a scope is "concrete" if its
filesToModify/filesToCreate entries collectively contain at least one
literal segment (a path component without glob metacharacters). Bare `*`
and `**` alone are rejected.

Overly broad patterns (bare `*`, `**`, or patterns with no literal segment)
are rejected at scope validation time. Escaped metacharacters are literal.

**Consequences:**
+ Orchestrator can write `filesToCreate: ["*.test.ts", "tests/**"]` instead
  of listing every test file. Reduces friction.
+ No schema break — existing exact-path scopes keep working.
+ Deterministic enforcement preserved — guard evaluates patterns the same
  way it evaluates exact paths.
- Literal filenames containing glob chars (`file[1].ts`) need exact-match
  precedence to avoid misinterpreting as patterns.
- ask-resolver.ts must distinguish glob vs concrete entries — additional
  scope validation logic.
- Backwards-compatibility: existing scope.json files with literal glob-like
  filenames may now match more paths. Low risk in practice.
