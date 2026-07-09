# Architecture Overview

## Three-Layer Visibility System

The orchestrator implements a three-layer TUI visibility system so users can see what's happening at different granularity levels:

| Layer | Name | Module | What It Shows |
|-------|------|--------|---------------|
| **Layer 1** | Plan Panel | `plan-panel.ts` | Goal + step list in a 9-line TUI widget (always visible) |
| **Layer 2** | Activity Feed | `activity-feed.ts` | Chat blocks showing tool calls, output previews, spinners |
| **Layer 3** | Peek Overlay | `peek-overlay.ts` | Ctrl+Q overlay showing live subagent conversation messages |

### Layer 1: Plan Panel

The plan panel is a fixed-height (9-line budget) TUI widget rendered via `pi.setStatus("orchestrator-status", ...)`. It shows:
- The orchestrator's current goal
- Ordered step list with status icons (pending/active/completed/errored)
- Active delegation count and elapsed time
- Spinner animation during active work

State lives in `PlanPanel` instances, one per session, stored in a module-scoped `Map<string, PlanPanel>` keyed by `sessionId`.

**Key file**: `/plan-panel.ts` — exports 23 proxy functions that delegate to session-specific instances.

### Layer 2: Activity Feed

The activity feed renders subagent progress as chat blocks. Each delegation gets a feed showing:
- Goal and step labels
- Substeps (individual tool calls) with output previews
- Progress dots, spinners, and box-drawing borders
- Error indicators and retry counts

State is managed by `ActivityFeedState` (defined in `/types.ts`). Subagents register their plans via the `planSteps()` tool and advance via `advanceStep()`, which drives the feed state machine.

**Key file**: `/activity-feed.ts`

### Layer 3: Peek Overlay

Pressing Ctrl+Q opens a right-aligned overlay showing the live subagent conversation. Features:
- Auto-scrolling conversation messages
- Streaming text output
- ~50 line cap with Escape to close
- Double-press `x` to abort the subagent

**Key file**: `/peek-overlay.ts`

## Extension Lifecycle

The extension hooks into pi-coding-agent's lifecycle events:

```
session_start ──→ Freeze active tools (prefix-cache safety)
                       │
before_agent_start ──→ Clear scope + plan, inject system prompt
                       │
tool_call ──→ Block non-delegation tools (orchestrator mode)
              OR enforce plan-first + scope (subagent mode)
                       │
agent_end ──→ Clear plan panel, flush timeline
                       │
session_shutdown ──→ Final cleanup
```

### Subagent Guard

When running inside a subagent session (detected via `SUBAGENT_ENV_KEY` env var), `index.ts` skips orchestrator registration and only registers the `tool_call` handler for subagent tool guarding. This prevents recursive delegation.

### Tool Freezing

Active tools are frozen at `session_start` (not `before_agent_start`) to ensure the system prompt's "Available tools:" section is stable from turn 1 onward, preserving prefix cache reuse across turns.

**Key file**: `/index.ts`

## Module Dependency Graph

```
index.ts
  ├── registration-hub.ts (registers all tools + commands)
  │     ├── delegate-tool.ts → delegate-pipeline.ts
  │     ├── plan-tool.ts → plan-panel.ts
  │     ├── fusion-tool.ts → fusion-pipeline.ts
  │     ├── introspection-tools.ts
  │     └── scout-tools.ts
  ├── prompt-builder.ts (system prompt)
  │     ├── specialists.ts (roster + tool docs)
  │     └── scope-manager.ts (scope documentation)
  ├── subagent-tool-guard.ts (tool call enforcement)
  │     ├── scope-guard.ts (write enforcement)
  │     ├── bash-interceptor.ts (bash redirection)
  │     └── fusion-config.ts (fusion enabled check)
  └── subagent-runner.ts (session creation)
        ├── specialists.ts (system prompts + skills)
        ├── activity-feed.ts (live progress)
        ├── plan-panel.ts (plan step updates)
        └── peek-overlay.ts (conversation viewer)
```

