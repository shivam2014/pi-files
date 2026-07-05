# Ubiquitous Language

## Planning

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Plan** | A declared sequence of work with one Goal and ordered Steps; lives in `PlanPanel.planState`. | Task list, workflow |
| **Goal** | One-line summary of the plan's intent; displayed as `◆ Goal` in the plan panel. | Objective, mission |
| **Step** | A single unit of work in a Plan with states: pending (`○`) → active (`⠇`) → completed (`✓`) / errored (`✗`); represented as `PlanStep` in plan-panel.ts and `Step` in activity-feed.ts. | Task, action item |
| **Substep** | An individual tool call or action within a Step; shown as spinner lines in the plan panel and feed; identified by `toolCallId` for out-of-order completion. | Subtask, child step |
| **Budget** | Hard cap (9 lines) on plan panel widget height; enforced by `trimToBudget()` which preserves the goal line, progress dots, and active step. | Limit, max lines |

## Delegation

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Subagent** | A spawned specialist agent that executes one delegated task in its own session with restricted tools. | Child agent, worker |
| **Specialist** | A named role with a fixed tool set: Scout (read-only investigator), Coder (implementer), Reviewer (code reviewer), Researcher (web researcher), Writer (documentation), Judge (fusion analysis). | Role, agent type |
| **Scope** | File/directory constraints for a delegation; written to `.pi/scope.json` and enforced by ScopeGuard; has `filesToModify`, `filesToCreate`, `boundaries`, `maxFiles`, `maxLinesPerFile`. | Boundary, permission set |
| **Delegation** | The act of handing a task to a specialist subagent with lifecycle: start → (substeps) → finalize/error. | Assignment, handoff |
| **Ask-orchestrator** | A subagent → orchestrator signal requesting human input or scope expansion; resolved by AskResolver. | Escalation, help request |

## Three-Layer Visibility System

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Plan Panel** (Layer 1) | TUI widget showing the plan goal + step list within a 9-line budget; updated every 80ms/1000ms via timers. | Status widget, progress bar |
| **Activity Feed** (Layer 2) | Chat blocks showing subagent tool calls, output, and spinners; full history visible; state machine with `ActivityFeedState`. | Log, output feed |
| **Conversation Viewer / Peek** (Layer 3) | `Ctrl+Q` overlay showing the subagent's live conversation (thinking, tool calls, results); managed by `PeekSession` class. | Deep view, inspector |
| **Widget** | TUI render target created by `ctx.ui.setWidget(key, content[])`; the plan panel key is `"orchestrator-status"`. | UI component, panel |

## State Concepts

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **PlanState** | Internal state of a Plan on PlanPanel: `{ goal, steps: PlanStep[], startTime, sessionId }`; persisted to `.pi/orchestrator-plan.json`. | Plan data, plan snapshot |
| **ActivityFeedState** | State machine for one subagent's feed: `{ goal, steps: Step[], currentStep, planParsed, errored, errorMessage, retryCount, retryReason }`. | Feed state, subagent state |
| **Session** | A plan-to-completion lifecycle scoped by `sessionId` (timestamp + random string); PlanPanel instances keyed by session in `_instances` Map. | Run, invocation |
| **Timeline** | Debug ring buffer (500 frames) of state snapshots on PlanPanel containing timestamps, events, renders, and feed states; dumped to disk on `clearPlanPanel`. | History buffer, debug log |
| **overflowCount** | Counter tracking how many substeps were truncated from display beyond `MAX_FEED_SUBSTEPS=8`; shown as `… +N more`. | Truncation count, hidden count |

## Guard Mechanisms (Layer 0)

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **ScopeGuard** | Path-restricted write enforcer that reads `.pi/scope.json` raw; blocks unauthorized file access and emits `ScopeExpansionRequest` for expandable boundaries; fail-closed. | Security guard, file guard |
| **Lint Guard** | Deterministic post-edit linter that is cache-safe; auto-detects linter from project config (14 linters, 7 languages); blocks on failure. | Lint check, quality gate |
| **Token Saver** | Token reduction system that truncates long tool outputs, summarizes goals, and budget-constrains the plan panel; `/caveman` command enables ultra-terse mode. | Token optimizer, cost reducer |

