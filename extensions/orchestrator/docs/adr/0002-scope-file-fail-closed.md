# ADR 0002: Scope file failures are fail-closed

## Status
Accepted

## Context
If `.pi/scope.json` is malformed, stale, or has an unknown version, ScopeGuard cannot safely determine which files are allowed. Any heuristic fallback risks permitting an out-of-scope write, especially when the scope file is missing due to a configuration error or was produced by an incompatible orchestrator version.

## Decision
ScopeGuard treats unreadable, invalid, stale, or unknown-version scope files as blocking all writes. It does not prompt the user, does not infer intent, and does not fall back to an open state. The only valid recovery is to regenerate or repair `.pi/scope.json` through the normal orchestrator flow.

## Consequences
Legitimate edits may be blocked until the scope file is regenerated, which is a usability cost. However, this is preferable to the alternative: an accidental out-of-scope write caused by a corrupted or missing scope file. Fail-closed makes the failure mode obvious and forces explicit repair rather than silent permissiveness.
