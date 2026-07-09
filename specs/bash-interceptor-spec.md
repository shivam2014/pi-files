# Spec: Bash Interceptor Refactoring

## Problem Statement

The orchestrator extension uses a regex-based `bash-interceptor.ts` to classify bash commands as write-modifying. This approach has several issues:
- Regex patterns are fragile (e.g., nested subshell stripping bug)
- Overlapping classification layers (WRITE_COMMANDS Set, hasFileWriteIndicator, redirection regex)
- Post-hoc filtering instead of pre-execution interception
- No type safety for bash tool input
- Contradictory documentation (sed/awk/perl in WRITE_COMMANDS but design says don't intercept them)

## Solution

Refactor bash interception to use the official pi SDK `tool_call` event pattern with `isToolCallEventType` narrowing. This provides:
- Pre-execution interception (before command runs)
- Type-safe input access via `isToolCallEventType("bash", event)`
- Composable handlers (multiple extensions can chain)
- Clean blocking API via `{ block: true, reason }` return
- Mutable `event.input.command` for command modification

## User Stories

1. As a pi user, I want write commands blocked in read-only mode, so that my local work isn't accidentally modified
2. As a pi user, I want read commands allowed in read-only mode, so that I can investigate code safely
3. As a pi user, I want dangerous commands (rm -rf, git push) blocked by default, so that I don't accidentally destroy work
4. As a pi user, I want clear error messages when commands are blocked, so that I understand why and how to proceed
5. As a pi user, I want the interception to happen before command execution, so that no side effects occur
6. As a pi user, I want the classification logic to be simple and readable, so that I can understand and maintain it
7. As a pi user, I want the interception to work with all bash tool variants (bash, bash with timeout), so that it's comprehensive
8. As a pi user, I want the classification to be deterministic, so that the same command always gets the same result
9. As a pi user, I want the interception to be fast, so that it doesn't add latency to tool calls
10. As a pi user, I want the interception to be testable, so that I can verify classification logic
11. As a pi user, I want the interception to be composable with other extensions, so that I can layer protections
12. As a pi user, I want the interception to handle edge cases (quotes, escapes, pipes), so that it's robust
13. As a pi user, I want the interception to log blocked commands, so that I can audit what was prevented
14. As a pi user, I want the interception to be configurable, so that I can customize what's blocked
15. As a pi user, I want the interception to work in both sequential and parallel delegation modes, so that it's consistent
16. As a pi user, I want the interception to respect specialist permissions (reviewer = read-only), so that specialists can't exceed their scope
17. As a pi user, I want the interception to be a single module, so that it's easy to find and understand
18. As a pi user, I want the interception to use the official SDK pattern, so that it's maintainable and follows best practices
19. As a pi user, I want the interception to not use regex where possible, so that it's more readable
20. As a pi user, I want the interception to be documented, so that I know what's blocked and why

## Implementation Decisions

1. **Use `pi.on("tool_call", ...)` event handler** — Official SDK pattern for pre-execution interception.

2. **Use `isToolCallEventType("bash", event)` for type narrowing** — Ensures type-safe access to `event.input.command`.

3. **Replace regex-based classifier with simple command prefix/suffix matching** — Use `startsWith`, `includes`, `endsWith` instead of regex for most cases. Reserve regex only for complex patterns (output redirection).

4. **Single classification function: `isWriteCommand(command: string): boolean`** — One function, one responsibility. Replace the multi-layered approach.

5. **Blocking via `{ block: true, reason: string }` return** — Official SDK blocking API.

6. **Command modification via `event.input.command` mutation** — For preprocessing (e.g., adding source commands).

7. **Configuration via specialist permissions** — Read-only specialists (reviewer) get write commands blocked. Read-write specialists (coder) get dangerous commands blocked.

8. **Logging via `ctx.ui.notify()`** — User-visible notifications for blocked commands.

9. **Testing via unit tests on `isWriteCommand()`** — Test the classification logic in isolation.

10. **Composition via multiple handlers** — Other extensions can add their own `tool_call` handlers for additional protections.

## Testing Decisions

1. **Good tests: External behavior** — Test that commands are blocked/allowed based on input, not implementation details.

2. **Modules to test**:
   - `bash-classifier.ts` — `isWriteCommand()` classification
   - `bash-interceptor-new.ts` — `tool_call` handler blocking behavior
   - `bash-interceptor-integrated.ts` — Integration with specialist permissions

3. **Prior art**: `subagent-tool-guard.test.ts` has tests for bash blocking.

4. **Key test cases**:
   - Read commands allowed in read-only mode (ls, cat, grep)
   - Write commands blocked in read-only mode (rm, mv, git push)
   - Dangerous commands always blocked (rm -rf /, git push --force)
   - Edge cases (quoted commands, pipes, output redirection)
   - Specialist permissions respected (reviewer blocked, coder allowed)

5. **Test mock pattern**:
   ```typescript
   const mockEvent = (command: string, specialist?: string) => ({
     toolName: "bash",
     input: { command },
     toolCallId: "test-123",
     specialist,
   });
   ```

## Out of Scope

1. **AST parsing** — Not implementing full bash parser. Simple string matching sufficient for v1.

2. **Network command blocking** — curl, wget not blocked in v1. Can be added later.

3. **Custom user configuration** — No UI for customizing blocked commands in v1. Hardcoded list.

4. **Audit logging to file** — Only user-visible notifications in v1. File logging deferred.

5. **Parallel interception** — Multiple bash tool calls in parallel mode not specifically handled in v1.

## Further Notes

- The official SDK pattern (`tool_call` event + `isToolCallEventType`) is the canonical way to intercept tool calls in pi extensions.

- No built-in command classification exists in the SDK. All classification is application-level.

- The current regex-based approach has a known bug (nested subshell stripping). The new approach avoids regex where possible.

- The refactoring should be backward-compatible — same commands blocked/allowed, just cleaner implementation.
