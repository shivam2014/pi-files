# Orchestrator Extension — OpenWiki

> A TypeScript extension for the `pi-coding-agent` SDK that provides orchestrator-level delegation, scope enforcement, multi-model fusion, plan management, and subagent lifecycle control.

## What Is This?

The orchestrator extension transforms a base coding agent into an **orchestrator** that can:

1. **Delegate work** to specialist subagents (scout, coder, reviewer, researcher, writer)
2. **Enforce scope** — each delegation gets a precise filesystem boundary; violations are blocked at the tool level
3. **Fuse multiple AI models** — run 2–3 models in parallel, then synthesize their outputs via a judge
4. **Manage plans** — structured goal → steps → progress tracking with live UI
5. **Track activity** — real-time activity feed, peek overlay, and diagnostics for every subagent run

## Key Entry Points

| File | Purpose |
|------|---------|
| `/index.ts` | Extension entry point — lifecycle hooks, tool guard, registration |
| `/registration-hub.ts` | Central tool/command registration |
| `/delegate-tool.ts` | The `delegate` tool — primary API for orchestrator → subagent |
| `/fusion-tool.ts` | The `fusion` tool — multi-model deliberation |
| `/plan-tool.ts` | The `plan` tool — structured goal/step management |
| `/scope-guard.ts` | Scope enforcement at write time |
| `/subagent-runner.ts` | Subagent session creation and execution |
| `/specialists.ts` | Specialist roster and prompt construction |
| `/prompt-builder.ts` | Orchestrator prompt injection |

## Navigation

### Architecture

- **[Architecture Overview](architecture/overview.md)** — System design, module map, boot sequence, and key design patterns

### Workflows

- **[Delegation Workflow](workflows/delegation.md)** — How `delegate()` flows from tool call through scope, subagent execution, diagnostics, and result formatting
- **[Fusion Workflow](workflows/fusion.md)** — Multi-model panel → judge → synthesis pipeline
- **[Plan & Activity UI](workflows/plan-and-activity.md)** — Plan panel, activity feed, and peek overlay

### Domain

- **[Scope System](domain/scope.md)** — Scope manifest, resolution, enforcement, glob patterns, expansion requests, and the JSON file seam
- **[Specialists & Skills](domain/specialists-and-skills.md)** — Specialist roster, skill resolution, tool access, and prompt construction

### Testing

- **[Testing Guide](testing/guide.md)** — How to run tests, test patterns, snapshot testing, and what to check when making changes

## At a Glance — Tech Stack

- **Language:** TypeScript (ESM, `"type": "module"`)
- **SDK:** `@earendil-works/pi-coding-agent` v0.80.3
- **Glob matching:** `picomatch` v4
- **Test framework:** Vitest
- **No build step** — runs directly via SDK loader

## Design Philosophy (from AGENTS.md)

1. **Tool-level gate, not prompt-level.** Scope enforcement happens in `scope-guard.ts`, not via prompt reminders.
2. **Adaptive by complexity.** Single-file changes get relaxed scope; multi-file gets strict. Scout judges.
3. **Self-correction, not crash.** Block messages teach the LLM; single-turn recovery.
4. **Test snapshots, not exit codes.** Verify TUI output, not just pass/fail.

## Common Starting Points

- **New to the project?** Start with [Architecture Overview](architecture/overview.md)
- **Changing delegation behavior?** See [Delegation Workflow](workflows/delegation.md) and [Specialists & Skills](domain/specialists-and-skills.md)
- **Changing scope enforcement?** See [Scope System](domain/scope.md) and [Testing Guide](testing/guide.md)
- **Adding a new fusion model or panel?** See [Fusion Workflow](workflows/fusion.md)
- **Debugging subagent failures?** Check `/diagnostics/` directory and [Delegation Workflow](workflows/delegation.md#diagnostics)
- **Running tests:** `npx vitest run` from repo root
