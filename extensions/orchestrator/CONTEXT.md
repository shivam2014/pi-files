# Domain Glossary

## AskResolver

Module that decides whether a delegation should use the ask_orchestrator flow. It evaluates the user request, the available scope, and the need for clarification before committing to a subagent run. It does not perform the delegation itself; it only resolves whether to ask first.

_Avoid:_ ask decider, question router, clarification manager

## DelegateController

Controller that manages the per-delegation lifecycle within an already-active plan. It handles start, finalize, and error-step transitions for a single delegation, but it does not own plan-panel setup, ask-resolution, scope formatting, or subagent execution policy. Those responsibilities live in their respective modules; DelegateController only drives the delegation phase hooks that run inside an existing plan.

_Avoid:_ delegate runner, orchestration layer, tool coordinator, plan panel owner

## DelegateFeedBuilder

Module that constructs the live activity feed during a subagent run. It handles `reportFinding` updates, `ask_orchestrator` prompts, spinner updates, and plan-panel detail lines as they occur, keeping the parent orchestrator and UI informed without waiting for the subagent to return.

_Avoid:_ live renderer, progress tracker, feed renderer

## DelegateOutputFormatter

Module that runs after the subagent returns and only handles final output decoration. It produces the formatted result block, including findings summary, audit section, metrics, and any other post-run presentation, but it does not participate in live feed updates while the subagent is running.

_Avoid:_ output parser, result renderer, response formatter

**FusionConfig**:
Configuration management for the Fusion tool: loads/saves/validates fusion settings (panel model IDs, judge model ID, temperature, reasoning effort) from disk. Fail-closed on malformed config per ADR-0002.
_Avoid_: Fusion settings, fusion options

**FusionOrchestrate**:
Coordinates the fusion pipeline: runs panel models → judges analysis → formats output. Owns the FusionRunContext for a single invocation. Keeps the registration layer (fusion-tool.ts) thin by separating orchestration from tool registration.
_Avoid_: Fusion pipeline, fusion orchestrator

**FusionRunContext**:
Per-execution context bag for a single fusion tool invocation. Holds temperature fallback cache, retry counts, and timing metadata. Eliminates module-level mutable state and guarantees cache safety (no state leaks across delegations).
_Avoid_: FusionContext, run state

**FusionUtils**:
Shared utility helpers for the Fusion subsystem: extractText (extracts text from SDK responses), mapWithConcurrencyLimit (parallel execution with concurrency cap). Implementation module, not a domain concept.
_Avoid_: (none)

## PlanPanel

UI component for the orchestrator-level plan widget. Encapsulates plan state, widget handle, session id, and timers in a class or context-bound object with explicit lifecycle methods. One instance per orchestrator session, not per process; multiple pi instances may run concurrently as orchestrators, so PlanPanel must be scoped to a single orchestrator session and not shared globally.

_Avoid:_ plan widget, plan tracker, session planner, plan container

## Scope

Canonical model for a subagent delegation's allowed filesystem reach and enforcement policy. Includes structural/policy fields: filesToCreate, filesToModify, directories, maxFiles, gateMode, and boundaries, plus a version field and a schema that both writer and reader validate. Its canonical type definition lives with ScopeManager (in `scope-manager.ts` or a sibling `scope-types.ts`), not in a shared `types.ts` file. Excludes presentation formatting and per-specialist default decisions (those live in ScopePolicy).

_Avoid:_ scope gate, delegation limits, file permissions

## ScopeFileContract

Shared schema and version for `.pi/scope.json`. Owned by ScopeManager as the sole writer of the file and consumed by ScopeGuard as the reader. Both sides validate the persisted representation against this contract without ScopeGuard importing orchestrator code; the file path, schema, and version are the contract. A version mismatch is treated as stale/malformed.

_Avoid:_ scope schema, scope type import, orchestrator dependency

## ScopeExpansionRequest

