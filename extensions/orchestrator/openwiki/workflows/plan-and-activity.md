# Plan & Activity System

The plan and activity system provides multi-layered progress visibility for orchestrator operations.

## Plan Panel (Layer 1)

**File**: `/plan-panel.ts`

### State Model

```typescript
interface PlanStep {
  label: string;
  completed: boolean;
  active: boolean;
  errored?: boolean;
  errorMessage?: string;
  detail?: string;          // Current subagent output snippet
  detailLines?: string[];   // Multi-line detail
  startTime?: number;
  endTime?: number;
  kind?: 'delegation' | 'orchestrator' | 'loop_until';
}
```

The plan state is: `{ goal, steps: PlanStep[], startTime, sessionId }`.

### Instance Management

- Module-scoped `Map<string, PlanPanel>` keyed by `sessionId`
- Six "lifecycle boundary" proxy functions create instances via `_resolveOrCreate(ctx)`
- 17 other proxy functions look up existing instances via `resolvePlanPanel(ctx)`
- Instances cleaned up on session end

### Rendering

The plan panel renders as a 9-line budget TUI widget via `pi.setStatus("orchestrator-status", content)`:
- Line 1: Goal + elapsed time
- Lines 2-N: Step list with status icons
- Spinner animation during active work
- Active delegation count

### Plan Tools

**File**: `/plan-tool.ts`

| Tool | Description |
|------|-------------|
| `plan(goal, steps)` | Create/replace the plan |
| `plan_add_steps(steps)` | Append steps to existing plan |
| `advance_plan_step()` | Mark current step complete |
| `insert_step(index, step)` | Insert a step at position |
| `remove_step(index)` | Remove a step |
| `modify_step(index, updates)` | Update a step's properties |

### Timeline

The plan panel maintains a timeline of events (max 500 frames). Each frame captures:
- Timestamp, event name, rendered output
- State snapshot, feed state, feed render

Timeline is flushed to disk on `agent_end`.

### Loop Until Step Kind

Steps with `kind: 'loop_until'` activate the orchestrator's built-in loop mode. The orchestrator IS the loop — no separate controller module.

#### Loop Lifecycle Methods (in `plan-panel.ts`)

| Method | Description |
|--------|-------------|
| `initLoopState()` | Initialize `LoopUntilState` for a step |
| `runLoopIteration()` | Execute one iteration |
| `evaluateLoopCriterion()` | Check if success criterion is met |
| `updateRollingSummary()` | Maintain structured iteration history |
| `detectStall()` | Detect diminishing returns |
| `composeFeedback()` | Generate feedback for next iteration |
| `completeLoopStep()` | Finalize loop step on completion |

#### Creating Loop Steps

```typescript
plan("Improve test coverage", [
  { label: "Loop: reach 90% coverage", kind: "loop_until", loopUntil: { ... } }
])
```

The `loopUntil` field contains a `LoopUntilConfig` with criterion, evaluation mode, max iterations, and optional specialist.

#### Algorithm Changes

- `clearPlanIfComplete()` — preserves timers when a loop step is active
- `before_agent_start` — preserves plan panel during active loops
- Widget rendering — loop steps show `⟳` prefix in the plan panel

### Loop Lifecycle

```
setup → iterate → evaluate → feedback → repeat
```

1. **Setup**: `initLoopState()` creates state with config, history, rolling summary
2. **Iterate**: `runLoopIteration()` runs one pass
3. **Evaluate**: `evaluateLoopCriterion()` checks success (binary/scored/checklist/custom)
4. **Feedback**: `composeFeedback()` generates structured feedback for next iteration
5. **Repeat** until criterion met or hard stop (max iterations, stall detection)

## Activity Feed (Layer 2)

**File**: `/activity-feed.ts`

### State Model

```typescript
interface ActivityFeedState {
  goal: string;
  steps: Step[];
  currentStep: number;
  rawText: string;
  planParsed: boolean;    // true after planSteps() tool called
  errored?: boolean;
  errorMessage?: string;
  retryCount?: number;    // Tracks retry attempts
  retryReason?: string;   // Reason for last retry
}

interface Step {
  label: string;
  completed: boolean;
  substeps: Substep[];    // Individual tool calls
  startTime?: number;
  endTime?: number;
  overflowCount?: number; // Tracks when substeps exceed max visible
}

interface Substep {
  toolCallId?: string;
  label: string;
  completed: boolean;
  outputPreview?: string;
  isReport?: boolean;
  errored?: boolean;
  toolDetail?: string;
}
```

### How It Works

1. Subagent calls `planSteps(goal, steps)` → feed state initialized, `planParsed = true`
2. Each tool call automatically becomes a substep under the current step
3. Subagent calls `advanceStep()` → step marked complete, advances to next
4. Subagent calls `reportFinding(finding)` → report substep added
5. Rendering uses box-drawing characters, progress dots, spinner animation

### Rendering Details

- Box inner width: 52 characters
- Max visible substeps per step: 8
- Max render retries on state change: 3
- Output compression: ANSI stripping, blank line collapse

## Peek Overlay (Layer 3)

**File**: `/peek-overlay.ts`

Activated by Ctrl+Q (mnemonic: "quick peek"). Shows the live subagent conversation in a right-aligned overlay.

### Features

- Auto-scrolling conversation messages
- Streaming text output from the subagent
- ~50 line cap (`MAX_PEEK_LINES`)
- Escape to close
- Double-press `x` to abort the running subagent
- Minimum height: 15 lines (`MIN_HEIGHT`)

### State Management

Peek state is managed by functions in `peek-overlay.ts`:
- `setViewerSession()` — set which subagent session to view
- `updatePeek()` — update conversation messages
- `setViewerOutput()` — update output content
- `setViewerError()` — show error state
- `pushStreamingText()` — append streaming text
- `clearViewerState()` — reset on delegation end

## Interaction Between Layers

```
Plan Panel (Layer 1)        Activity Feed (Layer 2)       Peek Overlay (Layer 3)
┌─────────────────┐         ┌──────────────────────┐      ┌──────────────────┐
│ Goal: Fix auth   │         │ ▶ Find auth files     │      │ Orchestrator:    │
│ ✅ Plan created  │         │   read src/auth.ts    │      │ Investigate auth │
│ ▶ Investigate    │ ◄────── │   grep "token" src/   │      │                  │
│ ○ Implement fix  │         │   ✓ Found 3 files     │      │ Scout:           │
│ ○ Test           │         │ ▶ Read and analyze    │      │ Planning...      │
│                  │         │   read src/auth/...   │      │ Found JWT issue  │
└─────────────────┘         └──────────────────────┘      └──────────────────┘
 Always visible              Updates during delegation     Ctrl+Q to toggle
```

- Plan Panel shows overall progress across all delegations
- Activity Feed shows one delegation's detailed tool calls
- Peek Overlay shows the raw conversation for deep inspection
