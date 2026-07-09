# Fusion Subsystem Architecture Summary

## 1. Fusion Pipeline Flow

### Overview
The Fusion subsystem is a multi-model analysis tool that runs prompts against a panel of models, then uses a judge model to synthesize responses into structured analysis. It's designed for decision-making scenarios where multiple AI perspectives are valuable.

### Key Files
- **`/fusion-tool.ts`** - Main tool registration and execution entry point
- **`/fusion-pipeline.ts`** - Core pipeline orchestration (FusionPipeline class)
- **`/fusion-config.ts`** - Configuration loading/saving from `.pi/fusion.json`
- **`/fusion-format.ts`** - Result formatting for display
- **`/fusion-judge.ts`** - Judge analysis parsing and JSON extraction
- **`/fusion-models.ts`** - Model resolution and auto-diverse panel selection
- **`/fusion-commands.ts`** - CLI commands for fusion management
- **`/fusion-tui.ts`** - Terminal UI for fusion settings
- **`/fusion-utils.ts`** - Utility functions (text extraction, concurrency limiting)

### Pipeline Flow

1. **Registration** (`registerFusionTool()` in fusion-tool.ts):
   - Registers the `fusion` tool with the extension API
   - Idempotent registration per working directory
   - Tool parameters: `context`, `task`, `draft_plan`

2. **Execution Flow** (`execute()` in fusion-tool.ts):
   - Loads config from `.pi/fusion.json` (project) or `~/.pi/fusion.json` (global)
   - Resolves panel models from config or auto-diverse selection
   - Resolves judge model (falls back to first panel model)
   - Builds system/user prompts with planning advisor instructions
   - Creates `FusionRunContext` for temperature fallback caching
   - Executes `FusionPipeline.panelPhase()` then `judgePhase()`

3. **Panel Phase** (`panelPhase()` in fusion-pipeline.ts):
   - Pre-flight temperature probe for each model (cached per session)
   - Runs panel models concurrently (limit: 2) via `mapWithConcurrencyLimit()`
   - Each model runs `runPanelModel()` with report-finding tool
   - Models can call `reportFinding` tool multiple times for structured output
   - Returns `{ succeeded, failed }` arrays

4. **Judge Phase** (`judgePhase()` in fusion-pipeline.ts):
   - Takes succeeded panel responses
   - Judge model synthesizes into structured JSON analysis
   - Retries up to 3 times on parse failures
   - Returns `FusionAnalysis` with consensus, contradictions, insights, blind spots, recommendations

5. **Format Phase** (`formatPhase()` in fusion-pipeline.ts):
   - Uses `formatFusionResult()` for successful analysis
   - Falls back to `formatPanelResults()` if judge fails
   - Returns tool response with formatted text and details

### Configuration Schema (FusionConfig)
```typescript
interface FusionConfig {
  enabled?: boolean;           // Default: true
  panel?: string[];            // Model IDs for panel (e.g., ["anthropic/claude-3-opus"])
  judge?: string;              // Judge model ID
  maxPanelModels?: number;     // Default: 3
  temperature?: number;        // Default: 0.3
  maxTokensPerPanel?: number;  // Default: 2048
  maxTokensForJudge?: number;  // Default: 4096
}
```

### Temperature Fallback System
- `tryCompleteWithTemperatureFallback()`: Retries without temperature if provider rejects
- `probeTemperatureSupport()`: Pre-flight test cached per model per session
- Cache stored in `FusionRunContext.temperaturePreferenceCache`

### Key Functions
- `registerFusionTool(pi, cwd)` - Register tool
- `loadFusionConfig(cwd, availableModelIds?)` - Load config with sanitization
- `resolveModels(registry, models)` - Resolve model IDs to model objects
- `autoDiversePanel(registry)` - Auto-select diverse panel from available models
- `parseJudgeAnalysis(text)` - Parse judge JSON response
- `extractJsonObject(text)` - Extract JSON from markdown fences

---

## 2. Scout/Ask System

### Overview
The Scout/Ask system provides read-only tools for git/gh operations and a resolution system for subagent clarification questions.

### Key Files
- **`/scout-tools.ts`** - Read-only git and GitHub CLI tools
- **`/ask-resolver.ts`** - Question resolution for subagent clarification
- **`/ask-resolver.test.ts`** - Tests for resolution logic

### Scout Tools

1. **`git-read`** (`gitReadTool`):
   - Read-only git operations (log, diff, status, show, branch, remote, etc.)
   - Whitelist of allowed subcommands (30+ read-only commands)
   - Skips global git options to find subcommand
   - 15-second timeout, 1MB buffer limit

2. **`gh`** (`ghTool`):
   - Read-only GitHub CLI operations
   - Allowed commands: repo, issue, pr, search, release, auth, status
   - Subcommand validation (e.g., `gh repo view` allowed, `gh repo create` blocked)
   - 15-second timeout, 1MB buffer limit

