# orchestrator

**One agent becomes a team.** The orchestrator holds the plan and delegates work to specialist subagents. It never reads source files directly — scouts return short findings, the orchestrator decides, coders do the reading and editing. This keeps the expensive model's context clean and pushes the token-heavy work onto cheaper models.

## The specialists

| Specialist | Role | Access | Default skills |
|------------|------|--------|----------------|
| scout | Reads and maps code | read-only | diagnosing-bugs |
| coder | Writes and edits files | read + write | implement, tdd |
| reviewer | Verifies changes, runs bash diagnostics | read-only + bash | code-review |
| researcher | Searches docs and web | read-only + web | domain-modeling |
| writer | Writes documentation | read + write | agents-md-writer |

## Architecture

```
orchestrator (plans, decides, verifies)
   ├─ scout      → reads and maps code      (read-only)
   ├─ coder      → writes and edits         (read + write)
   ├─ reviewer   → verifies the change      (read-only + bash)
   ├─ researcher → searches docs and web
   └─ writer     → writes documentation
```

The entry point (`index.ts`) is a wiring hub: it registers the `delegate` tool, the plan tools, and the commands; injects the orchestrator system prompt; freezes the active tool set at `session_start` for prefix-cache stability; and skips its own handlers when it is loaded inside a subagent.

## What it does

- **Plans then delegates.** Every task starts with a plan. Each step is one delegation or one orchestrator-owned action.
- **Adaptive escalation.** Trivial tasks run as a single coder; harder ones escalate. Workers self-report a `## Difficulty` block (exploration / uncertainty / verification / iteration / recommend) and the orchestrator scales routing to it.
- **Hard exploration budget.** A worker that crosses 6 exploration calls, 5 files, or 12 turns must escalate via `ask_orchestrator` rather than quietly burn minutes. The budget is counted by the framework, not self-reported.
- **Plan panel.** A live TUI widget showing the plan, each step, and subagent progress.
- **Fusion.** `fusion()` runs a panel of models plus a judge to critique a plan before expensive work begins. Disabled unless configured.
- **Guards.** `scope-guard` blocks out-of-scope writes at the tool level; `lint-guard` auto-lints every edit after it lands. Both are deterministic (no LLM).

## Tools

Registers `delegate` (dispatch to a specialist), the plan tools (`plan`, `advance_plan_step`, `plan_add_steps`, and friends), `fusion` (when enabled), `read_skill`, `list_skills`, `list_tools`, `vision_query`, and `interactive_shell`.

## Configuration

- `~/.pi/agent/orchestrator.yml` — orchestrator config (for example `delegation.mode`).
- `.pi/fusion.json` (project) or `~/.pi/agent/fusion.json` (global) — fusion panel and judge models. Fusion stays disabled unless configured and enabled.

## Docs

- [`docs/`](docs/) — specs, ADRs, PRDs, master plan
- [`CONTEXT.md`](CONTEXT.md) — domain glossary
- [`docs/VISION.md`](docs/VISION.md)
- [`docs/MASTER-PLAN.md`](docs/MASTER-PLAN.md)
