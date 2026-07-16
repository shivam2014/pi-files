# Research Summary: Bash Interceptor, Peek Overlay, Ask Resolver, and UI Files

## Overview
This research examines 11 specific files from the orchestrator extension, revealing a sophisticated system for managing AI agent orchestration with security controls, user interface components, debugging utilities, and interactive shell capabilities.

## File-by-File Analysis

### 1. `bash-classifier.ts` (74 lines)
**Purpose**: Classifies bash commands as read-only or write-modifying.

**Key Features**:
- Maintains sets of known read-only and write-modifying commands
- Uses simple string matching instead of regex for readability
- Handles special cases like `git stash list` and multi-word git subcommands
- Strips stderr-only redirects before checking for output redirections
- Defaults to blocking unknown commands (safe default)

**Security Implications**:
- Provides the foundation for command safety classification
- Used by other interceptor modules to make security decisions

### 2. `bash-interceptor.ts` (175 lines)
**Purpose**: Consolidated bash command interceptor with SDK tool_call event pattern.

**Key Features**:
- **Dangerous Command Detection**: Uses regex to identify dangerous patterns (`rm -rf /`, `git push --force`, etc.)
- **Tool Replacement Logic**: Redirects appropriate commands to native SDK tools:
  - `cat` → `read` tool
  - `grep`/`rg` → `grep` tool  
  - `find` → `find` tool
  - `ls` → `ls` tool
  - `sed`/`awk`/`perl` → `edit` tool when using `-i` flag
  - `mkdir`/`touch` → `write` tool
  - `python`/`node` → `edit` tool when file write indicators present
- **File Write Detection**: Identifies file write operations in Python/Node scripts
- **Recursive Remove Blocking**: Specifically blocks `rm -rf` commands

**Design Philosophy**:
- Intercepts at the mutation boundary (filesystem writes) rather than command usage
- Stream-processing commands without `-i` flags are allowed through
- Provides structured results indicating whether commands are allowed, redirected, or blocked

### 3. `bash-interceptor-integrated.ts` (74 lines)
**Purpose**: Integrated bash interceptor that reads specialist permissions dynamically from the SPECIALISTS registry.

**Key Features**:
- **Dynamic Permission Checking**: Reads from `SPECIALISTS` registry to determine if specialists have write+bash access
- **Dangerous Command List**: Maintains a list of always-blocked commands
- **Specialist-Aware Blocking**: Blocks write commands for specialists without proper permissions
- **Permission Logic**: A specialist has "write bash access" if they have "bash" AND at least one of "edit"/"write" in their tools

**Security Model**:
- Dangerous commands are always blocked regardless of specialist permissions
- Write commands are blocked for read-only specialists
- All other commands are allowed through

### 4. `peek-overlay.ts` (538 lines)
**Purpose**: Layer 3 live subagent conversation viewer overlay.

**Key Features**:
- **UI Component**: `PeekComponent` class renders live subagent content inside an overlay
- **Session Viewing**: Displays subagent goal, conversation messages, streaming text output
- **Auto-scrolling**: Automatically scrolls to show latest content
- **Line Capping**: Caps at ~50 lines maximum
- **Keyboard Controls**: Escape to close, double-press `x` to abort subagent
- **Streaming Buffer**: Accumulates streaming text with debounced re-renders (max ~5fps)
- **Session State Management**: Tracks viewer session, task, output, and status (idle/running/completed/error)

**UI Design**:
- Right-aligned overlay (50% width, 80% max height)
- Box-drawing characters for borders
- Status icons for different states
- Word-wrapping for text content
- Theme-aware styling through orchestrator-theme module

### 5. `ask-resolver.ts` (352 lines)
**Purpose**: Resolution system for subagent questions to orchestrator.

**Key Features**:
- **Resolution Order**:
  1. Files referenced in the question
  2. Project docs/ directory
  3. Recent conversation context
  4. Orchestrator escalation
- **Path Extraction**: Identifies file paths from text using multiple strategies
- **Docs Matching**: Matches question keywords against documentation filenames
- **Context Matching**: Uses keyword/fact matching against recent conversation context
- **Scope Resolution**: Boolean gate for determining if orchestrator should ask user before delegating

