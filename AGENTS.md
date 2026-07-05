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

---

# pi Agent Config

## Orchestrator Extension

- **Working copy**: `~/.pi/agent/extensions/orchestrator` — edit here, this is live
- **Git repo**: `~/pi-files` → `github.com/shivam2014/pi-files` (canonical copy for version control)
- **Sync flow**: edit locally → `rsync` to `~/pi-files/extensions/orchestrator` → commit & push
- **Issues**: filed on `shivam2014/pi-files` repo

## TUI Smoke Test

- Test file: `~/.pi/tui-smoke.sh`
- Run: `./.pi/tui-smoke.sh` (from home dir)
- Tmux-based automated TUI tests for the orchestrator extension
- Validates: plan panel visibility, activity feed icons (✓⠋○), specialist blocks, no crash logs
- Environment: `PI_BIN`, `TEST_TIMEOUT`, `CAPTURE_DIR`
- Cleanup: auto-removes tmux session, archives captures to `$CAPTURE_DIR`
