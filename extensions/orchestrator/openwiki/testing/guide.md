# Testing Guide

## Running Tests

```bash
# Run all tests
npx vitest run

# Run a specific test file
npx vitest run scope-guard.test.ts

# Run tests matching a pattern
npx vitest run -t "addSubstep"

# Type-check without emitting
npx tsc --noEmit
```

## Test Infrastructure

### Vitest Configuration

**File**: `/vitest.config.ts`

The test config sets up path aliases to resolve SDK imports from the installed `@earendil-works/pi-coding-agent` package located at `~/.pi/agent/extensions/node_modules/@earendil-works/pi-coding-agent`.

Key aliases:
- `@earendil-works/pi-coding-agent` → SDK main export
- `@earendil-works/pi-ai` → AI framework
- `@earendil-works/pi-tui` → TUI framework
- `@earendil-works/pi-agent-core` → Agent core
- `typebox` → Schema validation library

### Test Setup

**File**: `/test-setup.ts`

Initializes the SDK theme singleton (`initTheme("dark")`) via `beforeAll`. This is required because `getTheme()` in `orchestrator-theme.ts` accesses a global symbol that is only set in production by the pi runtime.

**Critical**: Tests must trigger `session_start` before `before_agent_start` to exercise the tool-freezing handler. Without this, `setActiveTools` never fires and `getActiveToolsHistory()` returns `undefined`.

### Init-Phase Constraint

The pi SDK throws "Extension runtime not initialized" if action methods (`getAllTools`, `setActiveTools`, `sendMessage`, etc.) are called before `session_start`. Only registration methods (`registerTool`, `registerCommand`, `on`) are safe during extension init. The `init-guard.test.ts` test verifies this by creating a mock API where all action methods throw, then calling the extension's default export and asserting no error occurs.

### Snapshots

TUI output snapshots are stored in `/__snapshots__/`. Vitest manages these automatically. Update snapshots with:

```bash
npx vitest run --update
```

## Test File Inventory

### Core Delegation Tests

| File | What It Tests |
|------|--------------|
| `delegate-tool.test.ts` | Tool registration, parameter validation, render phases |
| `delegate-controller.test.ts` | Validation, error handling, specialist lookup |
| `delegate-pipeline.test.ts` | End-to-end pipeline: scope → run → format → cleanup |
| `delegate-feed-builder.test.ts` | Activity feed lifecycle: start, tool calls, reports, completion |
| `delegate-output-formatter.test.ts` | Result formatting, metrics line, audit extraction (functions now in `delegate-pipeline.ts`) |

### Scope Enforcement Tests

| File | What It Tests |
|------|--------------|
| `scope-guard.test.ts` | Path checking (exact, glob, directory prefix), fail-closed, expansion requests |
| `scope-manager.test.ts` | Scope normalization, path handling, read/write/clear cycle |

### Subagent Runner Tests

| File | What It Tests |
|------|--------------|
| `subagent-runner.test.ts` | Session creation, tool definitions, output truncation, env isolation |
| `subagent-tool-guard.test.ts` | Tool filtering, plan-first enforcement, scope integration, bash interception |
| `subagent-diagnostics.test.ts` | Failure detection, Q&A suppression, secret redaction, persistence |
| `subagent-event-router.test.ts` | Event subscription, emission, handler lifecycle |

### Plan Panel Tests

| File | What It Tests |
|------|--------------|
| `plan-panel-singleton.test.ts` | Instance management (Map keyed by sessionId) |
| `plan-panel-advance.test.ts` | Step advancement, completion, error states |
| `plan-panel-finalize.test.ts` | Plan cleanup, delegation tracking |
| `plan-panel-tools.test.ts` | plan, plan_add_steps, insert_step, remove_step, modify_step |
| `plan-tool.test.ts` | Tool registration and parameter schemas |

### Fusion Tests

| File | What It Tests |
|------|--------------|
| `fusion-tool.test.ts` | Tool registration, pipeline execution, model resolution |
| `fusion-pipeline.test.ts` | Panel phase, judge phase, temperature fallback |
| `fusion-config.test.ts` | Config loading, merging, sanitization |
| `fusion-models.test.ts` | Model resolution, auto-diverse panel selection |
| `fusion-judge.test.ts` | JSON extraction from markdown fences, validation |
| `fusion-format.test.ts` | Result formatting, panel-only fallback |
| `fusion-utils.test.ts` | extractText, mapWithConcurrencyLimit |
| `fusion-toggle.test.ts` | Enable/disable toggle via setActiveTools |

