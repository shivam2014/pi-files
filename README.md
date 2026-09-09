# pi-files

Custom extensions, skills, and configuration for the [pi coding agent](https://github.com/earendil-works/pi). The primary deliverable here is the **orchestrator extension** — a manager-worker delegation system that turns a single AI agent into a multi-agent workflow with deterministic guardrails.

## Directory Map

```
pi-files/
├── extensions/
│   ├── orchestrator/          # Multi-agent orchestrator (dev copy, full commit history)
│   ├── token-saver.ts         # Token compression & caveman mode
│   ├── lint-guard.ts          # Auto-lint after edits (14 linters, 7 languages)
│   ├── scope-guard.ts         # Tool-level write scope enforcement
│   ├── vision-router.ts       # Vision model routing
│   ├── herdr-agent-state.ts   # Agent state management
│   └── local-latex/           # Local LaTeX compilation
├── skills/                    # Shared agent skills (i-have-adhd, loop-until, writing-x-posts)
├── docs/                      # Repository-level docs (plan-panel-spec)
├── nyro-sync/                 # Nyro model sync plugin
├── .vibe-orch/                # Vibe orchestration config
├── AGENTS.md                  # Agent feedback protocol
└── tui-smoke.sh              # TUI smoke test runner
```

## Architecture: Manager-Worker Delegation

The orchestrator follows a **deterministic guardrail workflow**. The orchestrator holds global context (decomposition, sequencing, verification strategy) and delegates focused tasks to subagents. Model selection is configurable — the current fusion/plan-panel default is the cheap, fast `deepseek-v4-flash-2` (per `FUSION-SPEC`), and model choices are not limited to a single cost tier. The orchestrator never reads source files directly — it receives structured findings (5–10 lines of context) and delegates again.

```
User request → Orchestrator (plan + delegate)
                    ├── Scout    (read-only investigation)
                    ├── Coder    (read/write implementation)
                    ├── Reviewer (read-only review + bash diagnostics)
                    ├── Researcher (web search + doc reading)
                    └── Writer   (read/write documentation)
                         ↑
               Deterministic guards (lint, scope, token-saver)
```

Each specialist owns its own tools, skills, system prompt, and deterministic checks. A weak model cannot wreck the workflow; a strong model is never second-guessed.

### Specialists

| Specialist | Role | Tools | Read-Only | Default Skills |
|------------|------|-------|-----------|----------------|
| **Scout** | Codebase investigation, architecture discovery | `read`, `grep`, `find`, `ls`, `git-read`, `gh` | ✅ | `diagnosing-bugs` |
| **Coder** | Feature implementation, bug fixes | `read`, `bash`, `edit`, `write`, `grep`, `lint`, `find`, `ls` | ❌ | `implement`, `tdd` |
| **Reviewer** | Code review, bash diagnostics (curl, ports, CLIs) | `read`, `bash`, `grep` | ✅ | `code-review` |
| **Researcher** | Web research, doc gathering, evidence-based answers | `read`, `web_search`, `fetch_content`, `ls`, `grep`, `git-read`, `gh`, `find` | ✅ | `domain-modeling` |
| **Writer** | README, API docs, project documentation | `read`, `write`, `edit`, `ls`, `find`, `git-read` | ❌ | `agents-md-writer` |

### Delegation Workflow

1. Orchestrator calls `delegate(specialist, task, scope?)` with an optional scope object
2. ScopeManager writes `.pi/scope.json`; ScopeGuard enforces it at tool-call level
3. Subagent spawns fresh (stateless), runs with its specialist tools
4. Subagent uses `planSteps()` → `advanceStep()` to track its own sub-work
5. On return: findings, audit, and flight-recorder JSON are captured
6. Orchestrator synthesizes results, updates plan, delegates next step

## Visibility Layers

| Layer | Component | What It Shows |
|-------|-----------|---------------|
| **Layer 0 — Enforcement** | `lint-guard`, `scope-guard`, `token-saver` | Transparent guards — subagents never see them |
| **Layer 1 — Plan Panel** | `plan-panel.ts` | Goal + step list (9-line budget, spinner icons) |
| **Layer 2 — Activity Feed** | `activity-feed.ts` | Live subagent tool calls, substeps, spinners |
| **Layer 3 — Peek Overlay** | `peek-overlay.ts` | `Ctrl+Q` overlay showing live subagent conversation |

## Deterministic Guards

| Guard | What It Does | Cache Safety |
|-------|-------------|-------------|
| **lint-guard** | Auto-runs linter after every `edit`/`write`. Detects linter from project config. Skips non-code files. | Results via `pi.sendMessage()` — no tool-output mutation |
| **scope-guard** | Blocks writes outside `.pi/scope.json` paths. Fail-closed on malformed files (ADR-0002). | Pure read-only filesystem check — no write-side effects |
| **token-saver** | 5-layer compression: terse mode, read dedup, ANSI strip, per-tool budgets, blank collapse | Deterministic output for identical input |

## Fusion: Panel → Judge Flow

Optional multi-model analysis for high-cost decisions. Enabled via `.pi/fusion.json`.

1. **Panel phase** — 2–3 models run in parallel (concurrency cap: 2), each providing independent feedback
2. **Judge phase** — strongest available model synthesizes panel responses into structured JSON: consensus, contradictions, blind spots, recommendations
3. **Temperature fallback** — if a provider rejects temperature, retries at default (cached per session)

Per [OpenRouter Fusion research](https://openrouter.ai/blog/announcements/fusion-beats-frontier): quality preset achieves **69.0% DRACO** (Fable 5 + GPT-5.5 panel, Opus 4.8 judge); budget preset achieves **64.7% at ~half cost**; self-fusion yields **+6.7pt lift** (65.5% vs 58.8% solo) — ~75% of improvement comes from judge synthesis.

## Loop Engine

The `loop_until` mechanism supports iterative refinement with objective metrics:

- **Metric abstraction** — shell command → number, with `higher-better` / `lower-better` / `exit-code` modes
- **Trajectory classifier** — classifies metric history as CONVERGING / STALLING / OSCILLATING / DIVERGING
- **Best-so-far rollback** — returns the best iteration, never the last
- **Budget governor** — token budget with operational vs evaluation split
- **Fresh context** — each iteration spawns a new worker session with history handoff

## Diagnostics & Flight Recorder

Every delegation produces a structured JSON record at `~/.pi/agent/extensions/orchestrator/diagnostics/YYYY-MM-DD/{sessionId}/incident-*.json`:

- Full tool call trail (name, input, output capped at 50KB, duration)
- Blocked/redirected calls with reasons
- Token totals (input, output, cacheRead, cacheWrite)
- Plan-step durations and final status

Diagnostics fire on: zero-tool-call failures, tool errors (`isError=true`), and blocked calls. The `loop-watchdog` monitors event-loop lag (250ms interval, 250ms threshold).

## Skill Ecosystem

Skills are Markdown files loaded at delegation time via `read_skill(name)`. The orchestrator merges default skills per specialist with overrides, deduplicating automatically.

```
~/.pi/agent/skills/<name>/SKILL.md    # Installed skills
pi-files/skills/                       # Shared skills in this repo
```

Skills can chain: a skill can reference another skill internally. The `read_skill` tool is path-sandboxed — directory traversal via `../` is blocked.

## Benchmarks & Cost

> **Caveat:** No reproducible local cost/token benchmark is currently recorded. Numbers below are estimates from design targets, external research, or logged test baselines — not controlled measurements.

| Metric | Value | Provenance |
|--------|-------|-----------|
| Test baseline | 841 passed / 54 files | `MASTER-PLAN-LOG` Session 2 (latest logged full-suite run) |
| DRACO (quality preset) | 69.0% | OpenRouter Fusion research (external) |
| DRACO (budget preset) | 64.7% | OpenRouter Fusion research (external) |
| DRACO (self-fusion lift) | +6.7pt (58.8% → 65.5%) | OpenRouter Fusion research (external) |
| Fusion cost per invocation | ~$0.008 | Design estimate (budget panel + judge) |
| Token-saver reduction | ~90–98% | Design estimate (compressed vs raw tool output) |
| lint-guard latency | <5s | Design target (10s hard timeout per file) |
| Plan panel budget | 9 lines max | Hard cap, `SPEC-UI.md` |
| Flight recorder coverage | ≥90% of feed-visible events | Design target |

## Setup

Clone and symlink into `~/.pi/`:

```bash
git clone https://github.com/shivam2014/pi-files.git ~/pi-files
ln -s ~/pi-files/extensions ~/.pi/agent/extensions
```

Or for the orchestrator dev copy specifically:

```bash
rsync -av ~/pi-files/extensions/orchestrator/ ~/.pi/agent/extensions/orchestrator/
```

Both symlink and rsync/copy installs are supported — either works for keeping `~/.pi/` up to date.

### Running Tests

```bash
cd ~/pi-files/extensions/orchestrator
npx vitest run              # Unit tests
bash ~/pi-files/tui-smoke.sh pi "create /tmp/test.txt with content hello"
```

## Key Documentation

| Document | Path | Purpose |
|----------|------|---------|
| Vision & Doctrine | `extensions/orchestrator/docs/VISION.md` | Architecture principles, visibility layers, design constraints |
| Master Plan | `extensions/orchestrator/docs/MASTER-PLAN.md` | Ticket-level execution plan with acceptance criteria |
| Master Plan Log | `extensions/orchestrator/docs/MASTER-PLAN-LOG.md` | Per-session results, gate outcomes, friction notes |
| Domain Glossary | `extensions/orchestrator/CONTEXT.md` | Canonical terminology and anti-patterns |
| Plan Panel Spec | `docs/plan-panel-spec.md` | Step kind model, double-advance prevention |
| Fusion Spec | `extensions/orchestrator/docs/specs/FUSION-SPEC.md` | Panel→judge pipeline, model selection, DRACO benchmarks |
| Lint Spec | `extensions/orchestrator/docs/specs/LINT-SPEC.md` | Auto-lint guard behavior, linter detection, timeouts |
| Bash/Token-Saver Spec | `extensions/orchestrator/docs/specs/BASH-TOKEN-SAVER-SPEC.md` | Bash token budget & compression rules |
| UI Spec | `extensions/orchestrator/docs/specs/SPEC-UI.md` | 3-layer rendering specification |

### ADRs

| ADR | Decision |
|-----|----------|
| [0001](extensions/orchestrator/docs/adr/0001-scope-enforcement-json-seam.md) | Scope enforcement via JSON file seam (zero coupling) |
| [0002](extensions/orchestrator/docs/adr/0002-scope-file-fail-closed.md) | Malformed scope files → block all writes |
| [0003](extensions/orchestrator/docs/adr/0003-activity-feed-researcher-display.md) | Researcher tool display formatting |
| [0004](extensions/orchestrator/docs/adr/0004-fusion-tool-split.md) | Fusion module decomposition (7 modules) |
| [0005](extensions/orchestrator/docs/adr/0005-delegate-controller-split.md) | DelegateController lifecycle separation |
| [0006](extensions/orchestrator/docs/adr/0006-scope-glob-patterns.md) | Glob patterns in scope enforcement |
