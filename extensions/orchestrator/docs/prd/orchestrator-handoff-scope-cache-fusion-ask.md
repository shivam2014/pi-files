## Problem Statement

The orchestrator extension is the delegation hub of the coding agent, but several hand-off and safety gaps make multi-step work unreliable:

1. **Scope is lost between scout and coder.** Scouts emit a `## Scope` block, but the orchestrator does not parse it. The coder delegate must be given scope manually, which is error-prone and often omitted, causing the delegation to be rejected or the coder to work without guardrails.
2. **Writer scope defaults are wrong for documentation work.** The writer specialist needs file-level scope like the coder, but its natural defaults should be doc-friendly (`*.md`, `docs/`, markdown in the current directory) rather than code defaults.
3. **Subagents still use `bash` for operations that have internal tools.** Commands such as `cat`, `grep`, `find`, `sed`, and `ls` are executed through `bash`, bypassing activity-feed tracking, output caps, and scope guards.
4. **Subagent session cache is unsafe.** Output is truncated at 30k without caller awareness, `token-saver.ts` mutates tool content, the subagent session environment leaks into child processes, and fusion tool/schema registration is unstable across sessions.
5. **`summarizeGoal()` is exported but dead.** The helper exists in `plan-tool.ts` but is never wired into the plan flow.
6. **Fusion cannot be disabled globally.** There is no global on/off switch; the tool is always registered and its instructions are always injected.
7. **Subagents cannot ask the orchestrator for clarification.** There is no `ask_orchestrator` tool; subagents either guess or flood the user channel, breaking the delegation model.

## Solution

Build a tighter, safer hand-off pipeline inside the orchestrator extension:

- Extract and normalize `## Scope` blocks from scout/researcher output and feed them into the next `delegate(coder)` or `delegate(writer)` call.
- Provide doc-aware default scope for the writer specialist.
- Add a `tool_call` interceptor that detects `bash` commands with internal-tool equivalents and warns/soft-blocks with the suggested internal tool, while allowing an explicit override.
- Harden subagent output handling, token-saver behavior, session env isolation, and fusion registration.
- Wire `summarizeGoal()` into the plan tool so plans get a one-line goal derived from the declared steps when the caller does not provide one.
- Add a global fusion toggle: when off, the fusion tool is not registered and its system-prompt instructions are omitted.
- Introduce an `ask_orchestrator` tool that pauses a subagent, surfaces the question to the orchestrator (or answers from context/codebase), and resumes the same session. The activity feed renders these as `Clarified:` entries.

## User Stories

1. As an orchestrator agent, I want scope extracted automatically from scout output so that I can delegate to a coder without manual copy-paste.
2. As a scout specialist, I want my `## Scope` block to be understood by the orchestrator so that my findings directly enable the next delegation.
3. As an orchestrator agent, I want the writer specialist to receive doc-friendly default scope so that documentation tasks do not fail for lack of code-style scope.
4. As a writer specialist, I want to know which markdown files and directories I may edit so that I can make targeted doc changes safely.
5. As an orchestrator agent, I want to detect when a subagent runs `bash cat`/`grep`/`find`/`sed`/`ls` and redirect them to internal tools so that activity tracking and safety policies remain intact.
6. As a subagent, I want to be warned with the correct internal tool name so that I can retry without losing context.
7. As a user, I want subagents to be blocked from using bash as a backdoor for file operations unless they explicitly override, so that scope and audit rules are respected.
8. As an orchestrator agent, I want the 30k output cap to be safe (truncate with a marker, preserve final sections) so that I do not silently lose critical findings.
9. As an orchestrator agent, I want token-saver to never mutate tool content so that subagent tool results remain faithful.
10. As a subagent session, I want orchestrator env vars to be isolated from child processes so that parent state does not leak into spawned commands.
11. As an orchestrator agent, I want fusion tool/schema registration to be deterministic across sessions so that toggling it does not corrupt the tool registry.
12. As an orchestrator agent, I want `summarizeGoal()` to run when no goal is supplied so that the plan panel always shows a meaningful one-liner.
13. As a user, I want a global setting to disable fusion so that I can avoid the latency/cost when I do not need multi-model panels.
14. As an orchestrator agent, I want fusion instructions removed from the system prompt when fusion is off so that the model is not tempted to call a missing tool.
15. As a subagent, I want to ask the orchestrator a question mid-task so that I do not have to guess or abandon the session.
16. As an orchestrator agent, I want to answer subagent questions from context or the codebase so that simple blockers are resolved without disturbing the user.
17. As an orchestrator agent, I want questions that require user input to be escalated back to me so that I can decide how to handle them without disturbing the user.
18. As a user, I want clarification rounds to appear as `Clarified:` entries in the activity feed so that I can see when and why the subagent paused.
19. As a tester, I want each of these behaviors exercised through existing module seams so that the PRD can be verified without large UI harnesses.
20. As a maintainer, I want the canonical working copy (`/Users/shivam94/.pi/agent/extensions/orchestrator`) to remain the source of truth and the `~/pi-files/extensions/orchestrator` backup to be unaffected by active development.

