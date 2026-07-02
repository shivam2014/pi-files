# Orchestrator Extension — Status

Last updated: 2026-06-24

## Current State

All core features implemented and tested. Recent work focused on:
- Fusion tool description normalization (Issue #38)
- Orchestrator prompt appendix slimming (Issue #39)
- Clarification instruction deduplication (Issue #40)
- Scope-guard array field guards and path normalization (Issues #48, #50)

## Test Suite

- **21 test files** covering all core modules
- **All tests passing** (vitest)
- Key test files:
  - `fusion-tool.test.ts` — panel/judge synthesis, description length
  - `fusion-toggle.test.ts` — enable/disable, registration, prompt injection
  - `prompt-builder.test.ts` — appendix size, duplicate removal
  - `delegate-controller.test.ts` — scope gate, delegation lifecycle
  - `scope-guard.test.ts` — path enforcement, fail-closed, array guards
  - `ask-resolver.test.ts` — file/docs/context resolution, escalation

## Documentation Status

- **AGENTS.md** — Updated: Key Files table (30 modules), file count (20+)
- **CONTEXT.md** — Current: all module definitions match implementation
- **VISION.md** — Updated: implementation status table reflects working features
- **FUSION-SPEC.md** — Updated: registration pattern (always registered, visibility via setActiveTools)
- **PRD.md** — Updated: test paths corrected (root, not src/)
- **AUDIT** — Updated: RUN-011 and HAR-003 marked fixed (scope-guard exists)

## Open Issues (GitHub)

- #52: Decision: ask_orchestrator escalation never prompts user directly
- #47: fusion-toggle.test.ts: session_start vs before_agent_start test mismatch
- #45: Goal-achieved early stop
- #44: Subagent minimal context
- #43: ask-matt routing table
- #42: Specialist default skills + delegate override
- #41: SDK skill discovery for subagents
- #37: Deduplicate clarification instructions
- #36: Slim orchestrator prompt appendix
- #35: Normalize tool schemas
- #31: PRD: Orchestrator extension prompt streamlining, ask-matt skill integration, and subagent efficiency

## Key Decisions

- **Issue #52**: ask_orchestrator escalation never prompts user directly (inline sign-off, formalized)
- **Scope-guard**: zero-coupled to orchestrator module, reads .pi/scope.json directly, fail-closed
- **Fusion registration**: always registered at init, visibility controlled via setActiveTools
- **Clarification instructions**: deduplicated — STEPS_MANDATE in specialists.ts is single source