A signal from ScopeGuard to the parent orchestrator when a subagent tries to write outside scope and the scope allows orchestrator-approved expansion. The orchestrator, not the end user, decides whether to expand the scope based on full conversation history.

_Avoid:_ scope override, permission escalation, user approval request

## GateMode

The enforcement policy derived from `changeType` that tells ScopeGuard how strictly to enforce the scope (e.g., strict vs relaxed).

_Avoid:_ enforcement level, scope mode, permission mode

## ScopeManager

The module that owns the Scope concept — its extraction from subagent output, normalization of a ScopeManifest to a ResolvedScope, typed API, scope construction helpers, and `changeType`-to-`gateMode` derivation. It reads and writes `.pi/scope.json` on demand and is the sole writer of that file, and it exposes a clear operation to remove `.pi/scope.json`. After orchestrator approval, it can rewrite `.pi/scope.json` with an expanded allowed set. Scope-related types live with it (in `scope-manager.ts` or a sibling `scope-types.ts`), keeping the seam self-contained and avoiding a shared orchestrator `types.ts` dependency. It does not keep an in-process cache; the orchestrator passes scope explicitly. It does not decide per-specialist defaults; callers choose which policy to apply.

Explicit decision: delegate-tool calls `clear` after every delegation and in `before_agent_start`, so stale scope never survives across turns.

_Avoid:_ scope store, scope registry, scope service, scope cache

## ScopeManifest

Input/authoring view of a Scope produced by extraction or default construction, before normalization for enforcement. May contain raw lists, unresolved patterns, or policy choices that still need expansion and validation. ScopeManager turns a ScopeManifest into a ResolvedScope.

_Avoid:_ raw scope, scope request, scope source

## ResolvedScope

Enforcement view produced by ScopeManager. Boundaries and policy decisions are resolved into a flat allowed set of files, directories, and limits. ScopeGuard may construct an equivalent minimal enforcement view directly from `.pi/scope.json` without importing orchestrator types.

_Avoid:_ resolved permissions, flattened scope, scope snapshot

## ScopeGuard

Thin enforcement adapter that reads `.pi/scope.json` directly (raw JSON) and blocks out-of-scope tool calls. It stays zero-coupled to the orchestrator module: the file path and schema are the shared contract, not a code import. It knows nothing about scope extraction, defaults, or ScopeManager internals. When a write is blocked but expansion is allowed, it emits a ScopeExpansionRequest rather than a final block. Malformed or stale `.pi/scope.json` causes fail-closed behavior: ScopeGuard blocks writes, does not prompt, and does not fall back to open.

_Avoid:_ scope validator, scope enforcer, permission guard

## ScopePolicy

The per-specialist decision about what default scope to apply, such as which specialist receives a doc-friendly default. It decides defaults when the orchestrator does not pass an explicit scope.

_Avoid:_ scope rules, scope defaults, specialist config

## BashInterceptor

Module that replaces user-typed bash commands with equivalent tool calls. It performs only bash-to-tool substitution and is invoked by SubagentToolGuard for bash events.

_Avoid:_ bash adapter, command redirector, shell interceptor

## SubagentEvent

An event emitted by subagent-runner during a subagent session (message_update, tool_execution_start, tool_execution_update, tool_execution_end, message_end, lint, etc.).

_Avoid:_ subagent message, runner event, stream message

## SubagentEventRouter

Module that receives SubagentEvents and dispatches them to registered handlers in UI modules (activity-feed, plan-panel, peek-overlay, timeline). UI modules register themselves via an `on(eventType, handler)` API; the router does not import UI modules.

_Avoid:_ event bus, event dispatcher, message router, event broker

## SubagentToolGuard

Module that decides which tools are allowed in subagent and orchestrator contexts. It enforces planSteps-first ordering, checks fusion enablement, and applies the delegate/plan/fusion allow-list before a subagent run. Bash events are routed through BashInterceptor for bash-to-tool replacement.

_Avoid:_ tool enforcer, permission guard, tool policy engine

