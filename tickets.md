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
