# ADR-0005: Split delegate-controller.ts into focused modules

## Status
Accepted

## Context
`delegate-controller.ts` grew to 437 lines mixing 5 concerns:
1. Scope normalization (pure logic for default scopes per specialist)
2. Scope application (side-effectful: AskResolver gate + ScopeManager write)
3. Subagent diagnostics (capture + persist to disk)
4. Result formatting (metadata, findings, audit, metrics, status)
5. Orchestration glue (UI, plan steps, runSubagent, cleanup)

This violates SRP and makes each concern harder to test independently.

## Decision
Split into 5 modules following ADR-0004 precedent (extract modules, keep thin hub, no behavioral changes):

### New modules
| Module | Lines | Responsibility | Side effects |
|--------|-------|----------------|--------------|
| `resolve-delegation-scope.ts` | ~70 | Pure scope normalization per specialist type | None |
| `apply-scope.ts` | ~35 | AskResolver gate + ScopeManager write | File I/O |
| `handle-diagnostics.ts` | ~55 | captureDiagnostic + persist + cleanup | Disk I/O |
| `delegate-result-processor.ts` | ~115 | Format output with metadata/findings/audit/metrics | None |
| `delegate-controller.ts` | ~230 | Thin orchestrator: UI, plan steps, runSubagent, cleanup | All orchestration |

### New type in `types.ts`
```ts
export interface DelegateControllerContext {
  cwd: string;
  sessionId?: string;
  modelRegistry?: any;
  model?: any;
  ui?: any;
  notify?: (msg: string, level: string) => void;
}
```

## Consequences

### Preserved
- `executeDelegate()` remains sole export from `delegate-controller.ts`
- `ExecuteDelegateResult` interface unchanged
- All early-return paths preserved (scope_vague, no plan, coder-without-scope)
- All error messages preserved exactly
- `runSubagent` call signature unchanged
- `onUpdate` callback contract unchanged
- `delegate-tool.ts` imports unchanged

### Vocabulary (codebase-design terms)
- **seam**: Each extraction point is a clean seam — a boundary where one concern ends and another begins.
- **adapter**: `apply-scope.ts` acts as an adapter between pure scope resolution and the side-effectful AskResolver/ScopeManager.
- **leverage**: Each extracted module has 1-2 exports, giving callers maximum leverage — import only what you need.
- **locality**: Related logic lives in one file. Changing scope normalization doesn't require reading diagnostics code.

### Not touched
- `plan-panel.ts`, `subagent-runner.ts`, `peek-overlay.ts`, and all other modules
- UI notifications and plan step updates stay in controller (orchestrator concern)
- No new dependencies introduced

### Testing
- Each extracted module is independently testable
- `resolve-delegation-scope.ts` is a pure function (easy unit test)
- `delegate-result-processor.ts` is a pure function (easy unit test)
- `handle-diagnostics.ts` and `apply-scope.ts` have clear side-effect boundaries

## Alternatives considered
- **Single extract + barrel**: Rejected — hides the separation benefit
- **Class-based decomposition**: Rejected — functions are simpler, matches codebase style
- **Extract formatResult from delegate-output-formatter.ts**: Already exists — delegate-result-processor.ts calls it indirectly through the same extract* helpers
