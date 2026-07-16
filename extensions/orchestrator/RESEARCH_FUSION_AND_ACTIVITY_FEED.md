# Research Summary: Fusion Subsystem and Activity Feed

## Executive Summary

This research examines two major subsystems in the codebase: the **Fusion Subsystem** (multi-model analysis tool) and the **Activity Feed System** (subagent execution tracking). Both systems are critical components of the orchestrator architecture, providing distinct but complementary capabilities for AI-assisted development workflows.

---

## 1. Fusion Subsystem

### Overview
The Fusion subsystem is a **multi-model analysis tool** that runs prompts against a panel of AI models, then uses a judge model to synthesize responses into structured analysis. It's designed for decision-making scenarios where multiple AI perspectives are valuable.

### Architecture
The system follows a **three-phase pipeline architecture**:

1. **Panel Phase**: Run multiple AI models concurrently on the same task
2. **Judge Phase**: Synthesize panel responses into structured JSON analysis  
3. **Format Phase**: Format results for display and tool response

### Core Components

#### `fusion-pipeline.ts` - Core Pipeline Orchestration
- **FusionPipeline Class**: Main orchestrator for the three-phase pipeline
- **Temperature Fallback System**: Handles provider-specific temperature limitations
  - `tryCompleteWithTemperatureFallback()`: Retries without temperature if provider rejects
  - `probeTemperatureSupport()`: Pre-flight test cached per model per session
- **Report-Finding Tool**: Structured output mechanism for panel models
- **Concurrency Control**: Limits panel execution to 2 concurrent models

**Key Features**:
- Automatic temperature support detection and caching
- Robust error handling with retry logic for judge phase (up to 3 attempts)
- Session-aware caching to avoid repeated probes

#### `fusion-tool.ts` - Tool Registration & Execution
- **Tool Registration**: Idempotent registration per working directory
- **Parameter Schema**: `context`, `task`, `draft_plan` parameters
- **Execution Flow**:
  1. Load configuration from `.pi/fusion.json` (project) or `~/.pi/fusion.json` (global)
  2. Resolve panel models (config → auto-diverse → current model fallback)
  3. Resolve judge model (config → first panel model fallback)
  4. Build system/user prompts with planning advisor instructions
  5. Execute pipeline phases with streaming updates

**Re-exports**: Acts as API surface for other modules, re-exporting key functions from related files.

#### `fusion-config.ts` - Configuration Management
- **Config Schema** (`FusionConfig`):
  ```typescript
  interface FusionConfig {
    enabled?: boolean;           // Default: true
    panel?: string[];            // Model IDs for panel
    judge?: string;              // Judge model ID
    maxPanelModels?: number;     // Default: 3
    temperature?: number;        // Default: 0.3
    maxTokensPerPanel?: number;  // Default: 2048
    maxTokensForJudge?: number;  // Default: 4096
  }
  ```
- **Config Loading**: Merges global and project configs, with project overriding global
- **Sanitization**: Removes stale model references not in available registry
- **Persistence**: Saves cleaned config back to project path

#### `fusion-judge.ts` - Judge Analysis Parsing
- **JSON Extraction**: Robust extraction from markdown fences and nested objects
- **Schema Validation**: Type-safe validation of analysis structure
- **Parse Judge Analysis**: Validates required fields:
  - `consensus`: String array
  - `contradictions`: Array of topic/stances objects
  - `unique_insights`: Array of model/insight objects
  - `blind_spots`: String array
  - `recommendations`: String array

#### `fusion-models.ts` - Model Resolution
- **resolveModels()**: Convert model ID strings to registry objects
- **resolveOneModel()**: Single model resolution
- **autoDiversePanel()**: Auto-select diverse panel from available models
  - Groups by provider, selects top model from each provider
  - Ensures diversity across different AI providers

#### `fusion-format.ts` - Result Formatting
- **formatFusionResult()**: Formats successful analysis with:
  - Consensus points
  - Contradictions with stances
  - Unique insights per model
  - Blind spots
  - Synthesized recommendations
  - Panel contributions and judge summary
- **formatPanelResults()**: Fallback formatting when judge fails
  - Shows raw panel responses
  - Includes error information

#### `fusion-commands.ts` - CLI Commands
- **fusion on/off**: Toggle fusion enabled state
- **fusion status**: Show current configuration
- **fusion**: Open interactive TUI (default)

