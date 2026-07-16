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

### Testing lifecycle events

When testing extension behavior that depends on `setActiveTools`, tests must trigger lifecycle events in the correct order:

1. **Trigger `session_start` before `before_agent_start`** — `setActiveTools` only fires during `session_start`. If skipped, `getActiveToolsHistory()` returns `undefined` and tool-freezing behavior is never exercised.
2. **Mock `createMockPi().trigger()` pattern** — fire both events in order:
   ```ts
   await pi.trigger('session_start', {}, { cwd });
   await pi.trigger('before_agent_start', event, ctx);
   ```
3. **Use `ctx.cwd` in `session_start` handlers** — not `process.cwd()`, so config resolution works in test temp directories.

> Reference: [openwiki/testing/guide.md](openwiki/testing/guide.md) for detailed guidance on test setup, snapshots, and init-phase constraints.

## Anti-Patterns

- Don't weaken scope enforcement to pass tests.
- Don't add prompt-level reminders — they decay. Tool-level gate is the enforcement.
- Don't let the gate crash the agent — self-correct in one turn.

## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:
- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.