## PromptBuilder

Module that builds the orchestrator system prompt.

_Avoid:_ prompt factory, system prompt generator, prompt assembler

## RegistrationHub

Module that wires tools, commands, and event handlers into the extension API.

_Avoid:_ plugin registry, extension registrar, tool registrar

## ReadSkillTool

Tool that reads SKILL.md files from the skills directory by name. It resolves `~/.pi/agent/skills/{name}/SKILL.md`, reads the file synchronously, and returns the content. Path-sandboxed to the skills directory: directory traversal via `../` is blocked. Returns an error for unknown or non-existent skills. Registered in the orchestrator's active tools alongside plan, delegate, and fusion. Only accessible in orchestrator context, not during subagent runs.

_Avoid:_ skill reader, skill file opener, skill fetcher

## SkillRegistration

Process of loading skill files into the subagent's resource loader. After resolving skill names from a specialist's skills array to their SKILL.md file paths, those paths are passed as additionalSkillPaths to DefaultResourceLoader. This enables the SDK to generate the available_skills XML block in the subagent's system prompt and makes skill content accessible via the read tool. It does not modify the skills themselves or change their content; it only makes them visible and accessible to the subagent.

_Avoid:_ skill loading, skill injection, skill mounting

## SkillEnforcement

System prompt section that directs a subagent to read and follow its assigned skills. Generated dynamically from the specialist's skills array, the section lists each skill by path and instructs the subagent to read them before starting work. This is NOT hardcoded per specialist — it is generated from the skills[] array so it stays in sync when skills change. The enforcement is textual (a prompt instruction), not a tool-level gate; the subagent can choose to ignore the instruction, though it violates the delegation contract.

_Avoid:_ skill mandate, forced skill reading, skill compliance

## SkillMerge

Behavior of getSpecialistSkills() when an override skills array is provided. By default, the override is merged with the specialist's default skills, deduplicated, preserving the union of both sets. A disableDefaults flag switches to replacement mode where the override replaces defaults entirely. This ensures that passing skills: ["review"] to a coder adds review alongside implement and tdd rather than silently dropping them. Empty or undefined override returns defaults unchanged.

_Avoid:_ skill override, skill replacement, skill append

## SubagentDiagnostic

Structured record produced when captureDiagnostic() detects a silent subagent failure or crash. A silent failure is defined as 0 tool calls across 1+ turns with output under 50 characters. A crash is defined as 0 tool calls with no output at all. Q&A tasks (short descriptions without file references) are suppressed to avoid false positives. The diagnostic includes a metrics snapshot (tool call counts, turns, elapsed time), a redacted output preview (capped at 200 chars), and a crashed boolean. Written to disk at diagnostics/YYYY-MM-DD/{sessionId}/incident-{timestamp}-{specialist}-{shortHash}.json with schema version 1.

_Avoid:_ failure record, incident report, crash log

## PlanLifecycle

Lifecycle rules for the orchestrator's plan panel. After all declared steps complete, the plan remains active (hasActivePlan returns true) so the orchestrator can continue delegating without re-declaring the plan. Steps can be added dynamically via the plan_add_steps tool, which accepts an array of step labels and appends them to the current plan, skipping duplicates. The plan is only fully cleared on explicit agent_end or session start, not on step completion. This prevents the common pattern where the orchestrator must re-plan after every delegation batch.

_Avoid:_ plan panel lifecycle, plan auto-clear, step management

## IntrospectionTools

Tools that let the orchestrator query its own capabilities at runtime. list_skills scans ~/.pi/agent/skills/, reads SKILL.md frontmatter, and returns a formatted list of all installed skills with descriptions. list_tools calls pi.getActiveTools() and returns the orchestrator's currently active tool set. These complement the passive available_skills XML block by providing dynamic query ability — the orchestrator can discover what's available without relying on its system prompt.

_Avoid:_ skill discovery, tool discovery, capability query
