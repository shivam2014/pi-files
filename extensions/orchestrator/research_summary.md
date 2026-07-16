# Core Orchestrator Source Files Research Summary

## 1. **index.ts** - Entry Point and Wiring Hub

**Purpose**: Main entry point for the orchestrator extension, refactored from monolithic orchestrator.ts (1663 lines) into modular structure.

**Key Responsibilities**:
- Guards against subagent re-registration (env var check)
- Registers `before_agent_start` handler (injects system prompt, strips tools)
- Registers `tool_call` handler (blocks non-delegate calls)
- Delegates tool registration to `delegate-tool.ts`
- Delegates command registration to `commands.ts`
- Registers `session_start` handler to freeze active tools for prefix-cache stability
- Handles `resources_discover` to register ask-matt skills for SDK skill discovery
- Provides Ctrl+Q shortcut for peek overlay (Layer 3 visibility)

**Key Functions**:
- `resolveCwd()` - Resolves current working directory
- `isReadOnlySpecialist()` - Checks if current specialist has bash but no edit/write (e.g., reviewer)

**Critical Design Decisions**:
- **Cache Safety**: `setActiveTools()` moved to `session_start` (not `before_agent_start`) to prevent prefix cache breaks between turns 1 and 2
- **Subagent Context**: Skips full orchestrator registration when loading for subagent sessions
- **Tool Blocking**: Only allows `plan()`, `delegate()`, `fusion`, `read_skill`, `list_skills`, `list_tools`, `vision_query`, and `interactive_shell` tools in orchestrator mode

## 2. **types.ts** - Shared Type Definitions

**Purpose**: Extracted from orchestrator.ts during refactoring, provides all shared types for the orchestrator extension.

**Key Types**:

### Planning Types
- `OrchestratorStep` - Step in orchestration plan (Layer 1 header)
- `OrchestratorActivity` - Orchestration activity state (Layer 1 header)
- `Step` - Step in activity feed (Layer 2 chat blocks)
- `Substep` - Substep within activity feed step
- `PlanStep` - Step in plan panel header
- `StepKind` - `'delegation' | 'orchestrator'` classification

### Specialist Types
- `Specialist` - Specialist definition with name, description, tools, suggestedSkills, model, routingLabel, systemPrompt
- `SubagentContext` - Context passed to subagent runner

### Activity Feed Types
- `ActivityFeedState` - Activity feed state for subagent tool blocks

### Metrics Types
- `DelegationMetrics` - Per-delegation tool usage metrics (readCalls, grepCalls, etc.)
- `formatMetricsLine()` - Formats metrics as single-line summary

### Fusion Types
- `FusionConfig` - Configuration for fusion tool
- `FusionAnalysis` - Analysis result from fusion pipeline
- `FusionResult` - Result from fusion tool execution

### Skill Types
- `ReadSkillParams` - Parameters for read_skill tool
- `MinimalModelRegistry` - Minimal model registry interface
- `DelegateControllerContext` - Context for delegate-controller

### Diagnostic Types
- `SubagentDiagnostic` - Diagnostic metrics for subagent session

### Session Types
- `SessionContext` - Session context for plan-panel instance resolution
- `ReadonlySessionManager` - Readonly subset of SessionManager

## 3. **specialists.ts** - Specialist Roster and Skill System

**Purpose**: Defines the 5 built-in specialists and their configurations, extracted from orchestrator.ts during refactoring.

### Specialist Roster
1. **Scout** - Read-only codebase investigator
   - Tools: `read, grep, find, ls, git-read, gh`
   - Skills: `diagnosing-bugs`
   - Description: "Investigate codebase / find files"

2. **Coder** - Implementation specialist with full read/write access
   - Tools: `read, bash, edit, write, grep, lint, find, ls`
   - Skills: `implement, tdd`
   - Description: "Implement features / fix bugs"

3. **Reviewer** - Read-only code reviewer with bash access
   - Tools: `read, bash, grep`
   - Skills: `code-review`
   - Description: "Review code changes / run bash diagnostics"

4. **Researcher** - Read-only research specialist with web search
   - Tools: `read, web_search, fetch_content, ls, grep, git-read, find`
   - Skills: `domain-modeling`
   - Description: "Research questions / gather info"

5. **Writer** - Documentation specialist with read/write access
   - Tools: `read, write, edit, ls, find, git-read`
   - Skills: `agents-md-writer`
   - Description: "Write / edit documentation"

### Key Functions
- `generateToolDoc()` - Legacy tool doc generator for module-load-time bootstrap
- `generateToolDocFromApi()` - Dynamic tool doc generator from pi.getAllTools()
- `updateToolDocs()` - Refresh tool doc variables from live pi.getAllTools() registry
- `getSpecialist()` - Get specialist by name
- `listSpecialists()` - List all specialist names
- `buildSkillSection()` - Generate skill section for subagent system prompt
- `getSpecialistSkills()` - Get resolved skill list with optional per-delegation override

