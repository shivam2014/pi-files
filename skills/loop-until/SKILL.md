# loop-until

## When to Use

Use `loop_until` for iterative tasks with checkable completion criteria — when the orchestrator needs to repeatedly delegate/evaluate until a criterion is met.

**Confirm ALL THREE before using loop_until:**
1. Criterion is checkable by an evaluator (not subjective like "looks good")
2. Endpoint is NOT known upfront (if you know the exact file, single-pass)
3. Iterations produce measurably different output (not just shuffling)

## When NOT to Use

- Single deliverables ("write the README", "add a logout button")
- Known endpoints ("fix bug in auth.ts line 42")
- Subjective completion ("make it look good", "clean up the docs")

If uncertain, ask the user: "This looks like it might need iteration. Want me to loop until the criterion is met, or do a single pass?"
The user can also explicitly request a loop: "keep fixing until clean"

## Syntax

Loop step in a plan:
```js
plan("Fix all lint errors", [{
  label: "Fix until clean",
  kind: "loop_until",
  loopUntil: {
    criterion: "Zero lint errors",
    evaluator: "reviewer",
    maxIterations: 5,
    mode: "satisficing",
    satisficingPasses: 1,
    iterationTemplate: { specialist: "coder", task: "Fix lint errors" }
  }
}])
```

Mixed with single steps:
```js
plan("Resolve all issues", [
  "Read all open issues",
  { label: "Fix each issue", kind: "loop_until", loopUntil: { ... } },
  "Summarize results"
])
```

## Behavior

### Loop step execution
- loop_until steps execute internally — the plan panel runs iterations automatically. You do NOT manually delegate for each iteration.
- The loop handles: iteration counting, evaluation, feedback, stopping.
- After each iteration, the loop updates the rolling summary (visible in plan panel) and checks the criterion.
- If criterion met → loop completes, step marked done.
- If maxIterations exhausts → loop surfaces last evaluation to you with a ⚠️ message. You decide: escalate to user, refine criteria, or add follow-up steps.
- If oscillation detected (2 consecutive iterations with net-zero progress) → loop exits early with diagnostic.

### Loop output
- If satisfied: read the final iteration's output and proceed.
- If exhausted: output contains per-iteration delta. If net progress was made, consider plan_add_steps([follow-up loop]). If no progress, report ⚠️ to user.

### After a loop step completes
- If satisfied: proceed with next step.
- If exhausted with progress: consider follow-up loop with refined criterion.
- If exhausted without progress: report ⚠️ to user with diagnostic.

### Plan-step rules for loops
- A loop_until step is ONE plan step that internally executes multiple delegate/evaluate cycles. Do not decompose a loop into multiple plan steps — the loop mechanism owns the iteration lifecycle.
- Loop steps are auto-advanced by the loop mechanism. Do NOT call advance_plan_step() for loop steps.