#### `fusion-tui.ts` - Terminal UI
- **Interactive Settings**: Visual configuration interface
- **Section Navigation**: Enabled, Panel, Judge, Temperature, Save
- **Model Selection**: SelectList for panel (multi-select) and judge (single-select)
- **Real-time Validation**: Sanitizes stale model references on open

#### `fusion-utils.ts` - Utility Functions
- **extractText()**: Extract text from AssistantMessage (text blocks → thinking blocks fallback)
- **mapWithConcurrencyLimit()**: Promise-based concurrency limiter for parallel execution

### Key Design Patterns

1. **Immutable State**: Functions return new state objects rather than mutating
2. **Caching**: Temperature preferences cached per session to avoid redundant probes
3. **Fallback Chains**: Multiple fallback levels for model resolution and configuration
4. **Error Recovery**: Judge phase retries up to 3 times on parse failures
5. **Streaming Updates**: Real-time progress updates via `onUpdate` callbacks

---

## 2. Activity Feed System

### Overview
The Activity Feed tracks **subagent tool execution progress** in real-time, providing a hierarchical view of steps, substeps, and tool calls during specialist delegation.

### Architecture
The system follows a **state machine pattern** with immutable state transformations:

1. **State Creation**: Initialize feed state
2. **Step/Substep Lifecycle**: Add, complete, update operations
3. **Rendering**: Hierarchical display with progress indicators
4. **Compression**: Output normalization for display

### Core Components

#### `activity-feed.ts` - Feed State Machine
**ActivityFeedState Structure**:
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

**Step/Substep Structure**:
```typescript
interface Step {
  label: string;
  completed: boolean;
  substeps: Substep[];
  startTime?: number;
  endTime?: number;
  overflowCount?: number;
}

interface Substep {
  label: string;
  completed: boolean;
  startTime: number;
  endTime?: number;
  toolCallId?: string;
  outputPreview?: string;
  toolDetail?: string;
  errored?: boolean;
  isReport?: boolean;
}
```

#### Key Functions

**State Management**:
- `createActivityFeed()`: Initialize empty feed state
- `addStep(state, label)`: Add new step (deduplicates, handles "Working..." placeholder)
- `addSubstep(state, label, toolCallId?)`: Add substep with overflow handling (max 8 visible)

**Substep Lifecycle**:
- `completeLastSubstep(state, outputPreview?, isError?)`: Complete active substep
- `completeSubstepByToolCallId(state, toolCallId, ...)`: Complete by tool call ID
- `completeActiveSubstepWithLabel(state, label, ...)`: Complete and rename (e.g., "Clarify:" → "Clarified:")

**Tool Detail Management**:
- `setToolDetail(feed, detail)`: Set tool detail on active substep
- `clearToolDetail(feed)`: Clear tool detail
- `updateActiveSubstepOutput(state, outputPreview)`: Update output preview without completing

**Error Handling**:
- `markFeedError(state, message)`: Mark feed as errored with current state preserved
- `retryFeedStep(state, reason?)`: Reset for retry with incrementing retry count

**Tool Call Mapping**:
- `toolCallToSubstep(toolName, input)`: Convert tool calls to human-readable labels
  - Handles: read, bash, grep, find, edit, write, ls, ask_orchestrator, lint, typecheck, web_search, fetch_content
- `substepToolDetail(toolName, input)`: Multi-item tool call details (queries[], urls[])

**Rendering**:
- `renderActivityFeed(name, state, goalOverride?)`: Canonical hierarchical rendering
  - Progress dots: ● for completed, ✗ for errored, ○ for pending
  - Step/substep hierarchy with status icons
  - Duration display for completed steps
  - Overflow indicators for truncated substeps
  - Tool detail display for active substeps

**Output Compression**:
- `compressOutput(output)`: Strip ANSI codes, collapse blank lines, trim

#### ActivityFeed Class
Instance-based wrapper providing method chaining:
```typescript
class ActivityFeed {
  addStep(label): this
  addSubstep(label, toolCallId?): this
  setToolDetail(detail): this
  completeLastSubstep(outputPreview?, isError?): this
  completeCurrentStep(): this
  markFeedError(message): this
  render(specialistName?, goalOverride?): string
  static fromPlanSteps(steps, goal): ActivityFeed
}
```

### Key Design Patterns