## Implementation Decisions

- **Scope extraction module.** Create a parser (e.g., `extractScopeFromOutput(output: string): Scope | null`) that looks for a `## Scope` block and maps its bullet keys to the `Scope` type already used by `delegate-tool.ts`. If the block is malformed, return `null` and fall back to orchestrator-declared scope. This parser lives next to the delegate tool so both scout findings and manual scope can flow through the same `_cachedScope` path.
  - Expected scope block shape:
    ```yaml
    ## Scope
    - filesToModify: ["src/auth.ts"]
    - filesToCreate: []
    - changeType: "multi-file"
    - maxLinesPerFile: 400
    ```
  - The `Scope` type already includes `directories`, `maxFiles`, `requiresApprovalBeyondScope`, `gateMode`, `changeType`, and `maxLinesPerFile`; extracted values are merged with defaults (`directories: []`, `maxFiles: 10`, `requiresApprovalBeyondScope: true`).
- **Scope hand-off in delegate execution.** When `delegate("scout", ...)` or `delegate("researcher", ...)` returns, parse its output for `## Scope` and, if present, store it as `_cachedScope`. On the next `delegate("coder", ...)` (or `delegate("writer", ...)`) the cached scope is used as a fallback when the orchestrator did not explicitly pass a `scope` parameter. Explicit orchestrator scope always wins.
- **Writer default scope.** Add a `getDefaultWriterScope(cwd: string): Scope` helper that returns a scope whose files are derived from the current working directory: `filesToModify: []`, `filesToCreate: []`, `directories: [cwd]`, `maxFiles: 20`, `changeType: "multi-file"`, `requiresApprovalBeyondScope: true`, plus a free-text boundary that the writer may create/modify `*.md` files and files under `docs/`. This default is applied only when the writer is delegated without an explicit scope and no cached scope exists.
- **Bash → internal-tool interceptor.** In the orchestrator's `tool_call` handler (or a shared interceptor registered by the extension), inspect `bash` calls whose command string starts with a known internal-tool equivalent. The current `tool_call` handler already blocks non-delegate tools in orchestrator mode; extend the safety net with detection logic for subagents.
  - Detected prefixes/mappings (initial set):
    - `cat ` → `read`
    - `grep ` / `rg ` → `grep`
    - `find ` → `find`
    - `sed ` / `awk ` / `perl ` / `python ` file writes → `edit`
    - `ls ` → `ls`
    - `mkdir ` / `touch ` → `write` (when creating files)
  - Behavior: return `{ block: true, reason: "Use <tool> instead of bash+<command>. Set override:true to force bash." }` unless the call includes an explicit `override: true` flag.
  - The override flag is accepted as a parameter on `bash` (or the interceptor inspects a hint in the tool call) so users can still run tests, compilation, GitHub CLI, and other legitimate bash usage.
- **Cache safety fixes.** Apply four hardening changes in `subagent-runner.ts` and supporting modules:
  1. **Output truncation.** Replace the silent 30k cap with a structured truncate that preserves the last `## Findings`/`## Audit` sections if present, and appends a marker such as `[output truncated at N chars; tail preserved]`.
  2. **Token-saver immutability.** Audit `token-saver.ts` so that `shortenLabel()` and any similar helpers return new strings or shallow copies; never mutate tool content objects passed by reference.
  3. **Session env isolation.** Before spawning the subagent session, snapshot `process.env`, remove the orchestrator-specific vars (`PI_ORCHESTRATOR_SUBAGENT` and any internal `PI_*` tokens), run the session, then restore the snapshot. Child `bash` calls inside the subagent must see the cleaned env, not the parent's leaked variables.
  4. **Fusion registration stability.** Make `registerFusionTool(pi, ctx.cwd)` idempotent: check whether the tool is already registered before adding it, and do not re-register schema if a session is restarted. Store the loaded config in module-local state keyed by `cwd` so schema version does not drift between `before_agent_start` events.
- **`summarizeGoal()` wiring.** In `plan-tool.ts`, when `params.goal` is empty or whitespace, call `summarizeGoal(params.steps)` to derive a one-line goal. If steps are also missing, fall back to `"Untitled plan"`. The function is already exported and can summarize a list of step strings.
- **Global fusion toggle.** Add `enabled?: boolean` to `FusionConfig` (already present with default `true`). Respect it in two places:
  - `registerFusionTool()` returns early when disabled and unregisters any previously-registered fusion tool if the config changed to disabled.
  - The system prompt injected in `index.ts` omits the `### Fusion Tool` section when fusion is disabled for the current `cwd`.
  - When disabled, orchestrator mode active tools are `["plan", "delegate"]` only.
