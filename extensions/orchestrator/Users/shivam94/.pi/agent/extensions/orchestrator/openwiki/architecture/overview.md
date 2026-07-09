# Architecture Overview

## System Design

The orchestrator extension is a **plugin** for the `pi-coding-agent` SDK. It hooks into the agent lifecycle and replaces the base agent's behavior with orchestrator-level delegation. The base agent never directly edits files — it delegates to specialist subagents that each run in isolated sessions.

```
┌─────────────────────────────────────────────────────────┐
│  User Request                                           │
│         │                                               │
│         ▼                                               │
│  ┌──────────────────┐                                   │
│  │  Orchestrator    │  ← prompt-builder.ts injects      │
│  │  (base agent)    │     delegation-focused prompt     │
│  └────────┬─────────┘                                   │
│           │                                             │
│     ┌─────┴──────┬──────────┬───────────┐              │
│     ▼            ▼          ▼           ▼              │
│  delegate()   plan()    fusion()    read_skill()       │
│     │            │          │           │               │
│     ▼            ▼          ▼           ▼              │
│  Subagent    PlanPanel   Multi-Model  Skill             │
│  Runner      Widget      Pipeline    Resolution        │
│     │                                                        │
│     ├── Activity Feed                                        │
│     ├── Peek Overlay                                         │
│     ├── Scope Guard                                          │
│     └── Diagnostics                                          │
└─────────────────────────────────────────────────────────┘
```

## Module Map

### Core Modules

| Module | File | Responsibility |
|--------|------|----------------|
| **Entry Point** | `index.ts` | Lifecycle hooks (`session_start`, `before_agent_start`, `tool_call`), tool guard, prompt injection |
| **Registration Hub** | `registration-hub.ts` | Centralizes all tool and command registration |
| **Delegate Tool** | `delegate-tool.ts` | Registers the `delegate` tool with render functions and parameters |
| **Delegate Pipeline** | `delegate-pipeline.ts` | End-to-end delegation: validation → scope → subagent → diagnostics → result |
| **Delegate Controller** | `delegate-controller.ts` | Per-delegation lifecycle hooks (start, finalize, error) within an active plan |
| **Delegate Feed Builder** | `delegate-feed-builder.ts` | Live activity feed during subagent run |
| **Delegate Output Formatter** | `delegate-output-formatter.ts` | Post-run output decoration (findings, audit, metrics) |
| **Subagent Runner** | `subagent-runner.ts` | Creates isolated sessions, wires activity feed/plan/peek, executes subagent |
| **Subagent Tool Guard** | `subagent-tool-guard.ts` | Enforces scope restrictions and plan-first enforcement inside subagent |
| **Subagent Diagnostics** | `subagent-diagnostics.ts` | Detects silent failures and crashes, persists to `/diagnostics/` |
| **Subagent Event Router** | `subagent-event-router.ts` | Pub/sub for subagent events |

### Scope System

| Module | File | Responsibility |
|--------|------|----------------|
| **Scope Manager** | `scope-manager.ts` | Scope normalization, read/write `.pi/scope.json`, resolve scope per delegation |
| **Scope Guard** | `scope-guard.ts` | Thin enforcement: `isPathAllowed()`, `checkFileSize()`, `requestExpansion()` |
| **Scope Policy** | `scope-policy.ts` | Per-specialist default scope policies (writer, read-only) |

### Fusion System

| Module | File | Responsibility |
|--------|------|----------------|
| **Fusion Tool** | `fusion-tool.ts` | Tool registration, request routing |
| **Fusion Pipeline** | `fusion-pipeline.ts` | Panel → judge → format orchestration |
| **Fusion Config** | `fusion-config.ts` | Load/save/validate `.pi/fusion.json` |
| **Fusion Format** | `fusion-format.ts` | Render panel responses into structured output |
| **Fusion Judge** | `fusion-judge.ts` | Synthesize panel responses via judge model |
| **Fusion Models** | `fusion-models.ts` | Auto-diverse panel model selection |
| **Fusion Utils** | `fusion-utils.ts` | Shared helpers (`extractText`, `mapWithConcurrencyLimit`) |

### Plan & Activity UI

| Module | File | Responsibility |
|--------|------|----------------|
| **Plan Panel** | `plan-panel.ts` | Goal, steps, timeline, persistence to `.pi/orchestrator-plan.json` |
| **Plan Tool** | `plan-tool.ts` | `plan`, `plan_add_steps`, `advance_plan_step`, etc. |
| **Activity Feed** | `activity-feed.ts` | Steps/substeps tracking with tool call integration |
| **Peek Overlay** | `peek-overlay.ts` | Live subagent conversation viewer |
| **Orchestrator Theme** | `orchestrator-theme.ts` | Status icons, box drawing, symbols |
| **Spinner State** | `spinner-state.ts` | Time-derived spinner frames (no mutable state) |