**File Detection**:
- Handles paths with slashes/backslashes
- Supports common code extensions
- Resolves relative paths against working directory
- Handles quoted/backticked paths

### 6. `orchestrator-theme.ts` (213 lines)
**Purpose**: Central theme and symbol module for the orchestrator extension.

**Key Features**:
- **Symbol System**: Defines Unicode symbols for status indicators, box drawing, tree connectors, separators, and icons
- **Theme Access**: Provides access to pi SDK Theme singleton
- **Status Icons**: Color-coded status icons (completed=green ✓, error=red ✗, running=accent spinner, etc.)
- **Formatting Helpers**:
  - `formatBadge()`: Wraps labels in colored brackets
  - `formatDuration()`: Human-readable duration formatting
  - `formatStatusLine()`: One-line status with icon, title, badge, and meta

**Design Philosophy**:
- Centralizes all symbol definitions in one place
- Every UI module imports this rather than reaching into SDK theme directly
- Provides consistent styling across the extension

### 7. `ui-utils.ts` (8 lines)
**Purpose**: Basic UI utility functions.

**Key Features**:
- `formatDuration()`: Converts milliseconds to human-readable format (0s, Xs, or Xm Ys)
- Simple, focused utility for time formatting

### 8. `spinner-state.ts` (28 lines)
**Purpose**: Shared spinner state as single source of truth for all UI modules.

**Key Features**:
- **Time-Derived Frames**: Spinner frame derived from wall-clock time, not mutable counter
- **Frame Calculation**: `SPINNER_FRAMES[⌊(now - startTime) / SPINNER_INTERVAL_MS⌋ % N]`
- **Reset Capability**: Can reset spinner to frame 0 on step transitions
- **Eliminates Double-Tick**: Prevents double-tick artifacts when multiple timers run concurrently

**Technical Details**:
- 80ms interval between frames
- 10-frame animation cycle using Braille characters
- All modules call `currentFrame()` at render time for consistent frames

### 9. `debug.ts` (53 lines)
**Purpose**: Debug logging for the orchestrator extension.

**Key Features**:
- **Log Directory**: Writes to `/tmp/orchestrator-debug/` with timestamped filenames
- **Auto-Cleanup**: Deletes debug logs older than 1 hour
- **Toggle Control**: Can enable/disable debug logging
- **Structured Logging**: Timestamps all entries with ISO format

### 10. `debug-path-trace.ts` (195 lines)
**Purpose**: Diagnostic tracing for file path handling in the orchestrator.

**Key Features**:
- **Path Transformation Tracing**: Logs actual `event.input.path` at every stage
- **Multiple Trace Points**:
  - `traceToolCallEntry()`: Raw event arrival
  - `tracePathsExtracted()`: After path collection from event.input
  - `tracePathResolved()`: After `path.resolve()` transformation
  - `traceScopeCheck()`: Scope check results
  - `traceDecision()`: Final block/allow decision
  - `traceMark()`: Generic markers for ad-hoc debugging

**Bug Investigation**:
- Designed to debug issue where scout reads "bash-interceptor.ts" but error shows "subagent-tools.ts"
- Logs stack traces to see call chains
- Captures event mutation scenarios

**Self-Test**:
- Includes self-test that demonstrates path mutation bug
- Shows how SDK reuses input objects causing path transformation issues

### 11. `interactive-shell-tool.ts` (382 lines)
**Purpose**: Register an `interactive_shell` tool for the orchestrator.

**Key Features**:
- **Session Management**: In-memory session store with fallback when `ctx.interactiveShell` unavailable
- **Multiple Modes**: Interactive, hands-free, dispatch, monitor
- **Background Execution**: Support for foreground/background session dispatch
- **Session Operations**:
  - List background sessions
  - Dismiss background sessions
  - Send input to running sessions
  - Send special keys (ctrl+c, enter)
  - Paste multiline input
  - Kill sessions
  - Query session status and output
- **Auto-Kill Timeout**: Sessions can be auto-killed after specified timeout
- **Output Management**: Captures stdout/stderr with line limiting (max 1000 lines)

**Tool Registration**:
- Uses TypeBox for parameter schema definition
- Integrates with pi SDK ExtensionAPI
- Supports structured spawn parameters for different agents

## Architecture Overview