- **`ask_orchestrator` tool.** Register a new subagent tool `ask_orchestrator(question: string, context?: string)`.
  - When called, the subagent session pauses and the question is surfaced to the orchestrator layer via the existing `onUpdate` / activity-feed pipeline as a `Clarified:` entry.
  - The orchestrator first attempts to answer from its own context (recent delegations, files read, plan goal) or the codebase (using `read`/`grep` tools, which orchestrator mode normally blocks—this is an explicit exception for answering clarifications).
  - If the orchestrator cannot answer confidently, it returns a text escalation string that the orchestrator LLM sees in the subagent result and decides how to handle — the user is never prompted directly.
  - The answer is returned to the same subagent session as the tool result; the subagent resumes without losing turn history.
  - Activity feed rendering adds a `Clarified:` substep under the current step so the pause/answer is visible in Layer 2 chat blocks.
- **Tool registry hygiene.** Ensure `registerFusionTool` and `registerPlanTool` do not duplicate registrations if the extension lifecycle calls them multiple times. Use `pi.getAllTools()` membership checks or unregister + re-register consistently.

## Testing Decisions

- **Test philosophy.** Tests should assert external behavior, not internal wiring. Prefer the highest seam that captures the user-visible effect; avoid asserting on private variables unless no other seam exists.
- **Scope extraction seam.** Test `extractScopeFromOutput` through the delegate tool's execution path with mocked scout output. Assert that a subsequent `delegate("coder", ...)` without explicit scope receives the extracted files. Use Vitest unit tests in `delegate-tool.test.ts` or a new `scope-extraction.test.ts`.
- **Writer default scope seam.** Test that delegating to `writer` with no scope and no prior scout uses the doc-friendly defaults. Assertions check the prompt or scope file passed to `runSubagent`.
- **Bash interceptor seam.** Test the interceptor at the `pi.on("tool_call", ...)` level using a mock `ExtensionAPI` and mock `bash` calls. Assert block reasons and override behavior for `cat`, `grep`, `find`, `sed`, `ls`, and legitimate commands like `npm test`.
- **Cache safety seams.**
  - Output truncation: pass a 40k-character mock subagent output through `runSubagent` post-processing and assert the marker and preserved tail sections.
  - Token-saver: assert `shortenLabel` does not mutate its input string/tool content.
  - Env leak: assert child process env in a spawned bash call does not contain `PI_ORCHESTRATOR_SUBAGENT`.
  - Fusion stability: register fusion twice with the same `pi` object and assert one tool; toggle off and assert zero fusion tools.
- **`summarizeGoal` seam.** Test the `plan` tool execution: when called with empty goal and non-empty steps, the returned details contain the summarized goal.
- **Fusion toggle seam.** Test `registerFusionTool` with `enabled: false` config; assert the tool is absent from `pi.getAllTools()` and the injected system prompt has no Fusion section.
- **`ask_orchestrator` seam.** This is the broadest change; test it end-to-end through `runSubagent` with a fake subagent that calls `ask_orchestrator`. Assert that the orchestrator receives the question, returns an answer, and the activity feed contains a `Clarified:` substep.
- **Prior art.** The repo already uses Vitest (`node node_modules/vitest/vitest.mjs run`) and has modularized tool registration (`plan-tool.ts`, `delegate-tool.ts`, `fusion-tool.ts`). Follow the existing test patterns and mock `ExtensionAPI` where needed.

## Out of Scope

- Re-implementing the core `ExtensionAPI` or `createAgentSession` internals outside this extension.
- Changing the non-orchestrator agent experience (these changes affect orchestrator mode and its subagents only).
- Building a graphical settings panel for the fusion toggle; configuration remains JSON-based (`~/.pi/fusion.json` or `<cwd>/.pi/fusion.json`).
- Auto-fixing subagent bash usage beyond warning/blocking; the interceptor suggests the internal tool but does not rewrite the call.
- Generalizing `ask_orchestrator` to allow subagents to call arbitrary orchestrator tools; it is a clarification-only channel.
- Modifying the `~/pi-files/extensions/orchestrator` git backup; work happens in the canonical working copy at `/Users/shivam94/.pi/agent/extensions/orchestrator`.

## Further Notes

- The canonical working copy for this work is `/Users/shivam94/.pi/agent/extensions/orchestrator`. `~/pi-files/extensions/orchestrator` is a git backup and should not be edited directly.
- The issue tracker for this repo is GitHub; use `gh issue create` and apply the `ready-for-agent` label.
- The existing `Scope` type, `FusionConfig` type, `subagent-runner.ts`, `delegate-tool.ts`, `plan-tool.ts`, `fusion-tool.ts`, and `index.ts` are the primary surfaces affected.
- The `ask_orchestrator` feature intentionally keeps the subagent session alive. Avoid spawning a new session; serialize the pause/resume through the existing `createAgentSession` tool-result mechanism.
