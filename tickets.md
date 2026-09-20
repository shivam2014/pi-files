# Tickets: Bash Interceptor Refactoring

Refactor regex-based bash interception to use pi SDK `tool_call` event pattern.

Source spec: Bash Interceptor Refactoring Spec (conversation context)

## 1. Create `isWriteCommand()` Classifier

**What to build:** A pure function that classifies bash commands as write-modifying or read-only, using simple string matching instead of regex.

**Blocked by:** None — can start immediately.

- [ ] Function accepts command string, returns boolean
- [ ] Classifies common read commands as safe (ls, cat, grep, find, head, tail, wc, echo)
- [ ] Classifies common write commands as dangerous (rm, mv, cp, git push, git commit, tee, >, >>)
- [ ] Handles edge cases (quoted commands, pipes, output redirection)
- [ ] Unit tests pass for all classification cases

## 2. Implement `tool_call` Event Handler

**What to build:** An extension handler that intercepts bash tool calls using the official pi SDK pattern, blocks write commands in read-only mode, and logs blocked attempts.

**Blocked by:** Ticket 1 (isWriteCommand classifier)

- [ ] Uses `pi.on("tool_call", ...)` event handler
- [ ] Uses `isToolCallEventType("bash", event)` for type narrowing
- [ ] Checks specialist permissions (read-only vs read-write)
- [ ] Blocks write commands when specialist is read-only
- [ ] Returns `{ block: true, reason: "..." }` for blocked commands
- [ ] Logs blocked commands via `ctx.ui.notify()`
- [ ] Unit tests pass for blocking behavior

## 3. Integrate with Specialist Permissions

**What to build:** Connect the bash interceptor to the specialist roster, so reviewer is automatically read-only and coder is read-write.

**Blocked by:** Ticket 2 (tool_call handler)

- [ ] Reads specialist permissions from SPECIALISTS registry
- [ ] Reviewer specialist gets write commands blocked
- [ ] Coder specialist allows write commands
- [ ] Scout specialist allows read commands only
- [ ] Integration tests verify specialist-specific blocking

## 4. Remove Old Regex-Based Interceptor

**What to build:** Delete the old `bash-interceptor.ts` module and update all imports to use the new `tool_call` handler.

**Blocked by:** Ticket 3 (specialist integration)

- [ ] Delete `bash-interceptor.ts`
- [ ] Delete `bash-interceptor.test.ts`
- [ ] Update imports in `index.ts` to use new handler
- [ ] Update imports in `subagent-tool-guard.ts`
- [ ] Verify no remaining references to old module
- [ ] All tests pass after removal

## 5. Update Documentation

**What to build:** Update the openwiki docs to reflect the new bash interception pattern and document what commands are blocked.

**Blocked by:** Ticket 4 (old interceptor removed)

- [ ] Update `openwiki/domain/scope.md` with new pattern
- [ ] Document blocked commands list
- [ ] Document how to add new blocked commands
- [ ] Document specialist permissions

---

## Session feedback — 2026-09-20 → filed to GitHub issues

Record of the 2026-09-20 framework/orchestrator session feedback. The repo's issue tracker is **GitHub issues** (`extensions/orchestrator/docs/agents/issue-tracker.md`); this file is a one-off ticket list, `issues/` is a session-log archive, `specs/` holds specs. All 30 items were checked against tracker text; 21 were MISSING and were filed as GitHub issues #116–#136; 8 are PARTIAL (pre-existing refs); 1 is ALREADY-FILED.

| Item | Group | Status | Tracker ref |
|------|-------|--------|-------------|
| B1 | framework: escalation | PARTIAL | #8, #13, #52 (closed) — resolver fallback / own-context delta unfiled |
| B2 | framework: escalation | FILED | #116 |
| B3 | framework: escalation | FILED | #117 |
| B4 | framework: guards | PARTIAL | #4 (closed) — reflog/grep + rm -rf delta unfiled |
| B5 | framework: guards | FILED | #118 |
| B6 | framework: guards | FILED | #119 |
| B7 | orchestrator: budget gate | FILED | #120 |
| B8 | orchestrator: budget gate | FILED | #121 |
| B9 | orchestrator: telemetry | FILED | #122 |
| B10 | token-saver / read path | PARTIAL | #49 (closed) — intra-session stub delta unfiled |
| B11 | repo hygiene | FILED | #123 |
| B12 | repo hygiene | FILED | #124 |
| B13 | repo hygiene | FILED | #125 |
| B14 | orchestrator: telemetry | FILED | #126 |
| B15 | framework: escalation | FILED | #127 |
| B16 | orchestrator: diagnostics | PARTIAL | #80 (closed) — false-positive delta unfiled |
| B17 | framework: escalation | FILED | #128 |
| B18 | repo hygiene | PARTIAL | #88 (open) — widget/feed-builder not named |
| B19 | repo hygiene | FILED | #129 |
| B20 | repo hygiene | FILED | #130 |
| F1 | orchestrator: budget gate | FILED | #131 |
| F2 | orchestrator: telemetry | FILED | #132 |
| F3 | token-saver / read path | PARTIAL | #49 (closed) — later-change detection delta unfiled |
| F4 | framework: guards | PARTIAL | #50 (closed) — reflog + shell operators delta unfiled |
| F5 | orchestrator: budget gate | FILED | #133 |
| F6 | orchestrator: budget gate | FILED | #134 |
| F7 | repo hygiene | FILED | #135 |
| F8 | repo hygiene | FILED | #136 |
| F9 | framework: guards | PARTIAL | #46 (closed) — bare-filename false block delta unfiled |
| F10 | framework: guards | ALREADY-FILED | #4 (closed) — blocked cat/grep/find/sed/awk/ls/mkdir w/ override |

Note: a dedicated ledger under `issues/` (or `docs/`) was scope-blocked, so this record lives here; see `docs/CANON-ONLY.md` for the canon-only file record.
