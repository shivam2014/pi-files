# Orchestrator Extension — Quickstart

## What This Project Is

The **Orchestrator Extension** is a TypeScript plugin for the [pi-coding-agent](https://github.com/shivam2014/pi-files) AI coding assistant. It transforms a single AI agent into a **multi-agent orchestration system** where a central orchestrator delegates tasks to specialized subagents (Scout, Coder, Reviewer, Researcher, Writer) while maintaining visibility, scope enforcement, and progress tracking.

The extension lives at `~/.pi/agent/extensions/orchestrator` and is loaded by the pi-coding-agent runtime via its extension API.

## Key Concepts at a Glance

| Concept | What It Does |
|---------|-------------|
| **Delegation** | Orchestrator dispatches tasks to specialist subagents via `delegate(specialist, task, scope)` |
| **Scope Enforcement** | Tool-level write guard ensures subagents only modify files in their assigned scope |
| **Plan Panel** | TUI widget (Layer 1) showing the orchestrator's goal and step list |
| **Activity Feed** | Chat blocks (Layer 2) showing live subagent tool calls and progress |
| **Peek Overlay** | Ctrl+Q overlay (Layer 3) for viewing live subagent conversations |
| **Fusion** | Optional multi-model analysis — panel of models + judge synthesis |
| **Ask Resolver** | Subagent → orchestrator clarification pipeline (auto-resolves from files/docs before escalating) |

## Architecture in One Sentence

A flat TypeScript module tree where `index.ts` wires lifecycle hooks into the pi-coding-agent extension API, `subagent-runner.ts` creates isolated agent sessions, and `scope-guard.ts` enforces file boundaries at the tool-call level.

## Module Map

```
orchestrator/
├── index.ts                  # Entry point — lifecycle hooks, tool registration
├── registration-hub.ts       # Centralized tool/command registration
├── prompt-builder.ts         # Orchestrator system prompt construction
│
├── specialists.ts            # 5 specialist definitions + system prompts
├── delegate-tool.ts          # delegate() tool — primary orchestration entry
├── delegate-controller.ts    # Delegation lifecycle (validation, abort)
├── delegate-pipeline.ts      # End-to-end delegation: scope → run → format → plan
├── subagent-runner.ts        # Isolated subagent session creation
├── subagent-tool-guard.ts    # Tool call enforcement (scope, plan-first, bash intercept)
├── subagent-diagnostics.ts   # Post-run diagnostic capture + persistence
├── subagent-event-router.ts  # Event routing for subagent sessions
│
├── scope-manager.ts          # Scope concept owner, .pi/scope.json read/write
├── scope-guard.ts            # Path-level write enforcement (reads .pi/scope.json)
├── scope-policy.ts           # Default scope policies per specialist type
│
├── plan-panel.ts             # Plan state + TUI widget (Layer 1)
├── plan-tool.ts              # plan/add_steps/advance/insert/remove/modify tools
├── activity-feed.ts          # Subagent progress chat blocks (Layer 2)
├── peek-overlay.ts           # Ctrl+Q conversation viewer (Layer 3)
│
├── fusion-tool.ts            # fusion() tool registration
├── fusion-pipeline.ts        # Panel execution → judge synthesis
├── fusion-config.ts          # .pi/fusion.json config loading
├── fusion-models.ts          # Model resolution + auto-diverse panel selection
├── fusion-judge.ts           # Judge prompt + analysis parsing
├── fusion-format.ts          # Result formatting
├── fusion-commands.ts        # /fusion-status, /fusion-toggle commands
├── fusion-tui.ts             # Fusion status TUI widget
├── fusion-utils.ts           # Shared utilities
│
├── ask-resolver.ts           # Subagent clarification pipeline
├── bash-interceptor.ts       # Bash → native tool redirection
├── scout-tools.ts            # git-read, gh tool definitions
├── introspection-tools.ts    # list_skills, list_tools
├── read-skill-tool.ts        # read_skill() — load SKILL.md packs
├── skill-resolver.ts         # Skill path resolution
│
├── orchestrator-theme.ts     # Theme tokens + status icons
├── spinner-state.ts          # Spinner animation state
├── ui-utils.ts               # Duration formatting
├── debug.ts                  # Debug logging (env-gated)
├── debug-path-trace.ts       # Tool call path tracing
│
├── types.ts                  # Shared interfaces (PlanStep, Specialist, FusionConfig, etc.)
│
├── *.test.ts                 # Unit + integration tests
└── vitest.config.ts          # Test config with SDK path aliases
```

## Where to Go Next

- **[Architecture Overview](architecture/overview.md)** — Three-layer visibility system, module relationships, data flow
- **[Delegation Workflow](workflows/delegation.md)** — How `delegate()` works end-to-end, specialist routing, subagent lifecycle
- **[Scope System](domain/scope.md)** — Scope manifest, guard enforcement, fail-closed design, gate modes
- **[Specialists & Skills](domain/specialists-and-skills.md)** — The 5 specialist roster, skill packs, tool access matrix
- **[Fusion Subsystem](workflows/fusion.md)** — Multi-model panel analysis, judge synthesis, configuration
- **[Plan & Activity](workflows/plan-and-activity.md)** — Plan panel TUI, activity feed rendering, peek overlay
- **[Testing Guide](testing/guide.md)** — Test infrastructure, patterns, key test files, how to run

## Quick Start for Developers

### Prerequisites

- Node.js with TypeScript
- pi-coding-agent SDK at `~/.pi/agent/extensions/node_modules/@earendil-works/pi-coding-agent`

### Commands

```bash
# Run all tests
npx vitest run

# Type-check without emitting
npx tsc --noEmit
```

### Key Design Principles

1. **Tool-level gate, not prompt-level.** Scope enforced by `scope-guard.ts` intercepting tool calls — no prompt reminders that decay.
2. **Adaptive by complexity.** Single-file → relaxed mode, multi-file → strict mode. Scout judges the gate mode.
3. **Self-correction, not crash.** Blocked operations don't terminate the subagent. Block messages teach LLMs to recover in one turn.
4. **Cache safety.** Tool schemas frozen at `session_start` to preserve prefix cache across turns.
5. **Fail-closed scope.** Missing/malformed/stale scope.json blocks ALL writes.

## Project Context

- **Canonical working copy**: `~/.pi/agent/extensions/orchestrator`
- **Git backup/sync**: `~/pi-files` → `github.com/shivam2014/pi-files.git`
- **GitHub Issues**: Filed on `shivam2014/pi-files` repo
- **SDK dependency**: `@earendil-works/pi-coding-agent@0.80.3`