### Security Layer
The bash security system forms a multi-layered defense:
1. **Classifier**: Identifies command types (read-only vs write-modifying)
2. **Interceptors**: Block dangerous commands and redirect appropriate ones
3. **Integrated Interceptor**: Applies specialist-specific permissions
4. **Tool Replacement**: Routes commands to appropriate SDK tools

### UI Layer
The UI system provides rich terminal interface capabilities:
1. **Theme System**: Centralized symbols and styling
2. **Spinner**: Time-derived animation frames
3. **Overlays**: Live subagent conversation viewing
4. **Formatting**: Consistent status display and formatting

### Debugging Layer
Comprehensive debugging capabilities:
1. **Debug Logging**: General debug output with auto-cleanup
2. **Path Tracing**: Specialized tracing for path handling bugs
3. **Self-Tests**: Built-in validation for debugging tools

### Orchestration Layer
Supports agent coordination and question resolution:
1. **Ask Resolver**: Multi-strategy question answering
2. **Interactive Shell**: Session management for CLI tools
3. **Specialist Integration**: Dynamic permission checking

## Key Design Patterns

### 1. Safety by Default
- Unknown commands are blocked by default
- Read-only specialists cannot execute write commands
- Dangerous commands are always blocked regardless of context

### 2. Mutation Boundary Interception
- Intercepts at filesystem mutation points rather than command usage
- Allows stream-processing commands while blocking file writes
- Provides appropriate tool redirection for common operations

### 3. Centralized Configuration
- Theme and symbols defined in one place
- Debug logging centralized with consistent formatting
- Permission checking through registry-based system

### 4. Resilient Fallbacks
- Interactive shell falls back to child_process when SDK unavailable
- Path resolution handles multiple formats and edge cases
- Debug systems handle initialization failures gracefully

### 5. Time-Based State
- Spinner frames derived from wall-clock time
- Debug logs use timestamps for ordering
- Session tracking includes start/end times

## Integration Points

### With Pi SDK
- Theme integration through globalThis singleton
- ExtensionAPI for tool registration
- InteractiveShell API when available
- TypeBox for parameter schemas

### With Specialists
- Dynamic permission checking from SPECIALISTS registry
- Specialist-aware command blocking
- Role-based access control

### With UI Components
- Peek overlay integrates with TUI system
- Theme styling applied consistently
- Status icons used across all UI elements

## Security Considerations

### Command Safety
- Multi-layered command classification
- Dangerous pattern detection with regex
- Recursive remove blocking
- Stderr redirect handling to prevent evasion

### Permission Enforcement
- Specialist-specific permission checking
- Write access requires explicit tool permissions
- Read-only specialists cannot bypass restrictions

### Path Safety
- Path validation and resolution
- Scope checking for file operations
- Debugging tools to trace path transformations

## Performance Characteristics

### Efficient Processing
- Simple string matching for command classification
- Regex only where necessary (dangerous patterns)
- Time-derived spinner frames avoid timer conflicts

### Resource Management
- Debug log auto-cleanup (1 hour retention)
- Session output capping (1000 lines max)
- Peek overlay line limiting (50 lines max)
- Streaming buffer garbage collection (5000 chars max)

### Scalability
- Session-based architecture supports multiple concurrent sessions
- Background session management for long-running operations
- Debounced UI updates prevent render storms

## Testing and Validation

### Built-in Tests
- `debug-path-trace.ts` includes self-test demonstrating path mutation bug
- Test cases validate path extraction and resolution
- Event mutation scenarios documented

### Error Handling
- Graceful fallbacks throughout the system
- Comprehensive error logging
- Debug tools for diagnosing issues

## Future Considerations

### Extensibility
- Symbol system easily extended with new keys
- Theme system supports custom colors and formatting
- Tool replacement logic can be expanded

### Monitoring
- Path tracing can be enabled for production debugging
- Debug logging provides runtime visibility
- Session tracking enables usage analytics

### Security Enhancements
- Could add more dangerous command patterns
- Specialist permissions could be made more granular
- Path validation could be strengthened further

## Conclusion

This set of files represents a well-architected orchestration system with strong security foundations, rich UI capabilities, comprehensive debugging tools, and flexible agent coordination. The system demonstrates careful consideration of security, usability, and maintainability, with multiple layers of defense and fallback mechanisms throughout.