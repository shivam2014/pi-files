# Plan & Activity UI

The orchestrator provides three layers of real-time visibility into subagent work:

1. **Plan Panel** — Structured goal → steps → progress tracking
2. **Activity Feed** — Real-time tool call and substep tracking
3. **Peek Overlay** — Live subagent conversation viewer

## Plan Panel

`plan-panel.ts` manages a structured plan with goal, steps, and timeline.

### Structure

```typescript
{
  goal: string,           // High-level goal description
  steps: PlanStep[],      // Ordered list of steps
  sessionId: string,      // Bound to orchestrator session
  timeline: TimelineEntry[]
}
```

Each `PlanStep` has:
- `kind`: `"delegation"` or `"orchestrator"`
- `description`: What this step does
- `status`: Current status (pending, active, completed, failed)

### Persistence

Plan state persists to `.pi/orchestrator-plan.json`, surviving across turns within a session. One instance per orchestrator session — multiple pi instances may run concurrently, so PlanPanel must be scoped to a single session.

### Tools

| Tool | Purpose |
|------|---------|
| `plan` | Create or update the plan goal |
| `plan_add_steps` | Add new steps to the plan |
| `insert_step` | Insert a step at a specific position |
| `advance_plan_step` | Move to the next step |
| `modify_step` | Update step description or status |
| `remove_step` | Remove a step |

### Auto-Creation

If no plan exists when a delegation starts, `delegate-pipeline.ts` auto-creates a minimal plan with the delegation task as the goal.

## Activity Feed

`activity-feed.ts` tracks subagent progress in real time.

### Structure

```
┌─ Step 1: Investigate auth system ──────────────┐
│  ├─ grep "auth" src/                           │
│  ├─ read src/auth/login.ts                     │
│  └─ reportFinding: Found 3 auth modules        │
├─ Step 2: Add logging ──────────────────────────┤
│  ├─ edit src/auth/login.ts                     │
│  └─ edit src/auth/middleware.ts                │
└────────────────────────────────────────────────┘
```

### Integration Points

- **Tool calls**: `toolCallToSubstep()` converts tool calls to human-readable labels
- **Reporting**: Subagents use `reportFinding()` to add findings
- **Spinner**: Time-derived frames from `spinner-state.ts`
- **Box drawing**: Symbols from `orchestrator-theme.ts`

### Delegate Feed Builder

`delegate-feed-builder.ts` wraps the activity feed for delegation context:
- Handles `reportFinding` updates
- Manages `ask_orchestrator` prompts
- Updates spinner and plan-panel detail lines
- Keeps parent orchestrator informed without waiting for subagent return

## Peek Overlay

`peek-overlay.ts` provides a live subagent conversation viewer.

### Features

- Streaming text display
- Real-time tool call visualization
- Conversation history

### Postmortem

A flickering bug was analyzed in `/docs/peek-overlay-flickering-postmortem.md`. The root cause was related to rapid state updates. See the postmortem for details.

## How They Connect

```
Subagent Runner
    │
    ├── Activity Feed ←── tool calls, findings, substeps
    │       │
    │       ├── Plan Panel ←── step progress, detail lines
    │       │
    │       └── Peek Overlay ←── conversation stream
    │
    └── Delegate Feed Builder ←── wraps all three
```

## What to Watch Out For

- **Session scoping**: PlanPanel is scoped to one orchestrator session. Multiple concurrent pi instances each get their own PlanPanel.
- **Persistence format**: `.pi/orchestrator-plan.json` is the persistence layer. Changes to plan structure require migration considerations.
- **Activity feed is live**: Updates happen during subagent execution, not after. Race conditions are possible.
- **Spinner state is time-derived**: No mutable counter. Frame is calculated from `Date.now()`. Don't add mutable state to spinner.
- **Theme symbols**: All UI symbols come from `orchestrator-theme.ts`. Don't hardcode symbols elsewhere.