### Ask Resolver System

**Resolution Order** (`createAskOrchestratorResolver()`):
1. **Files referenced in question** - Extracts paths, reads file previews
2. **Project docs/ directory** - Keyword matching against doc filenames
3. **Recent conversation context** - Searches last 10 orchestrator turns
4. **Orchest escalation** - Returns escalation message if no answer found

**Key Functions**:
- `resolveExistingPath(token, cwd)` - Resolve path-like tokens to files
- `extractReferencedPaths(text, cwd)` - Extract file paths from text
- `readFilePreview(path)` - Read file with 8KB limit
- `tryAnswerFromDocs(question, cwd)` - Search docs/ for answers
- `tryAnswerFromContext(question, recentContext)` - Search conversation context
- `resolve(request, scope)` - Boolean gate for orchestrator escalation

**Scope Resolution** (`resolve()` function):
- Returns `"ask"` when scope is vague (no file specs, only wildcards)
- Returns `"proceed"` when scope has concrete file specifications
- Checks `filesToModify`, `filesToCreate`, `directories` arrays
- Uses `hasLiteralSegment()` to detect non-wildcard paths

---

## 3. Plan Panel & Activity Feed

### Overview
The Plan Panel manages multi-step orchestration plans with real-time UI updates, while the Activity Feed tracks subagent tool execution progress.

### Key Files
- **`/plan-panel.ts`** - Plan state management and timeline rendering
- **`/plan-tool.ts`** - Tool registration for plan management
- **`/activity-feed.ts`** - Subagent tool block rendering
- **`/peek-overlay.ts`** - Live subagent conversation viewer

### Plan Panel System

**PlanPanel Class** (`/plan-panel.ts`):
- Per-session plan state (goal, steps, timeline)
- Module-level instances: `Map<string, PlanPanel>` keyed by sessionId
- Timeline recording for debugging (max 500 frames)
- Widget rendering with budget constraint (9 lines max)

**Plan Tools** (`/plan-tool.ts`):
1. **`plan`** - Declare initial plan (goal + steps)
2. **`plan_add_steps`** - Append new steps (skips duplicates)
3. **`insert_step`** - Insert at specific position (by label or index)
4. **`advance_plan_step`** - Mark active step complete
5. **`modify_step`** - Update step label/kind
6. **`remove_step`** - Remove pending step

**Plan State Persistence**:
- Saved to `.pi/orchestrator-plan.json`
- Survives session restarts
- Steps have `kind` property: `'delegation'` or `'orchestrator'`

**Key Functions**:
- `setupPlanPanel(goal, steps, ctx)` - Initialize plan
- `resolvePlanPanel(ctx)` - Get panel for session
- `advanceStep()` - Complete active step
- `insertSteps(labels, opts)` - Insert with validation
- `recordTimelineFrame(event, state, render)` - Debug timeline
- `dumpTimelineToDisk()` - Persist timeline to `/tmp/`

### Activity Feed System

**ActivityFeedState** (`/activity-feed.ts`):
- Tracks steps, substeps, current step, error state
- Tool call to substep mapping
- Output compression and preview

**Key Functions**:
- `addStep(state, label)` - Add new step
- `addSubstep(state, label, toolCallId?)` - Add substep with tool tracking
- `completeLastSubstep(state, outputPreview?, isError?)` - Complete active substep
- `completeSubstepByToolCallId(state, toolCallId, ...)` - Complete by tool call ID
- `setToolDetail(feed, detail)` - Set tool detail on active substep
- `renderActivityFeed(name, state, goalOverride?)` - Render canonical format
- `toolCallToSubstep(toolName, input)` - Convert tool call to human label
- `substepToolDetail(toolName, input)` - Get multi-item tool detail

**Substep Lifecycle**:
1. `addSubstep()` - Create with `startTime`
2. `setToolDetail()` - Set tool detail (optional)
3. `updateActiveSubstepOutput()` - Update preview (optional)
4. `completeLastSubstep()` or `completeSubstepByToolCallId()` - Mark completed with `endTime`

### Peek Overlay System

**PeekComponent** (`/peek-overlay.ts`):
- Layer 3: Live subagent conversation viewer
- Shows subagent goal, conversation messages, streaming output
- Auto-scrolls, caps at 50 lines
- Escape to close, double-press x to abort

**Key Functions**:
- `setViewerSession(session, task)` - Set session to view
- `updatePeek(text)` - Append to streaming buffer
- `setViewerOutput(output)` - Set final output
- `setViewerError(error)` - Set error state
- `clearViewerState()` - Reset state
- `pushStreamingText(delta)` - Debounced streaming text push

---

## 4. Subagent Runner & Diagnostics

### Overview
The Subagent Runner creates isolated sessions for specialist delegation, while Diagnostics captures failure patterns for debugging.

