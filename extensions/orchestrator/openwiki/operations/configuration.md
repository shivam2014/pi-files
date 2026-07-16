# Configuration & Operations

## Orchestrator Configuration

**File**: `/orchestrator-config.ts`  
**Config file**: `~/.pi/agent/orchestrator.yml`

The orchestrator supports YAML configuration for delegation behavior. The config uses a minimal 2-level nesting parser — no external YAML library required.

### Config Schema

```typescript
interface OrchestratorConfig {
  version: number;                    // Config schema version (default: 1)
  delegation: {
    mode: "sequential" | "parallel";  // Delegation strategy (default: "sequential")
    parallel: {
      maxConcurrent: number;          // Max parallel delegations (default: 4)
      timeoutMs: number;              // Timeout per parallel delegation (default: 120000)
    };
  };
}
```

### Config Loading

`loadOrchestratorConfig()` reads `~/.pi/agent/orchestrator.yml`, parses it, and merges with defaults. Malformed YAML falls back to defaults — no crash, no user prompting.

### Session Mode Overrides

Delegation mode can be overridden per-session without modifying the config file:

| Function | Description |
|----------|-------------|
| `getSessionMode(ctx)` | Returns session-specific mode or default from config |
| `setSessionMode(ctx, mode)` | Sets session-specific override |
| `clearSessionMode(ctx)` | Clears session override, reverts to config default |

### Example Config

```yaml
version: 1
delegation:
  mode: sequential
  parallel:
    maxConcurrent: 4
    timeoutMs: 120000
```

## Slash Commands

**File**: `/commands.ts`

| Command | Description |
|---------|-------------|
| `/orchestrate <task>` | Manual orchestration trigger — sends task as followUp message |
| `/specialists` | List available specialists and their tool sets |
| `/inspect` | Dump orchestrator state as JSON → `/tmp/orchestrator-inspect.json` |
| `/render` | Capture current TUI render output → `/tmp/orchestrator-render.txt` |
| `/timeline` | Write render timeline (max 500 frames) → `/tmp/orchestrator-timeline.json` |
| `/timeline-diff` | Write timeline diff → `/tmp/orchestrator-timeline-diff.json` |
| `/debug-orchestrator [on\|off\|status]` | Toggle debug logging or show snapshot |
| `/delegate-mode [sequential\|parallel\|status]` | Toggle/set delegation mode |

### Fusion Commands

**File**: `/fusion-commands.ts`

| Command | Description |
|---------|-------------|
| `/fusion on` | Enable fusion |
| `/fusion off` | Disable fusion |
| `/fusion status` | Show fusion status (enabled, panel models, judge, temperature) |
| `/fusion` (no args) | Open interactive fusion TUI |

## Debug Facilities

### Debug Logging

**File**: `/debug.ts`

Debug logging writes timestamped log lines to `/tmp/orchestrator-debug/orchestrator-<timestamp>.log`.

| Function | Description |
|----------|-------------|
| `setDebugEnabled(true/false)` | Toggle debug logging |
| `isDebugEnabled()` | Check if debug logging is active |
| `debugLog(...args)` | Write a debug log line (only when enabled) |

Auto-cleans log files older than 1 hour on each write.

**Activation**: `/debug-orchestrator on` or `setDebugEnabled(true)` in code.

### Path Tracing

**File**: `/debug-path-trace.ts`

Diagnostic tracing for file path handling. Created to investigate a bug where scout reads "bash-interceptor.ts" but error shows "subagent-tools.ts".

| Function | Description |
|----------|-------------|
| `setPathTrace(true/false)` | Toggle path tracing |
| `enablePathTrace()` | Enable path tracing |

**Activation**: Set `DEBUG_PATH_TRACE=1` env var or call `enablePathTrace()`.  
**Output**: `/tmp/orchestrator-debug/path-trace-<timestamp>.log`

## Diagnostics

**File**: `/subagent-diagnostics.ts`  
**Output directory**: `/diagnostics/<date>/`

After each delegation completes (or crashes), a diagnostic snapshot is captured and persisted:

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
  metrics: DelegationMetrics;  // read/grep/find/edit/write/bash/ls calls, scope violations
  diagnosticId: string;
  kind: "silent_failure" | "crash";
}
```

Diagnostics are stored as JSON files under `/diagnostics/YYYY-MM-DD/`.

## Interactive Shell Tool

**File**: `/interactive-shell-tool.ts`

The `interactive_shell` tool provides managed CLI session execution for the orchestrator. It can run external commands (pi, claude, codex, gemini, or arbitrary shell commands) in foreground/background with monitoring capabilities.

### Modes

| Mode | Description |
|------|-------------|
| **interactive** | Standard foreground session — run command and get output |
| **hands-free** | Background session with event-driven watchers — monitors output for patterns |
| **dispatch** | Send input to a running background session |
| **monitor** | Attach to and observe a running session |

### Lifecycle

1. `start` → Creates a child process session with auto-kill timeout
2. `query` → Read output lines (configurable limit, default 20)
3. `send` → Send text/keys/paste to stdin
4. `kill` → Terminate the session

### Key Features

- Background session management with auto-kill timeout (default 5 minutes)
- Output line limiting (default 20, max 200)
- Fallback to `child_process` when SDK `ctx.interactiveShell` is unavailable
- Event-driven watchers for hands-free monitoring

## Runtime Output Files

| File | Source | Description |
|------|--------|-------------|
| `/tmp/orchestrator-inspect.json` | `/inspect` | Full orchestrator state dump |
| `/tmp/orchestrator-render.txt` | `/render` | Current TUI render snapshot |
| `/tmp/orchestrator-timeline.json` | `/timeline` | Render timeline (max 500 frames) |
| `/tmp/orchestrator-timeline-diff.json` | `/timeline-diff` | Timeline state transitions |
| `/tmp/orchestrator-snapshot.json` | `/debug-orchestrator` | Debug snapshot (plan, feed, fusion) |
| `/tmp/orchestrator-debug/*.log` | debug.ts | Timestamped debug logs |

## Key Source Files

| File | Role |
|------|------|
| `/orchestrator-config.ts` | YAML config loading, session mode management |
| `/commands.ts` | Slash command registration |
| `/fusion-commands.ts` | Fusion-specific slash commands |
| `/debug.ts` | Debug logging infrastructure |
| `/debug-path-trace.ts` | File path diagnostic tracing |
| `/subagent-diagnostics.ts` | Post-run diagnostic capture + persistence |
| `/interactive-shell-tool.ts` | Interactive CLI session management |
