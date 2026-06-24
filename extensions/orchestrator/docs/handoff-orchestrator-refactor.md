---
# Handoff: Orchestrator Extension Refactor

## Session summary
- Architecture review completed for `/Users/shivam94/.pi/agent/extensions/orchestrator`.
- Six candidates surfaced; five approved, one rejected.
- Interactive grilling completed for all approved candidates.
- Domain model captured in `CONTEXT.md`; two ADRs recorded.
- Full implementation plan written as `PRD.md` with 12 tracer-bullet issues.

## Approved candidates (implement)
- **A**: Scope lifecycle split — `ScopeManager` owns scope; no cache; orchestrator passes scope explicitly; `ScopeGuard` reads `.pi/scope.json` directly; fail-closed; orchestrator-driven `ScopeExpansionRequest`.
- **C**: `delegate-tool.ts` facade split — `DelegateController`, `AskResolver`, `DelegateFeedBuilder`, `DelegateOutputFormatter`, plus `ScopeManager`.
- **D**: `index.ts` god file split — `BashInterceptor`, `SubagentToolGuard`, `PromptBuilder`, `RegistrationHub`.
- **E**: Subagent event tangle — `SubagentEventRouter`; UI modules self-register; `activity-feed` owns state.
- **F**: `plan-panel.ts` globals — `PlanPanel` class, one instance per orchestrator session, passed via context.

## Rejected candidate
- **B**: Plan/feed progress model duplicated — false positive. `activity-feed.ts` already shared rendering infra; models are intentionally separate.

## Artifacts (do not duplicate; reference these)
- `/Users/shivam94/.pi/agent/extensions/orchestrator/PRD.md` — full PRD + 12 issues.
- `/Users/shivam94/.pi/agent/extensions/orchestrator/CONTEXT.md` — domain glossary.
- `/Users/shivam94/.pi/agent/extensions/orchestrator/docs/adr/0001-scope-enforcement-json-seam.md`
- `/Users/shivam94/.pi/agent/extensions/orchestrator/docs/adr/0002-scope-file-fail-closed.md`
- `/Users/shivam94/.pi/agent/extensions/orchestrator/architecture-review-fixed.html` — temporary review copy; safe to delete.

## Next session focus
- Delegate implementation of PRD issues to a junior/low-capability session.
- Start with Issue 1: Create ScopeManager module and move scope types.
- Follow dependency order in PRD.md.

## Suggested skills to invoke
- `/implement` — execute a single PRD issue with TDD and review.
- `/tdd` — for test-first seams like `ScopeManager`, `ScopeGuard`, `BashInterceptor`, `SubagentEventRouter`.
- `/review` — review each issue branch against PRD and standards.
- `/domain-modeling` — update `CONTEXT.md` if new terms crystallize during implementation.
- `/grilling` — if an implementation issue reveals a design contradiction, grill before coding.
- `/codebase-design` — if interface shape debates arise, use the shared vocabulary.

## Known constraints
- `ScopeGuard` must remain zero-coupled to the orchestrator module; it reads `.pi/scope.json` directly.
- No in-memory scope cache; orchestrator passes scope explicitly.
- `delegate-tool.ts` live report processing must not be moved to post-processing.
- Multiple pi instances may run concurrently; `PlanPanel` must be per-session.
- Scope guard blocks writes outside the workspace; temp artifacts may need to live in the repo.

## Open items
- Delete temporary `architecture-review-fixed.html` when convenient.
- Fusion functionality status: working (all 25 fusion tests pass, config enabled at `~/.pi/fusion.json`).