### Key Files
- **`/subagent-runner.ts`** - Core subagent execution
- **`/subagent-diagnostics.ts`** - Failure pattern detection and persistence
- **`/subagent-tool-guard.ts`** - Tool call enforcement and scope checking
- **`/subagent-event-router.ts`** - Event routing system

### SubagentRunner Class

**Configuration** (`SubagentRunnerConfig`):
```typescript
interface SubagentRunnerConfig {
  cwd: string;
  modelRegistry: ModelRegistry;
  agentDir: string;
  signal?: AbortSignal;
  onUpdate?: (update: any) => void;
  agentSessionFactory?: Function; // For testing
}
```

**Execution Flow** (`run()` method):
1. **Model Resolution**: specialist.model > parent.model > registry fallback
2. **Environment Isolation**: Snapshot, clean, install isolated env
3. **Resource Loading**: DefaultResourceLoader with skill paths
4. **Tool Setup**:
   - Plan tools: `planSteps`, `advanceStep`, `reportFinding`
   - Ask tool: `ask_orchestrator` (wired to resolver)
   - Scout tools: `git-read`, `gh` (for scout/researcher specialists)
   - Skill tool: `read_skill`
5. **Session Creation**: `createAgentSession()` with custom tools
6. **Event Subscription**: Real-time updates for activity feed
7. **Execution**: `session.prompt(task)` with periodic re-render
8. **Cleanup**: Unsubscribe, dispose session, restore env

**Key Functions**:
- `runSubagent(specialist, task, cwd, ...)` - Public API
- `truncateSubagentOutput(output, cap)` - Smart truncation preserving findings
- `createAskOrchestratorTool(resolve, onUpdate, specialist, feed)` - Ask tool factory
- `resolveSkillPaths(skills, agentDir)` - Resolve skill names to paths

**Activity Feed Integration**:
- Feed updates on `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- Plan panel updated via `updatePlanStepDetail()`
- Timeline recorded via `recordTimelineFrame()`
- Peek overlay updated via `setViewerSession()`, `updatePeek()`, `pushStreamingText()`

### Diagnostics System

**captureDiagnostic()** (`/subagent-diagnostics.ts`):
- Detects silent failures (0 tool calls, short output)
- Detects crashes (0 tool calls, no output)
- Filters out Q&A tasks (short, no file references)
- Returns `SubagentDiagnostic` with structured data

**Persistence**:
- Directory: `{agentDir}/extensions/orchestrator/diagnostics/YYYY-MM-DD/{sessionId}/`
- Filename: `incident-{timestamp}-{specialist}-{hash}.json`
- Atomic write (tmp + rename)
- Auto-cleanup: 30-day retention

**Key Functions**:
- `captureDiagnostic(input)` - Detect failure patterns
- `isLikelyQATask(task)` - Heuristic for conversational tasks
- `persistDiagnostic(dir, diagnostic)` - Atomic write to disk
- `cleanupOldDiagnostics(dir, maxAgeDays)` - Remove old diagnostics
- `redactSecrets(text)` - Remove API keys/tokens

### Tool Guard System

**handleSubagentToolCall()** (`/subagent-tool-guard.ts`):
- Enforces scope restrictions during subagent execution
- Intercepts bash commands with `BashInterceptor`
- Validates file paths against `ScopeGuard`
- Blocks non-native tools in subagent context

**Checks Performed**:
1. **Fusion disabled check** - Block fusion tool if disabled
2. **Plan-first enforcement** - Require `planSteps()` before other tools
3. **Scope validation** - Check file paths against allowed scope
4. **Bash interception** - Replace bash with native tools (read, grep, etc.)
5. **Git command analysis** - Allow read-only git, check write commands
6. **File size checks** - Prevent oversized files

### Event Router System

**SubagentEventRouter** (`/subagent-event-router.ts`):
- Simple pub/sub for subagent events
- Event types: `tool_call_start`, `tool_call_end`, `finding`, `ask_orchestrator`, `error`, `progress`
- Handler registration with cleanup functions
- Used for decoupled event handling

---

## Module Connections

### Fusion → Subagent Integration
- Fusion tool available to subagents via `specialist.tools`
- Subagent tool guard blocks fusion if disabled
- Fusion analysis can inform delegation decisions

### Plan Panel ↔ Subagent Runner
- Plan tools (`planSteps`, `advanceStep`) drive activity feed
- Subagent runner updates plan panel detail lines
- Timeline recording bridges both systems

### Activity Feed → Peek Overlay
- Subagent runner pushes streaming text to peek
- Activity feed render updates plan panel widget
- Both consume session events from subagent runner

### Ask Resolver ↔ Subagent Runner
- `ask_orchestrator` tool wired to resolver
- Resolver searches files, docs, conversation context
- Escalates to orchestrator if no answer found

### Diagnostics → Subagent Runner
- Captures failures after subagent completion
- Persists to disk for later analysis
- Integrates with tool call trail for debugging