### Key Constants
- `FINDINGS_AUDIT_TEMPLATE` - Shared findings + audit template for all specialist output formats
- `SCOPE_VIOLATION_GUIDANCE` - Injected into specialists with write/edit access
- `MINIMAL_ACTION` - Inlined minimal-action discipline
- `ACTIVITY_FEED_INSTRUCTION` - Activity feed instruction template for planSteps()/advanceStep() workflow
- `TERSE_INSTRUCTION` - Caveman instruction for token-efficient replies
- `SPECIALIST_VERBS` - Present-participle verb map for specialist working-loader messages

## 4. **docs/ Directory** - Architecture Documentation

### Key Documents

#### Architecture Decision Records (ADR)
- `0001-scope-enforcement-json-seam.md` - ScopeManager writes to `.pi/scope.json`, ScopeGuard reads raw JSON
- `0002-scope-file-fail-closed.md` - Malformed/stale scope files block ALL writes
- `0003-activity-feed-researcher-display.md` - Researcher tool calls display improvements
- `0004-fusion-tool-split.md` - Extract fusion-tool.ts into 7 focused modules
- `0005-delegate-controller-split.md` - Delegate controller refactoring
- `0006-scope-glob-patterns.md` - Scope glob pattern support

#### Specifications
- `SPEC-UI.md` - Orchestrator UI/UX specification (three-layer visibility system)
- `FUSION-SPEC.md` - Fusion subsystem specification
- `BASH-TOKEN-SAVER-SPEC.md` - Bash token saver specification
- `LINT-SPEC.md` - Lint guard specification

#### Documentation
- `VISION.md` - Three-layer visibility system vision document
- `UBIQUITOUS_LANGUAGE.md` - Domain glossary and terminology
- `CACHE-WORKFLOW.md` - Cache safety workflow documentation

#### PRDs
- `PRD.md` - Product requirements document
- `prd-skill-aware-delegation.md` - Skill-aware delegation PRD
- `orchestrator-handoff-scope-cache-fusion-ask.md` - Orchestrator handoff PRD

#### Agent Documentation
- `domain.md` - Domain documentation
- `issue-tracker.md` - Issue tracker documentation
- `STATUS.md` - Status documentation
- `triage-labels.md` - Triage labels documentation

## 5. **read-skill-tool.ts and skill-resolver.ts** - Skill Loading System

### read-skill-tool.ts
**Purpose**: Creates the `read_skill` tool definition for reading SKILL.md files from `~/.pi/agent/skills/{name}/SKILL.md`

**Key Features**:
- Path-sandboxing to prevent directory traversal
- Blocks path traversal characters (`..`, `/`, `\`)
- Returns full skill file content as text
- Error handling for missing skills and permission issues

### skill-resolver.ts
**Purpose**: Resolves skill files from the skills directory with validation and error handling

**Key Features**:
- Skill name validation (lowercase, letters/digits/hyphens only)
- Frontmatter parsing from SKILL.md files
- Comprehensive error handling (NOT_FOUND, PERMISSION_DENIED, FRONTMATTER_PARSE_FAILED, INVALID_NAME, IO_ERROR)
- Default skills root: `~/.pi/agent/skills`

## 6. **registration-hub.ts** - Tool and Command Registration

**Purpose**: Centralizes all register* calls for the orchestrator extension, extracted from index.ts.

**Key Functions**:
- `registerAllTools()` - Register all orchestrator tools and commands
- `registerBashWrapper()` - Register bash tool with interception
- `registerGlobAlias()` - Register glob tool alias that delegates to find tool

**Registered Components**:
1. Bash wrapper with destructive operation interception
2. Delegate tool
3. Plan tool
4. Fusion tool
5. List skills tool
6. List tools tool
7. Glob alias
8. Commands
9. Fusion commands

## Key Architectural Insights

### Three-Layer Visibility System
1. **Layer 0 - Enforcement**: Lint-guard, scope-guard, token-saver
2. **Layer 1 - Plan Panel**: TUI widget showing goal + step list (9-line budget)
3. **Layer 2 - Subagent Activity**: Chat blocks showing tool calls, output, spinners
4. **Layer 3 - Peek Overlay**: Ctrl+Q overlay showing live subagent conversation

### Cache Safety Pattern
- `setActiveTools()` must be called in `session_start` (not `before_agent_start`) to prevent prefix cache breaks
- Tool schemas must remain identical across turns for cache stability
- Non-deterministic summarization poisons cache

### Scope Enforcement Pattern
- ScopeManager writes to `.pi/scope.json` (JSON seam)
- ScopeGuard reads raw JSON directly (zero coupling)
- Fail-closed on malformed/stale scope files
- Version field for schema coordination

### Specialist Skill System
- Skills are task-driven, not hard-bound to specialist roles
- Default skills per specialist with optional per-delegation override
- Skills loaded from `~/.pi/agent/skills/{name}/SKILL.md`
- `getSpecialistSkills()` merges defaults with overrides (deduped)

### Tool Registration Pattern
- All tools registered during extension init
- Tool visibility controlled by `setActiveTools()` in `session_start`
- Not by register/unregister lifecycle
- Bash wrapper intercepts destructive operations