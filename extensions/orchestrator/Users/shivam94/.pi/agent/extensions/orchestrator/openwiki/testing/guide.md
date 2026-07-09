# Testing Guide

## Running Tests

```bash
# Run all tests
npx vitest run

# Run specific test file
npx vitest run scope-guard.test.ts

# Run tests matching a pattern
npx vitest run -t "scope"
```

## Test Infrastructure

### Vitest Configuration

`vitest.config.ts` configures:
- **Path aliases**: `@earendil-works/*` maps to `~/.pi/agent/extensions/node_modules/@earendil-works/pi-coding-agent`
- **Legacy support**: Also maps `@mariozechner/*` namespace
- **Setup file**: `test-setup.ts` initializes SDK theme singleton

### Test Setup

`test-setup.ts`:
- Calls `initTheme("dark")` in `beforeAll`
- Ensures SDK theme is available for all tests

### Test Files

| File | Tests |
|------|-------|
| `scope-guard.test.ts` | Scope enforcement, path matching, glob patterns, file size limits |
| `scope-manager.test.ts` | Scope normalization, read/write, resolve |
| `delegate-pipeline.test.ts` (via `test-unit.test.ts`) | Delegation pipeline, validation, scope resolution |
| `delegate-tool.test.ts` | Tool registration, parameters, render functions |
| `delegate-feed-builder.test.ts` | Activity feed construction |
| `delegate-controller.test.ts` | Delegation lifecycle hooks |
| `fusion-tool.test.ts` | Fusion tool registration and execution |
| `fusion-config.test.ts` | Config loading, validation |
| `fusion-format.test.ts` | Output formatting |
| `fusion-judge.test.ts` | Judge synthesis |
| `fusion-models.test.ts` | Model selection |
| `fusion-utils.test.ts` | Utility helpers |
| `plan-panel-*.test.ts` | Plan panel operations (advance, finalize, singleton, tools) |
| `plan-tool.test.ts` | Plan tool registration |
| `activity-feed.test.ts` | Activity feed tracking |
| `bash-interceptor.test.ts` | Bash command interception |
| `ask-resolver.test.ts` | Ask resolution logic |
| `subagent-runner.test.ts` | Subagent session creation |
| `subagent-diagnostics.test.ts` | Failure detection, diagnostics |
| `subagent-tool-guard.test.ts` | Tool guard enforcement |
| `subagent-event-router.test.ts` | Event routing |
| `introspection-tools.test.ts` | Skill/tool listing |
| `skill-resolver.test.ts` | Skill resolution |
| `read-skill-tool.test.ts` | Read skill tool |
| `registration-hub.test.ts` | Tool registration |
| `init-guard.test.ts` | Init phase safety |
| `architecture-consistency.test.ts` | Architecture rules |
| `test-unit.test.ts` | Unit tests for delegation |
| `test-mock-e2e.test.ts` | Mock E2E tests |
| `ask-orchestrator.test.ts` | Ask orchestrator flow |
| `peek-overlay.test.ts` | Peek overlay |
| `specialist-skills.test.ts` | Skill loading |
| `specialists.test.ts` | Specialist roster |
| `fusion-toggle.test.ts` | Fusion on/off |
| `architecture-consistency.test.ts` | Architecture rules |
| `scope-guard.test.ts.bak` | Backup of scope guard tests |

## Test Patterns

### Snapshot Testing

Many tests use Vitest snapshots to verify TUI output:
```typescript
expect(result).toMatchSnapshot();
```

This catches regressions in formatting, symbols, and layout.

### Mock E2E

`test-mock-e2e.test.ts` provides end-to-end tests with mocked SDK:
- Simulates full delegation flow
- Tests scope enforcement in context
- Verifies activity feed output

### Architecture Consistency

`architecture-consistency.test.ts` enforces architectural rules:
- No direct imports between certain modules
- File size limits
- Naming conventions

## Interactive Testing

`test-visual.sh` provides interactive shell tests:
```bash
bash test-visual.sh
```

`TEST-PLAN.md` documents 11 interactive shell tests covering:
- Extension loading
- Delegation flows
- Scope enforcement
- Adaptive gating

## What to Check When Making Changes

### Scope System Changes
1. Run `scope-guard.test.ts` and `scope-manager.test.ts`
2. Verify glob pattern behavior with picomatch
3. Check fail-closed behavior (missing/malformed scope)
4. Test expansion request flow

### Delegation Changes
1. Run `test-unit.test.ts` and `test-mock-e2e.test.ts`
2. Verify scope is cleared after delegation
3. Check metrics tracking
4. Test diagnostics for silent failures

### Fusion Changes
1. Run all `fusion-*.test.ts` files
2. Verify temperature fallback behavior
3. Check model selection diversity
4. Test config validation (fail-closed)

### UI Changes
1. Check snapshot tests for formatting regressions
2. Verify theme symbols from `orchestrator-theme.ts`
3. Test spinner state (time-derived, no mutable state)
4. Run `test-visual.sh` for interactive verification

### Skill Changes
1. Run `skill-resolver.test.ts` and `read-skill-tool.test.ts`
2. Verify path sandboxing
3. Test frontmatter parsing
4. Check name validation

## Anti-Patterns (from AGENTS.md)

- **Don't weaken scope enforcement to pass tests**
- **Don't add prompt-level reminders** — they decay. Tool-level gate is the enforcement.
- **Don't let the gate crash the agent** — self-correct in one turn.

## Debugging

### Debug Logging

Enable debug logging:
```typescript
import { setDebugEnabled, debugLog } from './debug';
setDebugEnabled(true);
debugLog('message');
```

Logs written to `/tmp/orchestrator-debug/orchestrator-<timestamp>.log`. Auto-cleanup after 1 hour.

### Path Tracing

Enable path tracing:
```bash
DEBUG_PATH_TRACE=1
```

Or programmatically:
```typescript
import { enablePathTrace } from './debug-path-trace';
enablePathTrace();
```

Traces file path resolution through the system.

### Diagnostics

Subagent failures are persisted to `/diagnostics/YYYY-MM-DD/{sessionId}/`. Check this directory for:
- Silent failures (0 tool calls, short output)
- Crashes (no output at all)
- 30-day auto-cleanup

### TUI Smoke Testing

```bash
bash ~/.pi/tui-smoke.sh pi "create /tmp/test.txt with content hello"
bash ~/.pi/tui-smoke.sh pi "investigate the auth system and add logging"
```

Check snapshot files in `/tmp/tui-smoke-*/`.