### UI & Rendering Tests

| File | What It Tests |
|------|--------------|
| `activity-feed.test.ts` | Feed state machine, step/substep lifecycle, rendering |
| `peek-overlay.test.ts` | Overlay state, streaming text, MIN_HEIGHT stability |

### Other Module Tests

| File | What It Tests |
|------|--------------|
| `ask-resolver.test.ts` | Resolution logic: files, docs, context, escalation |
| `ask-orchestrator.test.ts` | ask_orchestrator tool behavior |
| `bash-interceptor.test.ts` | Bash→tool redirection (cat→read, grep→grep, etc.) |
| `bash-classifier.test.ts` | Read/write command classification |
| `init-guard.test.ts` | Init-phase safety: no SDK action methods called during extension load |
| `introspection-tools.test.ts` | list_skills, list_tools runtime queries |
| `prompt-builder.test.ts` | System prompt construction, routing table generation |
| `read-skill-tool.test.ts` | Skill loading, path sandboxing, traversal blocking |
| `registration-hub.test.ts` | Centralized tool/command registration |
| `skill-resolver.test.ts` | Skill path resolution, missing file handling |
| `specialists.test.ts` | Specialist registry, tool docs |
| `specialist-skills.test.ts` | Skill merge behavior, override vs defaults |

### Integration Tests

| File | What It Tests |
|------|--------------|
| `test-mock-e2e.test.ts` | Full delegation flow with mock events (activity feed state machine) |
| `test-unit.test.ts` | Cross-module unit tests (feed immutability, peek exports, duration formatting) |
| `architecture-consistency.test.ts` | Module dependency checks, import boundaries |

## Test Patterns

### Mock ExtensionAPI

Most tests create a mock `pi` (ExtensionAPI) object:

```typescript
function createMockPi(): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerShortcut: vi.fn(),
    sendMessage: vi.fn(),
    setActiveTools: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    trigger: vi.fn(),
    // ... other methods as needed
  } as any;
}
```

### Mock Context

Tests that need an `ExtensionContext` provide:

```typescript
const mockCtx = {
  cwd: "/tmp/test-project",
  sessionId: "test-session-123",
  mode: "tui",
  ui: {
    notify: vi.fn(),
    setWorkingMessage: vi.fn(),
    setStatus: vi.fn(),
    theme: {},
  },
};
```

### Activity Feed Testing

The activity feed uses an immutable state pattern. Tests typically:

1. Create initial state: `createActivityFeed()`
2. Add steps: `addStep(state, "label")`
3. Add substeps: `addSubstep(state, "label")`
4. Complete: `completeLastSubstep(state)`, `completeCurrentStep(state)`
5. Assert: check `.steps`, `.currentStep`, `.planParsed`

### Scope Guard Testing

Tests verify the three-tier path matching:

1. **Exact match**: `filesToModify: ["/abs/path/file.ts"]`
2. **Glob match**: `filesToModify: ["src/**/*.ts"]` (picomatch)
3. **Directory prefix**: `directories: ["/abs/path/src/"]`

And fail-closed scenarios (missing file, bad JSON, wrong version).

### Session Lifecycle Testing

For tests exercising `session_start` → `before_agent_start` → `tool_call`:

```typescript
await pi.trigger("session_start", {}, { cwd });
await pi.trigger("before_agent_start", event, ctx);
await pi.trigger("tool_call", { toolName: "delegate", input: {...} }, ctx);
```

## Running Smoke Tests

The interactive smoke test (`test-visual.sh`) runs targeted prompts through the TUI:

```bash
bash test-visual.sh "create /tmp/test.txt with content hello"
bash test-visual.sh "investigate the auth system and add logging"
```

Check snapshot files in `/tmp/tui-smoke-*/` for rendered output.

## Key Testing Principles

1. **Tool-level enforcement, not prompt-level**: Test that scope-guard blocks writes, not that prompts mention scope.
2. **Fail-closed**: Verify that malformed/missing scope.json blocks ALL writes.
3. **Self-correction**: Blocked subagents continue running and can recover.
4. **Immutability**: Activity feed state functions return new objects, never mutate inputs.
5. **Cache safety**: `session_start` freezes tools before `before_agent_start` — tests must follow this order.
