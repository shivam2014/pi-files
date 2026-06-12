# Orchestrator Extension — Scope Enforcement & Adaptive Gating

## Design Philosophy

Require scout before coder. Tool-level gate, not prompt-level. Prompts degrade.

Scope means architecture plan, not file restriction. Scout outputs changeType, approach, files.

Adaptive by complexity. single-file→relaxed, multi-file→strict. Scout judges.

Self-correction, not crash. Block message teaches LLM. Single-turn recovery.

Test snapshots, not exit codes. Verify actual TUI output, not pass/fail.

### Legacy vs Refactored

**Legacy** (1663-line monolith in `legacy/orchestrator.ts`):
- Zero scope concept — coder could write anywhere
- No planning enforcement — just keyword-based UX decoration
- Spaghetti code — UI, session management, tool registration all mixed
- Timer leaks from hot reload

**Refactored** (11 files, modular):
- Scope lifecycle: extract → cache → write file → enforce via tool_call interceptor
- Adaptive gating: block coder without prior scout scope
- Timer self-check pattern for hot reload safety
- Clean separation: `scope-guard.ts` has zero coupling to orchestrator module

---

## Key Files

| File | Role |
|---|---|
| `types.ts` | Shared interfaces: Scope, Specialist, OrchestratorStep, ScopeGateMode |
| `delegate-tool.ts` | `delegate()` tool registration + adaptive gating + scope extraction |
| `subagent-runner.ts` | Subagent session lifecycle + scope.json write |
| `specialists.ts` | 5 specialist definitions + ACTIVITY_FEED_INSTRUCTION + TERSE_INSTRUCTION |
| `plan-panel.ts` | Layer 1: Widget-based plan panel (persistent header) |
| `activity-feed.ts` | Layer 2: Subagent tool block rendering in chat |
| `scope-guard.ts` | (sibling) Tool_call interceptor, reads `.pi/scope.json`, blocks out-of-scope writes |
| `commands.ts` | `/orchestrate` and `/specialists` slash commands |

---

## Workflow

```
User request
  → delegate(scout, "investigate ...")         ← ALWAYS ALLOWED
    → scout reads codebase, outputs ## Scope
  → delegate(coder, "implement ...")            ← ALLOWED only if scope exists
    → scope-guard.ts enforces file list + line limits
  → delegate(reviewer, "review ...")            ← ALWAYS ALLOWED (read-only)
```

If coder is called without scout:

```
  → BLOCKED: "Scope required before coding. Call delegate(scout, ...) first."
  → LLM self-corrects: calls scout → gets scope → retries coder → succeeds
```

---

## Testing

- Verify TUI snapshots reveal plan panel, adaptive gate block, LLM self-correction, and scope enforcement. Don't just check exit code.

Run `tui-smoke.sh` with targeted prompts to verify adaptive gating:

```bash
# Test direct coder call gets blocked
bash ~/.pi/tui-smoke.sh pi "create /tmp/test.txt with content hello"

# Test scout-first flow works
bash ~/.pi/tui-smoke.sh pi "investigate the auth system and add logging"

# Check snapshots in /tmp/tui-smoke-*/ for gate block messages
```

Always check snapshot files (`00-startup.txt` through `04-final-state.txt`) — not just test pass/fail — to verify adaptive gating flow occurred.

---

## Anti-Patterns

- **Don't** weaken the gate to pass tests. The gate is the core mechanism.
- **Don't** add prompt-level reminders to "call scout first" — they decay. The tool-level gate is the enforcement.
- **Don't** let the gate crash the agent — it must self-correct in one turn.
- **Don't** test with mock scope files — test with actual `delegate()` calls end-to-end.

---

## Iterative Development — Build & Use Simultaneously

This orchestrator extension in pi is developed and used in parallel. Every session is a test of the workflow.

**Report bugs & difficulties.** When using the orchestrator pattern, note any friction:
- Does the delegation handoff work reliably?
- Are there false positives (blocking valid calls) or false negatives (allowing invalid ones)?
- Do subagent sessions initialize with the right tool sets?
- Any other issues or scope for improvement

**How to report.** After each task, include a "Session Feedback" section covering:
1. What worked
2. What didn't work (blocking issues)
3. What was friction (annoying but workaroundable)
4. Specific reproduction steps if a bug

**Why.** Traditional testing catches known cases. Real usage catches edge cases
**Fix loop.** Bug found → report in session feedback → fix in next session → verify. No bug hit twice.
