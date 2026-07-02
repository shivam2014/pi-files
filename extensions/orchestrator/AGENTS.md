# Orchestrator Extension — Scope Enforcement & Adaptive Gating

> Developer reference. Agent-facing instructions live in the appendix injected by `prompt-builder.ts`.

## Project Layout

- **Canonical working copy**: `~/.pi/agent/extensions/orchestrator` — edits should be made here.
- **Git repo (backup/sync)**: `~/pi-files` → `github.com/shivam2014/pi-files.git`
- **Sync flow**: Make changes locally, then `rsync` to `~/pi-files/extensions/orchestrator` for committing.
- **GitHub Issues**: Filed on the `shivam2014/pi-files` repo.

## Design Philosophy

- **Tool-level gate, not prompt-level.** `scope` param on `delegate()` enforced by `scope-guard.ts`. No prompt reminders.
- **Adaptive by complexity.** single-file→relaxed, multi-file→strict. Scout judges.
- **Self-correction, not crash.** Block message teaches LLM. Single-turn recovery.
- **Test snapshots, not exit codes.** Verify TUI output, not pass/fail.

## Testing

Run `tui-smoke.sh` with targeted prompts to verify adaptive gating:

```bash
bash ~/.pi/tui-smoke.sh pi "create /tmp/test.txt with content hello"   # scope gate blocks coder
bash ~/.pi/tui-smoke.sh pi "investigate the auth system and add logging"  # scout-first flow
```

Check snapshot files (`/tmp/tui-smoke-*/00-startup.txt` through `04-final-state.txt`).

## Anti-Patterns

- Don't weaken scope enforcement to pass tests.
- Don't add prompt-level reminders — they decay. Tool-level gate is the enforcement.
- Don't let the gate crash the agent — self-correct in one turn.