1. **Immutable State**: All functions return new state objects
2. **State Machine**: Clear lifecycle: create → add → complete → render
3. **Overflow Handling**: Limits visible substeps to 8, shows overflow count
4. **Tool Call Tracking**: Links tool calls to substeps via `toolCallId`
5. **Error Recovery**: Preserves state on error, supports retry with count
6. **Real-time Rendering**: Supports mid-render state changes with retry guard

### Integration Points

**With Subagent Runner**:
- Feed updates on `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- Plan panel updated via `updatePlanStepDetail()`
- Timeline recorded via `recordTimelineFrame()`

**With Peek Overlay**:
- Live subagent conversation viewing
- Streaming text updates

**With Orchestrator Theme**:
- Uses `styledSymbol()`, `statusIcon()`, `formatDuration()` for consistent UI
- Theme-aware rendering with colors and icons

---

## 3. System Interactions

### Fusion ↔ Activity Feed
- **No direct integration**: Fusion operates independently as a tool
- **Both used in orchestration**: Fusion for decision-making, Activity Feed for execution tracking
- **Shared patterns**: Both use immutable state, streaming updates, error recovery

### Common Patterns Across Both Systems

1. **Configuration Management**: JSON-based config with project/global hierarchy
2. **Error Handling**: Retry logic, fallback chains, graceful degradation
3. **State Immutability**: Functional transformations returning new state
4. **Real-time Updates**: Streaming progress via callbacks
5. **Caching**: Session-aware caching to avoid redundant operations
6. **Tool Integration**: Both designed to work with extension API tools

---

## 4. Technical Highlights

### Fusion Subsystem Innovations

1. **Temperature Fallback System**: Proactive detection of provider limitations
2. **Auto-Diverse Panel Selection**: Algorithm ensures provider diversity
3. **Judge Retry Logic**: Up to 3 attempts with parse error feedback
4. **Structured Output**: `reportFinding` tool for multi-finding extraction

### Activity Feed Innovations

1. **Overflow Management**: Smart truncation with overflow indicators
2. **Tool Call Mapping**: Human-readable labels from tool schemas
3. **State Recovery**: Error preservation with retry capability
4. **Hierarchical Rendering**: Multi-level progress visualization

---

## 5. Usage Patterns

### When to Use Fusion

- **Decision-making scenarios** requiring multiple AI perspectives
- **Plan critique** before high-cost delegations
- **Tradeoff analysis** with contradictory viewpoints
- **Complex problem solving** benefiting from diverse approaches

### When to Use Activity Feed

- **Subagent execution monitoring** during delegation
- **Progress tracking** for multi-step workflows
- **Debugging** execution failures
- **User feedback** during long-running operations

---

## 6. Configuration Examples

### Fusion Configuration (`.pi/fusion.json`)
```json
{
  "enabled": true,
  "panel": ["anthropic/claude-3-opus", "openai/gpt-4"],
  "judge": "anthropic/claude-3-opus",
  "temperature": 0.3,
  "maxPanelModels": 3,
  "maxTokensPerPanel": 2048,
  "maxTokensForJudge": 4096
}
```

### Activity Feed Usage
```typescript
const feed = new ActivityFeed();
feed.addStep("Implement feature");
feed.addSubstep("Read source files", toolCallId1);
feed.setToolDetail("Reading src/main.ts");
feed.completeLastSubstep("Found entry point");
feed.completeCurrentStep();
console.log(feed.render());
```

---

## 7. Future Considerations

### Potential Enhancements

1. **Fusion**: Panel model weighting, confidence scoring, historical analysis
2. **Activity Feed**: Substep grouping, time estimation, progress prediction
3. **Integration**: Fusion results feeding into activity feed planning
4. **Analytics**: Usage patterns, performance metrics, optimization opportunities

### Scalability Concerns

1. **Fusion**: Provider rate limits, concurrent execution caps
2. **Activity Feed**: Memory usage for long-running operations, state persistence

---

## 8. Conclusion

Both the Fusion Subsystem and Activity Feed represent sophisticated solutions to distinct challenges in AI-assisted development:

- **Fusion** excels at **synthesizing multiple AI perspectives** into actionable insights
- **Activity Feed** excels at **tracking and displaying execution progress** in real-time

Together, they provide a comprehensive toolkit for orchestrating complex AI workflows with visibility, control, and reliability. The systems demonstrate strong engineering principles: immutability, error recovery, caching, and thoughtful user experience design.