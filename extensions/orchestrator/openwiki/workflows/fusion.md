# Fusion Subsystem

Fusion is an optional multi-model analysis tool that runs a prompt against a panel of 2-3 AI models, then has a judge model synthesize their responses into a structured analysis.

## Concept

Instead of relying on a single model's perspective, Fusion provides:
- **Consensus**: Points where all models agree
- **Contradictions**: Topics where models disagree, with each model's stance
- **Unique insights**: Observations that only one model made
- **Blind spots**: Things none of the models mentioned
- **Recommendations**: Actionable next steps from the judge

## Configuration

Fusion is configured via `.pi/fusion.json` (project-level) or `~/.pi/fusion.json` (global).

**Config type** (`FusionConfig` in `/types.ts`):
```typescript
interface FusionConfig {
  enabled?: boolean;        // Master toggle
  panel?: string[];         // Panel model IDs (2-3 models)
  judge?: string;           // Judge model ID
  maxPanelModels?: number;  // Max panel size (default 3)
  temperature?: number;     // Temperature for panel calls
  maxTokensPerPanel?: number;
  maxTokensForJudge?: number;
}
```

**Config loading**: `/fusion-config.ts` — loads, validates, and sanitizes config. Handles missing files gracefully (defaults to disabled).

**Toggle**: `/fusion-commands.ts` — registers `/fusion-toggle` and `/fusion-status` CLI commands.

## Pipeline

**File**: `/fusion-pipeline.ts`

### Step 1: Panel Execution
Each panel model receives the same prompt (context + task + optional draft plan). Models run concurrently with a configurable concurrency limit.

`tryCompleteWithTemperatureFallback()` handles providers that reject non-default temperatures — retries once without temperature if the first call fails.

### Step 2: Judge Synthesis
The judge model receives all panel responses and produces a structured analysis. The judge prompt is in `/fusion-judge.ts`.

### Step 3: Output
The result is a `FusionAnalysis` object:
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

**Result statuses**: `ok`, `error`, `single` (only one model available), `disabled`, `no_judge`.

## Model Resolution

**File**: `/fusion-models.ts`

- `resolveModels()`: Resolves model IDs from config + available models
- `resolveOneModel()`: Resolves a single model ID
- `autoDiversePanel()`: Automatically selects a diverse panel when config doesn't specify models

## Tool Registration

**File**: `/fusion-tool.ts`

The `fusion` tool is registered idempotently per cwd. Visibility is controlled entirely by `setActiveTools()` — the tool is always registered but only shown to the agent when fusion is enabled.

**Parameters**:
- `context` (string): Research findings, code analysis, or context for the panel
- `task` (string): What you want the panel to do
- `draft_plan` (string, optional): Preliminary plan for the panel to critique

## Formatting

**File**: `/fusion-format.ts`

- `formatFusionResult()`: Formats the full FusionResult for display
- `formatPanelResults()`: Formats individual panel model responses

## TUI Integration

**File**: `/fusion-tui.ts`

Optional TUI widget showing fusion status (enabled/disabled, active models, last run timestamp).

## Key Source Files

| File | Role |
|------|------|
| `/fusion-tool.ts` | Tool definition, registration |
| `/fusion-pipeline.ts` | Panel execution + judge synthesis |
| `/fusion-config.ts` | Config loading and validation |
| `/fusion-models.ts` | Model resolution |
| `/fusion-judge.ts` | Judge prompt + analysis parsing |
| `/fusion-format.ts` | Result formatting |
| `/fusion-commands.ts` | /fusion-toggle, /fusion-status |
| `/fusion-tui.ts` | Status TUI widget |
| `/fusion-utils.ts` | Shared utilities (extractText, concurrency) |
