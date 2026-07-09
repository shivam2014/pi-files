# Plan Panel Fix — Final Design

## New data model: Step kind

```typescript
interface PlanStep {
  label: string;
  kind: 'delegation' | 'orchestrator';  // prevents double-advance
  completed: boolean;
  active: boolean;
  errored?: boolean;
  errorMessage?: string;
  detail?: string;
  detailLines?: string[];
  startTime?: number;
  endTime?: number;
}
```

When plan() creates steps, the orchestrator doesn't specify kind — it's inferred:
- Steps that get delegated → kind: 'delegation' (set by startDelegationStep())
- Steps the orchestrator does itself → kind: 'orchestrator' (set by advance_plan_step())

## New PlanPanel class methods

| Method | Behavior |
|--------|----------|
| insertStep(index, label, kind?) | Insert at position (1-based externally, 0-based internally). Default kind: 'orchestrator'. Re-render widget. |
| removeStep(index) | Remove step. Refuse if step is active — return error. Shift subsequent indices. Re-render widget. |
| modifyStep(index, label, kind?) | Change label and/or kind. Re-render widget. |
| advanceStep() | Complete current active step, advance to next pending. Only for kind='orchestrator' — no-op if active step is delegation. Re-render widget. |

## New tools (orchestrator-callable)

| Tool | Params | Behavior |
|------|--------|----------|
| advance_plan_step() | {} (no params) | Wraps advanceStep(). Only advances orchestrator-owned steps. Error if active step is delegation. |
| insert_step | { index: number, label: string, kind?: string } | Wraps insertStep(). 1-based index. |
| remove_step | { index: number } | Wraps removeStep(). 1-based index. Refuses active step. |
| modify_step | { index: number, label: string, kind?: string } | Wraps modifyStep(). 1-based index. |

## Fix startDelegationStep()

Before: Overwrites pending step's label with delegation label.
After: Only activates the step. Label stays. If orchestrator wants a different label, it calls modify_step() first.

```typescript
// BEFORE
startDelegationStep(label: string) {
  const step = this.steps.find(s => !s.completed && !s.active);
  if (step) {
    step.label = label;  // OVERWRITES
    step.active = true;
  }
}

// AFTER
startDelegationStep(label: string) {
  const step = this.steps.find(s => !s.completed && !s.active);
  if (step) {
    step.active = true;
    step.kind = 'delegation';
    step.startTime = Date.now();
    // Label preserved — orchestrator uses modify_step() if needed
  }
}
```

## Double-advance prevention

| Scenario | What happens |
|----------|--------------|
| Subagent finishes → delegate-pipeline.ts auto-advances | Step kind='delegation', pipeline advances. ✅ |
| Orchestrator finishes own work → calls advance_plan_step() | Step kind='orchestrator', tool advances. ✅ |
| Orchestrator mistakenly calls advance_plan_step() on delegation step | Tool returns error: "This step is delegation-owned. It will advance automatically when the subagent returns." ✅ |
| Pipeline tries to advance orchestrator step | Doesn't happen — pipeline only advances the active step, which is delegation-owned. ✅ |

## Prompt fix

Before:

```
"After each delegate() returns, do any orchestrator analysis before moving to the next step. The plan panel tracks progress automatically."
```

After:

```
Delegation steps advance automatically when the subagent returns. For your own analysis/synthesis/fusion steps, call advance_plan_step() after completing the work. Use insert_step/remove_step/modify_step when subagent output reveals the plan should change.
```

## Allowed-tools whitelist fix

Before: Whitelist hardcoded in index.ts tool_call guard.
After: Single const array exported from one module, imported by both guard and tool registration:

```typescript
// plan-tools.ts (new or in plan-tool.ts)
export const PLAN_TOOLS = ['plan', 'plan_add_steps', 'advance_plan_step', 'insert_step', 'remove_step', 'modify_step'] as const;

// index.ts
import { PLAN_TOOLS } from './plan-tool';
// tool_call guard uses PLAN_TOOLS for whitelist check
```

## Files to change

| File | Change |
|------|--------|
| types.ts | Add kind: 'delegation' \| 'orchestrator' to PlanStep interface |
| plan-panel.ts | Add insertStep(), removeStep(), modifyStep(), advanceStep() methods. Fix startDelegationStep() to not overwrite labels. Add widget refresh after every mutation. |
| plan-tool.ts | Register advance_plan_step, insert_step, remove_step, modify_step tools. Export PLAN_TOOLS whitelist. |
| index.ts | Import PLAN_TOOLS for tool_call guard whitelist. Add new tools to allowed list. |
| prompt-builder.ts | Fix "tracks progress automatically" claim. Add step management guidance. |
| docs/VISION.md | Already updated with plan panel vision. |

## Tests needed

| Test case | What it verifies |
|-----------|------------------|
| insert_step before active step | Active step index shifts correctly |
| insert_step after active step | No shift, step added correctly |
| remove_step on pending step | Step removed, indices shift |
| remove_step on active step | Refuses with error |
| remove_step on completed step | Step removed, indices shift |
| modify_step label change | Label updates, widget refreshes |
| modify_step kind change | Kind updates (delegation → orchestrator) |
| advance_plan_step on orchestrator step | Step completes, advances to next |
| advance_plan_step on delegation step | Returns error, no advancement |
| advance_plan_step when no active step | No-op or error |
| widget refresh after every mutation | UI stays consistent |

## Summary: What changed from original fix

| Original proposal | Final design |
|-------------------|--------------|
| advance_plan_step() with no kind check | Add kind field, restrict to orchestrator steps |
| startDelegationStep() keeps labels | startDelegationStep() never overwrites labels |
| Tools only, no class methods | PlanPanel class methods + tools as thin wrappers |
| Whitelist in index.ts | Single-source PLAN_TOOLS const |
| "Call advance_plan_step() after work" | Full prompt teaching delegation vs orchestrator lifecycle |
| No tests | 11 edge-case tests defined |
