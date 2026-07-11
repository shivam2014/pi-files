# Type Reference

Comprehensive reference for all exported types from `/types.ts`.

## Core Orchestration Types

### OrchestratorStep

```typescript
interface OrchestratorStep {
  label: string;
  completed: boolean;
  active: boolean;
  errored?: boolean;
  errorMessage?: string;
  detail?: string;
  detailLines?: string[];
  startTime?: number;
  endTime?: number;
  kind?: StepKind;
}
```

Represents a single step in the orchestrator's plan. Used by PlanPanel (Layer 1).

### OrchestratorActivity

```typescript
interface OrchestratorActivity {
  goal: string;
  steps: OrchestratorStep[];
  startTime: number;
  sessionId: string;
}
```

Top-level plan state for the orchestrator.

### Step

```typescript
interface Step {
  label: string;
  completed: boolean;
  substeps: Substep[];
  startTime?: number;
  endTime?: number;
  overflowCount?: number;
}
```

Activity feed step (Layer 2). Contains substeps (individual tool calls).

### Substep

```typescript
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

Individual tool call within a step.

### ActivityFeedState

```typescript
interface ActivityFeedState {
  goal: string;
  steps: Step[];
  currentStep: number;
  rawText: string;
  planParsed: boolean;
  errored?: boolean;
  errorMessage?: string;
  retryCount?: number;
  retryReason?: string;
}
```

Full activity feed state machine. Initialized by `planSteps()` tool, driven by `advanceStep()`.

## Specialist Types

### Specialist

```typescript
interface Specialist {
  name: string;
  tools: string[];
  suggestedSkills?: string[];
  systemPrompt: string;
  model?: string;
  routingLabel?: string;
}
```

Defines a specialist role with its tool access, skills, and system prompt.

### SubagentContext

Context passed to subagent creation, including specialist info and task details.

## Plan Types

### StepKind

```typescript
type StepKind = 'delegation' | 'orchestrator' | 'loop_until';
```

Discriminator for step origin — whether the step was created by a delegation or by the orchestrator directly.

### PlanStep

```typescript
interface PlanStep {
  label: string;
  completed: boolean;
  active: boolean;
  errored?: boolean;
  errorMessage?: string;
  detail?: string;
  detailLines?: string[];
  startTime?: number;
  endTime?: number;
  kind?: StepKind;
}
```

Plan panel step type (Layer 1). Alias/re-export of `OrchestratorStep` with `StepKind`.

## Metrics Types

### DelegationMetrics

Tracks tool call counts and scope violations during a delegation:

```typescript
interface DelegationMetrics {
  read: number;
  grep: number;
  find: number;
  edit: number;
  write: number;
  bash: number;
  ls: number;
  scopeViolations: number;
}
```

### formatMetricsLine()

```typescript
function formatMetricsLine(metrics: DelegationMetrics): string;
```

Formats metrics into a compact string for display (e.g., "r:5 g:3 e:2 w:1").

## Fusion Types

### FusionConfig

```typescript
interface FusionConfig {
  enabled?: boolean;
  panel?: string[];
  judge?: string;
  maxPanelModels?: number;
  temperature?: number;
  maxTokensPerPanel?: number;
  maxTokensForJudge?: number;
}
```

Configuration for the fusion subsystem. Loaded from `.pi/fusion.json`.

### FusionAnalysis

```typescript
interface FusionAnalysis {
  consensus: string[];
  contradictions: Array<{
    topic: string;
    stances: Array<{ model: string; stance: string }>;
  }>;
  unique_insights: Array<{ model: string; insight: string }>;
  blind_spots: string[];
  recommendations: string[];
}
```

Structured output from the judge model after panel synthesis.

### FusionResult

```typescript
interface FusionResult {
  status: 'ok' | 'error' | 'single' | 'disabled' | 'no_judge';
  analysis?: FusionAnalysis;
  panelResponses?: Array<{ model: string; content: string }>;
  error?: string;
}
```

Full result of a fusion invocation, including status and optional analysis.

## Loop Types

### LoopUntilConfig

User-provided loop configuration. Passed as part of a `loop_until` step input.

```typescript
interface LoopUntilConfig {
  criterion: LoopCriterion;
  evaluationMode: 'single-pass' | 'satisficing';
  maxIterations?: number;
  specialist?: string;
  initialTask?: string;
}
```

### LoopCriterion

```typescript
interface LoopCriterion {
  type: 'binary' | 'scored' | 'checklist' | 'custom';
  threshold?: number;      // For scored: target score
  items?: string[];        // For checklist: required items
  evaluate?: string;       // For custom: evaluation prompt
}
```

### LoopUntilState

Transient runtime state for an active loop. Not persisted — rebuilt from iteration history if needed.

```typescript
interface LoopUntilState {
  config: LoopUntilConfig;
  iterations: LoopIteration[];
  currentIteration: number;
  rollingSummary: LoopRollingSummary;
  completed: boolean;
  stallDetected: boolean;
}
```

### LoopIteration

Per-iteration record. Captures what happened, what was evaluated, and the feedback generated.

```typescript
interface LoopIteration {
  index: number;
  task: string;
  result?: string;
  evaluation?: LoopEvaluation;
  feedback?: string;
  elapsedMs: number;
  timestamp: number;
}
```

### LoopEvaluation

```typescript
interface LoopEvaluation {
  passed: boolean;
  score?: number;
  checklistResults?: Array<{ item: string; met: boolean }>;
  summary: string;
}
```

### LoopRollingSummary

Structured facts + recent narrative summary. Prevents context bloat across iterations.

```typescript
interface LoopRollingSummary {
  facts: string[];         // Accumulated key facts across iterations
  recentNarrative: string; // Narrative of last N iterations
  iterationCount: number;
}
```

### LoopUntilStepInput

Structured input for the `plan()` tool when creating a loop step.

```typescript
interface LoopUntilStepInput {
  label: string;
  kind: 'loop_until';
  loopUntil: LoopUntilConfig;
}
```

## Context Types

### DelegateControllerContext

Context for delegation controller operations, including UI, session, and cwd.

### SessionContext

```typescript
interface SessionContext {
  sessionId: string;
  cwd: string;
  mode?: string;
}
```

Minimal session info for plan panel and activity feed operations.

### ReadonlySessionManager

Read-only interface for session management operations.

## Diagnostics Types

### SubagentDiagnostic

```typescript
interface SubagentDiagnostic {
  schemaVersion: number;
  sessionId: string;
  timestamp: number;
  specialist: string;
  task: string;
  turns: number;
  toolCalls: number;
  elapsedMs: number;
  crashed: boolean;
  outputPreview: string;
  metrics: DelegationMetrics;
  diagnosticId: string;
  kind: 'silent_failure' | 'crash';
}
```

Diagnostic snapshot captured after each delegation. Written to `/diagnostics/<date>/`.

## Skill Types

### ReadSkillParams

```typescript
interface ReadSkillParams {
  name: string;
}
```

Parameters for the `read_skill()` tool.

### MinimalModelRegistry

Registry interface for model resolution in fusion and other subsystems.

## Key Source Files

| File | Role |
|------|------|
| `/types.ts` | All shared type definitions |
| `/domain/types.md` | This reference page |
