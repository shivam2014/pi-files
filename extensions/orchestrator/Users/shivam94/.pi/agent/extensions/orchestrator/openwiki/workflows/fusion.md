# Fusion Workflow

Fusion is a **multi-model deliberation system** that runs 2–3 AI models in parallel (the "panel"), then synthesizes their responses via a judge model into structured analysis.

## Flow Overview

```
User query
    │
    ▼
fusion({ task, models? })
    │
    ├── 1. Config Load (.pi/fusion.json)
    ├── 2. Model Resolution (auto-diverse if not specified)
    ├── 3. Panel Phase (concurrent model calls)
    ├── 4. Judge Phase (synthesize panel responses)
    └── 5. Format Phase (render structured output)
```

## Step-by-Step

### 1. Config Load

`fusion-config.ts` loads configuration from `.pi/fusion.json` with global fallback:
- `panelModels`: Array of model IDs for the panel
- `judgeModel`: Model ID for the judge
- `temperature`: Temperature setting (with fallback for providers that reject it)
- `reasoningEffort`: Reasoning effort level

Fail-closed on malformed config (ADR-0002).

### 2. Model Resolution

`fusion-models.ts` handles auto-diverse panel selection:
- If user specifies models: use those
- If not: automatically select diverse models from available providers
- Ensures panel models are from different providers when possible

### 3. Panel Phase

`fusion-pipeline.ts` → `FusionPipeline.run()`:
- Runs 2–3 models **concurrently** via `mapWithConcurrencyLimit()`
- Each model gets the same task prompt
- Temperature fallback: if a provider rejects temperature settings, retries without
- `FusionRunContext` tracks per-execution state (no module-level mutable state)

### 4. Judge Phase

`fusion-judge.ts`:
- Takes all panel responses
- Sends them to the judge model with synthesis instructions
- Judge produces structured JSON analysis:
  - Consensus points
  - Contradictions
  - Insights
  - Blind spots
  - Recommendations

### 5. Format Phase

`fusion-format.ts`:
- Renders the judge's analysis into human-readable output
- Uses box drawing and structured formatting
- Output includes all synthesis categories

## Key Concepts

### FusionRunContext
Per-execution context bag for a single fusion invocation. Holds:
- Temperature fallback cache
- Retry counts
- Timing metadata

**Critical:** Eliminates module-level mutable state and guarantees no state leaks across delegations.

### Temperature Fallback
Some providers reject non-default temperature values. The pipeline:
1. Sends with configured temperature
2. If provider rejects: retries without temperature
3. Caches the result in `FusionRunContext` for subsequent calls in same invocation

## UI Integration

- **Fusion TUI** (`fusion-tui.ts`): Terminal UI for monitoring fusion runs
- **Slash commands**: `/fusion on`, `/fusion off`, `/fusion status`
- **Fusion commands** (`fusion-commands.ts`): Command registration

## What to Watch Out For

- **No module-level mutable state**: All state must go through `FusionRunContext`. Module-level variables cause state leaks across delegations.
- **Concurrency limit**: Panel models run in parallel but bounded by `mapWithConcurrencyLimit()`. Don't increase without considering rate limits.
- **Config validation**: Malformed `.pi/fusion.json` fails closed. Test config changes carefully.
- **Provider compatibility**: Temperature fallback exists because some providers reject non-standard values. Test with all target providers.

## Related Files

- `/fusion-tool.ts` — Tool registration
- `/fusion-pipeline.ts` — Pipeline orchestration
- `/fusion-config.ts` — Configuration management
- `/fusion-format.ts` — Output formatting
- `/fusion-judge.ts` — Judge synthesis
- `/fusion-models.ts` — Model selection
- `/fusion-utils.ts` — Shared helpers
- `/fusion-tui.ts` — Terminal UI
- `/fusion-commands.ts` — Slash commands
- `/fusion-commands.test.ts` — Command tests
- `/fusion-config.test.ts` — Config tests
- `/fusion-format.test.ts` — Format tests
- `/fusion-judge.test.ts` — Judge tests
- `/fusion-models.test.ts` — Model tests
- `/fusion-tool.test.ts` — Tool tests
- `/fusion-utils.test.ts` — Utils tests