### Specialist & Skill System

| Module | File | Responsibility |
|--------|------|----------------|
| **Specialists** | `specialists.ts` | Specialist roster (scout, coder, reviewer, researcher, writer), prompt construction |
| **Skill Resolver** | `skill-resolver.ts` | Resolve and parse `.pi/agent/skills/<name>/SKILL.md` |
| **Read Skill Tool** | `read-skill-tool.ts` | `read_skill` tool for loading skill instructions |
| **Ask Resolver** | `ask-resolver.ts` | Decides if delegation needs ask_orchestrator flow |
| **Scout Tools** | `scout-tools.ts` | `git-read` and `gh` read-only tools for scout |

### Other

| Module | File | Responsibility |
|--------|------|----------------|
| **Bash Interceptor** | `bash-interceptor.ts` | Redirects bash commands to native tools |
| **Introspection Tools** | `introspection-tools.ts` | `list_skills`, `list_tools` discovery tools |
| **Commands** | `commands.ts` | Slash commands: `/orchestrate`, `/specialists`, `/inspect`, `/render`, `/timeline` |
| **Debug** | `debug.ts` | Debug logging to `/tmp/orchestrator-debug/` |
| **Debug Path Trace** | `debug-path-trace.ts` | Diagnostic tracing for file path handling |

## Boot Sequence

The extension boots when loaded by the SDK:

1. **Guard check** (`index.ts`): If running as subagent (`isSubagentContext()`), skip orchestrator registration
2. **`session_start` hook**: Freeze active tools for prefix-cache stability via `pi.setActiveTools()`
3. **`before_agent_start` hook**: Clear scope (`ScopeManager.clearScope()`), build orchestrator prompt (`buildOrchestratorPrompt()`)
4. **`tool_call` hook**: Guard — only allow `delegate`, `plan*`, `fusion`, `read_skill`, `list_skills`, `list_tools`, `vision_query`
5. **`registerAllTools()`**: Register all tools and commands in one call

**Critical rule:** During init (before `session_start`), only registration methods are allowed. Action methods like `getAllTools()` or `setActiveTools()` throw if called prematurely. This is verified by `init-guard.test.ts`.

## Key Design Patterns

### Fail-Closed Scope Enforcement
Missing or malformed `.pi/scope.json` blocks **all** write operations. The scope file is the single source of truth (ADR-0001, ADR-0002). Scope is cleared after every delegation and in `before_agent_start`, so stale scope never survives across turns.

### Tool-Level Gate (Not Prompt-Level)
Scope enforcement happens in `scope-guard.ts` at the tool level, not via prompt instructions. Prompt reminders decay; tool gates don't. Violations emit `ScopeExpansionRequest` for orchestrator review.

### Bash Interception
The `bash-interceptor.ts` module intercepts bash commands and redirects them to native tools (e.g., `cat` → `read`, `grep` → `grep`, `sed -i` → `edit`). This gives the orchestrator better control over tool calls and enables scope checking on what would otherwise be opaque shell commands.

### Time-Derived Spinners
`spinner-state.ts` calculates spinner frames purely from wall-clock time, eliminating mutable state. No counters, no reset logic.

### Centralized Registration, Separate Visibility
All tools are registered in one place (`registration-hub.ts`), but their visibility is controlled separately via `setActiveTools()` in the `before_agent_start` hook. This enables prefix-cache stability.

## Architectural Decisions (ADRs)

| ADR | Decision |
|-----|----------|
| **ADR-0001** | Scope enforcement via JSON file seam (`.pi/scope.json`) — writer and reader validate independently |
| **ADR-0002** | Fail-closed on malformed scope — missing/broken scope blocks all writes |
| **ADR-0003** | Researcher display improvements in activity feed |
| **ADR-0004** | Fusion tool split into 7 modules (from monolith) |
| **ADR-0005** | Delegate controller split into 5 modules |
| **ADR-0006** | Scope glob patterns via picomatch (draft) |

Full ADRs are in `/docs/adr/`.

## Filesystem Layout

```
~/.pi/agent/extensions/orchestrator/   ← canonical working copy
├── .pi/scope.json                     ← per-delegation scope (ephemeral)
├── .pi/orchestrator-plan.json         ← plan state (persists across turns)
├── .pi/fusion.json                    ← fusion config
├── diagnostics/                       ← subagent failure logs
│   └── YYYY-MM-DD/{sessionId}/
├── node_modules/                      ← SDK + picomatch
├── legacy/orchestrator.ts             ← original monolith (reference only)
└── [source files]                     ← current modular implementation
```

**Sync flow:** Edit locally → rsync to `~/pi-files/extensions/orchestrator` → commit to GitHub.