## Domain Modules

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **ScopeManager** | Owns the Scope concept; writes/reads/clears `.pi/scope.json`; normalizes ScopeManifest to ResolvedScope; clears after every delegation. | Scope handler |
| **DelegateController** | Drives start/finalize/error hooks for one delegation inside an active plan. | Delegation runner |
| **DelegateFeedBuilder** | Builds the live activity feed during subagent runs from reportFinding, ask_orchestrator, and spinner events. | Feed constructor |
| **DelegateOutputFormatter** | Post-processes subagent results into formatted Findings/Audit/Metrics blocks. | Result formatter |
| **BashInterceptor** | Converts user-typed bash commands into equivalent orchestration tool calls. | Command interceptor |
| **SubagentToolGuard** | Allows/denies tools per specialist and enforces planSteps-first ordering. | Tool filter |
| **PromptBuilder** | Builds the orchestrator system prompt from templates. | Prompt generator |
| **SubagentEventRouter** | Pub/sub event dispatcher where UI modules self-register per event type; no direct UI imports. | Event bus |
| **AskResolver** | Decides if a delegation requires an `ask_orchestrator` interaction based on scope completeness. | Escalation handler |
| **RegistrationHub** | Wires tools, commands, and handlers into the extension lifecycle. | Plugin registry |

## Relationships

- A **Plan** has one **Goal** and multiple ordered **Steps**.
- A **Step** has zero or more **Substeps**.
- A **Subagent** runs one **Delegation** per active **Step**.
- A **Subagent** is assigned a **Specialist** role.
- A **Specialist** has a fixed **Scope** boundary.
- The **ScopeGuard** enforces **Scope**; the **Lint Guard** enforces code quality.
- The **Plan Panel** (Layer 1) is the condensed view; the **Activity Feed** (Layer 2) is the full history.
- The **Conversation Viewer** / **Peek** (Layer 3) provides depth into the **Subagent**'s real-time conversation.
- **ScopeGuard** and **Token Saver** are Layer 0 — they run before, during, and after all other layers.
- A **Delegation** is routed through the **SubagentEventRouter** to registered UI modules.
- The **DelegateController** manages delegation lifecycle while the **DelegateFeedBuilder** populates the feed.
- **ScopeManager** clears after each **Delegation** to prevent scope bleed between steps.

## Example dialogue

> **Dev:** "I delegated the refactor to the Coder specialist and gave it scope over `src/auth/`. But the plan panel only shows one step — it disappeared after the first file edit. Did it fail?"
>
> **Domain expert:** "No — look at the Activity Feed (Layer 2). The plan panel (Layer 1) is budget-constrained to 9 lines. The `trimToBudget()` algorithm preserved the goal and active step line but collapsed the older completed step. Scroll the feed to see all tool calls the subagent made."
>
> **Dev:** "I see the edits in the feed, but the subagent is asking for something — there's a `?` indicator next to the step. What's happening?"
>
> **Domain expert:** "That's an Ask-orchestrator signal. The Coder hit the scope boundary — it tried to modify `src/config/defaults.go` which is outside the `src/auth/` scope you set. The ScopeGuard blocked it and emitted a ScopeExpansionRequest. The AskResolver is now waiting for you to approve or deny the expansion."
>
> **Dev:** "I'll approve it. Let me hit Ctrl+Q to peek into the subagent's conversation first and see what it was about to write before it got blocked."

## Flagged ambiguities

1. **`completePlanStep` vs `finalizePlanStep`** — PAN-010: two methods doing the same thing. One should be removed; both are still called in different code paths.
2. **`OrchestratorStep` vs `PlanStep` vs `Step`** — Three names for the step concept depending on context: `OrchestratorStep` in legacy code, `PlanStep` in the plan panel, `Step` in the activity feed. These should converge into one canonical term.
3. **Session** — Used for both orchestrator-agent sessions and TUI widget sessions; these have different lifetimes and should not share the same term.
4. **`planParsed` on ActivityFeedState** — Refers to the subagent calling the `planSteps()` tool, not to the orchestrator's Plan. This naming can confuse readers into thinking it tracks whether the orchestrator parsed its own plan.
