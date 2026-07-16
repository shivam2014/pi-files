# Delegation/Subagent System Research Summary

## Overview

The delegation/subagent system is a sophisticated architecture for orchestrating specialist AI agents in a multi-agent workflow. The system enables an orchestrator agent to delegate specific tasks to specialized subagents (coder, scout, researcher, writer, reviewer) while maintaining strict scope control, safety boundaries, and real-time progress tracking.

## Architecture Overview

The system follows a layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────┐
│                   User Interface                │
│              (registerDelegateTool)              │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│              Delegate Controller                 │
│          (executeDelegate function)              │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│              Delegate Pipeline                   │
│    (orchestrates full delegation lifecycle)      │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│              Subagent Runner                     │
│    (creates isolated subagent sessions)          │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│              Tool Guard & Scope Guard            │
│    (enforces safety and scope boundaries)        │
└─────────────────────────────────────────────────┘
```

## Key Components

### 1. Subagent Runner (`subagent-runner.ts`)

**Purpose**: Creates isolated subagent sessions for specialist delegation.

**Key Features**:
- **Environment Isolation**: Cleans and installs isolated environment variables for subagents, preventing PI_* tokens from leaking
- **Model Resolution**: Resolves models from specialist configuration, parent context, or registry fallback
- **Skill Integration**: Resolves skill names to SKILL.md paths and loads them via DefaultResourceLoader
- **Activity Feed Integration**: Owns an ActivityFeed instance for real-time progress tracking
- **Tool Registration**: Defines planSteps, advanceStep, reportFinding, and ask_orchestrator tools
- **Streaming Updates**: Subscribes to session events and streams updates to orchestrator via onUpdate callbacks

**Key Exports**:
- `SubagentRunner` class with `run()` method
- `truncateSubagentOutput()` for output management
- `isSubagentContext()` to detect subagent execution
- `createAskOrchestratorTool()` for inter-agent communication

### 2. Subagent Tool Guard (`subagent-tool-guard.ts`)

**Purpose**: Blocks non-native tools and enforces scope boundaries for subagents.

**Key Features**:
- **Tool Interception**: Blocks non-native tools and enforces scope boundaries
- **Bash Command Analysis**: Classifies bash commands as read-only or write operations
- **Git Command Safety**: Categorizes git commands into safe (read-only) and write commands
- **Scope Enforcement**: Uses ScopeGuard to validate file operations against allowed scope
- **Read-only Specialist Protection**: Blocks write operations for read-only specialists (researcher, scout)
- **Fusion Tool Guard**: Blocks fusion tool when disabled

**Decision Flow**:
1. Check if planSteps has been called first
2. Validate against scope boundaries
3. Check bash command safety
4. Block non-native tools
5. Allow read-only tools unconditionally

### 3. Delegate Pipeline (`delegate-pipeline.ts`)

**Purpose**: Orchestrates specialist subagent delegation end-to-end.

**Key Features**:
- **Full Lifecycle Management**: Handles scope resolution, subagent execution, diagnostics, result formatting
- **Mode Guard**: Supports sequential and parallel delegation modes
- **Scope Management**: Resolves and applies scope via ScopeManager
- **Diagnostics Capture**: Captures and persists diagnostic information on failures
- **Metrics Tracking**: Tracks tool calls, scope violations, and execution metrics
- **Result Processing**: Formats output with findings, audit trails, and execution metadata
- **Plan Panel Integration**: Updates plan panel with delegation status

**Execution Flow**:
1. Validate delegation parameters
2. Resolve specialist definition
3. Apply scope (expand tilde, validate paths)
4. Check plan panel status
5. Run subagent via SubagentRunner
6. Process results and diagnostics
7. Format output with metrics and audit trails
8. Update plan panel and clean up

### 4. Delegate Tool (`delegate-tool.ts`)

**Purpose**: Registers the `delegate(specialist, task)` tool with the orchestrator.

**Key Features**:
- **Tool Registration**: Registers delegate tool with ExtensionAPI
- **Parameter Validation**: Defines schema for specialist, task, skills, and scope parameters
- **Render Functions**: Provides `renderCall` and `renderResult` for UI updates
- **Execution Routing**: Routes to `executeDelegate` function

**UI Features**:
- Live spinner during execution
- Tool call feed display
- Completion status indicators
- Error handling and display

### 5. Delegate Controller (`delegate-controller.ts`)

**Purpose**: Thin orchestrator for specialist subagent delegation.

**Key Features**:
- **Simple Interface**: Provides `executeDelegate` function as entry point
- **Error Handling**: Catches and formats errors from pipeline
- **Dependency Injection**: Creates ScopeManager and DelegatePipeline instances

### 6. Delegate Feed Builder (`delegate-feed-builder.ts`)

**Purpose**: Wraps activity-feed.ts for delegation context.

**Key Features**:
- **Lifecycle API**: `startDelegation → onToolCall* → onComplete → render`
- **Tool Call Tracking**: Records tool calls as substeps
- **Finding Reporting**: Records findings as substeps
- **Orchestrator Questions**: Tracks questions to orchestrator and answers
- **State Management**: Maintains ActivityFeedState throughout delegation

### 7. Scope Guard (`scope-guard.ts`)

**Purpose**: Thin enforcement adapter for scope boundaries.

**Key Features**:
- **Path Normalization**: Normalizes paths to absolute and relative forms
- **Scope Validation**: Checks if paths are within allowed scope
- **Expansion Requests**: Emits ScopeExpansionRequest when paths are outside scope
- **File Size Limits**: Checks file content against maxLinesPerFile limits
- **Universal Allowed Paths**: Always allows /tmp/ paths
- **Fail-closed Design**: Missing or malformed scope.json blocks all writes

**Enforcement Logic**:
1. Reads always allowed (scope only enforces mutations)
2. Check direct file allowlists
3. Check glob pattern matches
4. Check directory-level allowlist
5. Block if not in scope

### 8. Scope Manager (`scope-manager.ts`)

**Purpose**: Manages scope definitions and persistence.

**Key Features**:
- **Scope Normalization**: Converts ScopeManifest to ResolvedScope with defaults
- **File Persistence**: Writes/reads scope to `.pi/scope.json`
- **Per-specialist Defaults**: Provides default scopes for different specialists
- **Parallel Mode Support**: Creates per-delegation scopes for isolation
- **Manifest Tracking**: Tracks active and completed delegations
- **Cleanup**: Removes stale scope files (>24h old)

**Scope Types**:
- `ScopeManifest`: Input/authoring view before normalization
- `ResolvedScope`: Enforcement view after normalization
- `ScopeFileContract`: Versioned JSON contract for persistence

## System Workflow

### 1. Delegation Initiation
1. Orchestrator calls `delegate({ specialist, task, scope, skills })`
2. Delegate tool registers with ExtensionAPI
3. Tool validates parameters and renders call

### 2. Pipeline Execution
1. DelegateController creates ScopeManager and DelegatePipeline
2. Pipeline validates specialist and task
3. Scope is resolved and normalized
4. Plan panel is checked/created
5. SubagentRunner creates isolated session

### 3. Subagent Execution
1. Environment is cleaned and isolated
2. Skills are resolved and loaded
3. Tools are registered (planSteps, advanceStep, reportFinding, ask_orchestrator)
4. Session subscribes to events
5. ActivityFeed tracks progress
6. Tool Guard enforces scope boundaries

### 4. Result Processing
1. Output is truncated if needed
2. Diagnostics are captured on failure
3. Metrics are calculated
4. Results are formatted with:
   - Execution metadata
   - Tool call trails
   - Audit information
   - Findings summary
   - Status indicators

### 5. Cleanup
1. Plan panel is updated
2. Scope is cleared
3. Peek overlay is hidden
4. Viewer state is cleared

## Key Design Patterns

### 1. Environment Isolation
- Snapshot → Clean → Install pattern
- Prevents PI_* token leakage
- Isolates subagent from orchestrator environment

### 2. Fail-closed Security
- Missing scope.json blocks all writes
- Unknown tools treated as mutations
- Unknown git commands blocked for read-only specialists

### 3. Activity Feed Pattern
- Real-time progress tracking
- Tool call visualization
- Step/substep hierarchy
- Streaming updates

### 4. Scope Enforcement
- Exact file match → Glob pattern → Directory prefix
- Universal allowed paths (/tmp/)
- File size limits
- Expansion request flow

### 5. Diagnostic Capture
- Automatic capture on failure
- Metrics tracking
- Persistent storage
- Cleanup of old diagnostics

## Integration Points

### With Orchestrator
- Plan panel updates
- Dynamic status messages
- Ask orchestrator tool
- Scope validation

### With Activity Feed
- Real-time progress updates
- Tool call visualization
- Step/substep tracking
- Streaming text display

### With Scope System
- Scope resolution
- Path validation
- Expansion requests
- Parallel mode isolation

### With Diagnostics
- Failure capture
- Metrics tracking
- Persistent storage
- Cleanup routines

## Safety Features

1. **Environment Isolation**: Prevents token leakage
2. **Scope Enforcement**: Limits file operations to allowed paths
3. **Tool Interception**: Blocks dangerous commands
4. **Read-only Specialists**: Prevents write operations for research/scout
5. **Fail-closed Design**: Defaults to blocking when uncertain
6. **File Size Limits**: Prevents excessive file modifications
7. **Path Traversal Protection**: Blocks `..` in scope paths
8. **Git Command Safety**: Categorizes git operations by risk

## Performance Considerations

1. **Output Truncation**: Limits output to 30,000 characters
2. **Streaming Updates**: Real-time progress without blocking
3. **Activity Feed Caching**: Minimizes re-renders
4. **Scope File Caching**: Reduces disk reads
5. **Diagnostic Cleanup**: Removes old diagnostics automatically

## Testing Strategy

The system includes comprehensive tests for:
- Subagent runner functionality
- Tool guard enforcement
- Pipeline execution
- Scope management
- Feed builder operations
- Integration scenarios

## Future Enhancements

1. **Parallel Execution**: Enhanced support for multiple concurrent delegations
2. **Scope Expansion UI**: Interactive scope expansion requests
3. **Advanced Diagnostics**: More detailed failure analysis
4. **Performance Metrics**: Execution time and resource usage tracking
5. **Scope Templates**: Predefined scope configurations for common scenarios

## Conclusion

The delegation/subagent system is a well-architected, secure, and observable multi-agent orchestration system. It provides clear separation of concerns, strong safety boundaries, and comprehensive progress tracking. The system is designed for extensibility and maintainability, with clear interfaces between components and comprehensive error handling.