## Data Flow: End-to-End Delegation

```
1. User request arrives at orchestrator
        │
2. Orchestrator calls plan(goal, steps)
   → PlanPanel created, goal + steps rendered in Layer 1 widget
        │
3. Orchestrator calls delegate(specialist, task, scope)
   → delegate-tool.ts → DelegateController.validate()
        │
4. ScopeManager writes .pi/scope.json
   → ResolvedScope with absolute paths, gateMode, changeType
        │
5. DelegatePipeline.run():
   a. Plan panel step activated (Layer 1)
   b. Activity feed cleared for new delegation (Layer 2)
   c. SubagentRunner creates isolated session
      → System prompt from specialist definition + skills
      → Tools filtered to specialist's allowed set
   d. Subagent executes with tool guard active
      → scope-guard enforces file boundaries
      → bash-interceptor redirects cat/grep/find to SDK tools
      → planSteps/advanceStep drive activity feed
   e. Activity feed renders tool calls + output (Layer 2)
   f. Peek overlay shows live conversation (Layer 3, Ctrl+Q)
        │
6. Subagent completes → output parsed
   → DelegateOutputFormatter extracts structured sections
   → SubagentDiagnostic captured (turns, tool calls, metrics)
        │
7. Plan panel step finalized (completed/errored)
   → Delegation count decremented
   → If all steps done, plan auto-clears
        │
8. Orchestrator receives result, continues reasoning
```

## Key Architectural Decisions

### Tool-Level Enforcement (not prompt-level)
Scope boundaries are enforced by `scope-guard.ts` intercepting `edit`/`write` tool calls, not by prompt instructions that LLMs can forget. This is an ADR decision documented in `/docs/adr/0001-scope-enforcement-json-seam.md`.

### JSON Seam for Scope
`ScopeManager` writes `.pi/scope.json`; `ScopeGuard` reads it directly. Zero coupling between the two modules — the file path and schema version are the only shared contract.

### Fail-Closed Design
Missing, malformed, or wrong-version scope files block ALL writes. No fallback behavior, no user prompting. This is deliberate — a broken scope should never silently allow writes.

### Adaptive Gating
Single-file changes use `relaxed` gate mode (fewer restrictions). Multi-file changes use `strict` mode. The gate mode is determined by the `changeType` field in the scope manifest.

### Self-Correction Pattern
When a subagent hits a scope violation, it receives a block message but continues running. The message is designed to teach the LLM what went wrong and how to recover (e.g., call `ask_orchestrator` to request scope expansion). This is preferred over crashing because the subagent often has partial progress worth preserving.

## Module Organization

The codebase is a flat TypeScript module tree — no nested `src/` directories. All `.ts` files are at the root, grouped by domain concern:

- **Orchestration core**: `index.ts`, `registration-hub.ts`, `prompt-builder.ts`, `commands.ts`
- **Delegation**: `delegate-*.ts`, `subagent-*.ts`
- **Scope**: `scope-*.ts`
- **Plan/Activity**: `plan-*.ts`, `activity-feed.ts`, `peek-overlay.ts`
- **Fusion**: `fusion-*.ts`
- **Tools**: `scout-tools.ts`, `introspection-tools.ts`, `read-skill-tool.ts`, `bash-interceptor.ts`
- **Support**: `types.ts`, `debug*.ts`, `spinner-state.ts`, `ui-utils.ts`, `orchestrator-theme.ts`

## Testing Strategy

Tests are co-located with source files as `*.test.ts` and run with Vitest. The test config (`vitest.config.ts`) uses path aliases to resolve SDK imports from the installed `@earendil-works/pi-coding-agent` package.

**Key patterns**:
- Snapshot tests for TUI output (`__snapshots__/`)
- Mock-based unit tests for each module
- E2E test (`test-mock-e2e.test.ts`) simulating full delegation flows
- Tests must trigger `session_start` before `before_agent_start` to exercise tool freezing

See [Testing Guide](../testing/guide.md) for details.
