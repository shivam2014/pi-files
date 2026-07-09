# Comprehensive Documentation Summary

## 1. Project Vision and Ubiquitous Language

### Vision (docs/VISION.md)
The orchestrator extension provides a **three-layer visibility system** for total transparency without clutter:
1. **Layer 0 - Enforcement**: Lint-guard (auto-lint after edits), scope-guard (path-restricted writes), token-saver (output compression)
2. **Layer 1 - Plan Panel**: TUI widget showing goal + step list (9-line budget, 80ms/1000ms refresh)
3. **Layer 2 - Subagent Activity**: Chat blocks showing tool calls, output, spinners with full history
4. **Layer 3 - Peek Overlay**: Ctrl+Q overlay showing live subagent conversation

**Core Principles:**
- **Cache Safety**: Never cache agent outputs across delegations; subagents are stateless by design
- **Token Efficiency**: 9-line budget for plan panel, short step labels (~60 chars max)
- **Total Transparency**: User should never wonder "what is it doing right now?"
- **Self-Correction**: Block messages teach LLMs to recover in single turns

**Implementation Status:**
- All core features working (P0): plan panel, subagent steps, substep collapse, smart goal summarization, scope enforcement
- Most P1 features working: ask_orchestrator, conversation viewer peek, fusion tool, bash interceptor, lint guard
- Some P1 features partial: token-efficient rendering (overflow edge cases)
- P2 features: subagent event router, registration hub

### Ubiquitous Language (docs/UBIQUITOUS_LANGUAGE.md & CONTEXT.md)
**Planning Terms:**
- **Plan**: Declared sequence of work with one Goal and ordered Steps
- **Goal**: One-line summary of plan intent (displayed as `◆ Goal`)
- **Step**: Single unit of work with states: pending → active → completed/errored
- **Substep**: Individual tool call or action within a Step (identified by `toolCallId`)
- **Budget**: Hard cap (9 lines) on plan panel widget height

**Delegation Terms:**
- **Subagent**: Spawned specialist agent with restricted tools
- **Specialist**: Named role (Scout, Coder, Reviewer, Researcher, Writer, Judge)
- **Scope**: File/directory constraints enforced by ScopeGuard (from `.pi/scope.json`)
- **Delegation**: Act of handing task to specialist with lifecycle: start → substeps → finalize/error
- **Ask-orchestrator**: Subagent→orchestrator signal requesting human input

**Visibility System Terms:**
- **Plan Panel** (Layer 1): Widget showing plan goal + step list
- **Activity Feed** (Layer 2): Chat blocks with tool calls, output, spinners
- **Conversation Viewer / Peek** (Layer 3): Ctrl+Q overlay for subagent conversation
- **Widget**: TUI render target (`ctx.ui.setWidget(key, content[])`)

**State Terms:**
- **PlanState**: Internal plan state: `{ goal, steps, startTime, sessionId }`
- **ActivityFeedState**: Subagent feed state machine with goal, steps, currentStep, etc.
- **Session**: Plan-to-completion lifecycle scoped by `sessionId`
- **Timeline**: Debug ring buffer (500 frames) for state snapshots

**Guard Mechanisms:**
- **ScopeGuard**: Path-restricted write enforcer reading `.pi/scope.json` directly
- **Lint Guard**: Deterministic post-edit linter (14 linters, 7 languages)
- **Token Saver**: Token reduction with output truncation and goal summarization

**Domain Modules:**
- **ScopeManager**: Owns Scope concept, writes/reads/clears `.pi/scope.json`
- **DelegateController**: Drives start/finalize/error hooks for one delegation
- **DelegateFeedBuilder**: Builds live activity feed during subagent runs
- **DelegateOutputFormatter**: Post-processes subagent results into formatted blocks
- **BashInterceptor**: Converts bash commands to equivalent tool calls
- **SubagentToolGuard**: Allows/denies tools per specialist, enforces planSteps-first ordering
- **PromptBuilder**: Builds orchestrator system prompt
- **RegistrationHub**: Wires tools, commands, handlers into extension API

### Cache Safety (docs/CACHE-WORKFLOW.md)
DeepSeek's prefix caching was being broken between turns 1 and 2 due to `setActiveTools` in `before_agent_start`. Fix: Move `setActiveTools` to `session_start` so tool schemas remain identical across turns. The cache break occurred because:
1. Turn 1 system prompt had ALL tools (15+), Turn 2 had narrowed list (3 tools)
2. Token 812 diverged: "edit" vs "fusion" in `Available tools:` section
3. Entire prefix cache invalidated

## 2. All ADRs with Key Decisions

### ADR 0001: Scope Enforcement JSON Seam (Accepted)
- **Decision**: ScopeManager writes to `.pi/scope.json`, ScopeGuard reads raw JSON directly
- **Contract**: File path, JSON schema, version field
- **Benefits**: Zero coupling between guard and orchestrator; independent testing/replacement
- **Cost**: Duplicated schema knowledge (both writer/reader must agree)
- **File**: /docs/adr/0001-scope-enforcement-json-seam.md

### ADR 0002: Scope File Fail-Closed (Accepted)
- **Decision**: Malformed, stale, or unknown-version scope files block ALL writes
- **No Fallback**: No user prompting, no intent inference, no open state
- **Recovery**: Must regenerate/repair through normal orchestrator flow
- **Trade-off**: Legitimate edits may be blocked until regeneration, but prevents accidental out-of-scope writes
- **File**: /docs/adr/0002-scope-file-fail-closed.md

### ADR 0003: Activity Feed Researcher Display (Accepted)
- **Problem**: Researcher tool calls displayed poorly ("..." instead of query)
- **Solution**: web_search shows first query + result count; fetch_content shows URL with protocol stripped
- **Multi-line tool_detail**: `setToolDetail()` accepts `\n`-separated strings
- **Plural fallback**: Check `params.queries` then fall back to `params.query`
- **File**: /docs/adr/0003-activity-feed-researcher-display.md

### ADR 0004: Fusion Tool Split (Accepted)
- **Problem**: fusion-tool.ts grew to 863 lines across 6 concerns
- **Solution**: Extract 7 focused modules along natural seams
- **Pattern**: Keep original file as thin registration-and-re-export hub
- **Benefit**: Backward compatibility preserved while enabling independent testing
- **File**: /docs/adr/0004-fusion-tool-split.md

### ADR 0005: Delegate Controller Split (Accepted)
- **Problem**: delegate-controller.ts mixed 5 concerns (scope normalization, scope application, diagnostics, result formatting, orchestration glue)
- **Solution**: Split into 5 modules:
  - `resolve-delegation-scope.ts`: Pure scope normalization per specialist
  - `apply-scope.ts`: AskResolver gate + ScopeManager write
  - `handle-diagnostics.ts`: captureDiagnostic + persist
  - `delegate-result-processor.ts`: Format output with metadata
  - `delegate-controller.ts`: Thin orchestrator (UI, plan steps, cleanup)
- **Preserved**: executeDelegate() remains sole export, all error messages unchanged
- **File**: /docs/adr/0005-delegate-controller-split.md

### ADR 0006: Scope Glob Patterns (Draft)
- **Problem**: Exact path enumeration forces orchestrator to predict every file
- **Solution**: Add glob pattern support to existing filesToModify/filesToCreate fields
- **Enforcement Order**: Exact path → Glob pattern → Directory prefix → Block
- **Library**: Picomatch v4.0.4
- **SpecificityGate**: Rejects overly broad patterns (bare `*`, `**`)
- **Benefits**: Reduces friction, no schema break, deterministic enforcement
- **Cost**: Glob-like filenames may match more paths (low risk)
- **File**: /docs/adr/0006-scope-glob-patterns.md

## 3. PRD Summaries

### PRD: Orchestrator Extension Refactor (docs/prd/PRD.md)
**Problem**: Monolithic coupling persists after extraction
**Solution**: Introduce deep modules, each owning one seam

**12 Issues Tracked:**
1. Create ScopeManager module and move scope types
2. Create ScopeGuard zero-coupled enforcement adapter
3. Refactor delegate-tool to use ScopeManager and remove scope cache
4. Extract DelegateOutputFormatter
5. Extract AskResolver
6. Extract DelegateFeedBuilder from subagent-runner
7. Extract DelegateController and thin delegate-tool
8. Extract BashInterceptor and SubagentToolGuard from index.ts
9. Extract PromptBuilder and RegistrationHub from index.ts
10. Introduce SubagentEventRouter and migrate UI modules
11. Convert plan-panel.ts to per-session PlanPanel class
12. Final integration cleanup and full test run

### PRD: Orchestrator Handoff, Scope, Cache, Fusion, Ask (docs/prd/orchestrator-handoff-scope-cache-fusion-ask.md)
**7 Problems Addressed:**
1. Scope lost between scout and coder
2. Writer scope defaults wrong for documentation
3. Subagents use bash for internal-tool operations
4. Subagent session cache unsafe (30k output cap, env leaks)
5. `summarizeGoal()` exported but dead
6. Fusion cannot be disabled globally
7. Subagents cannot ask orchestrator for clarification

**Key Solutions:**
- Extract/normalize `## Scope` blocks from scout output
- Doc-aware default scope for writer specialist
- Bash→internal-tool interceptor (cat→read, grep→grep, etc.)
- Cache safety fixes (output truncation, token-saver immutability, env isolation)
- Global fusion toggle (config + `/fusion` command)
- `ask_orchestrator` tool for subagent clarification

### PRD: Skill-Aware Delegation (docs/prd/prd-skill-aware-delegation.md)
**7 Problems:**
1. Orchestrator cannot read skills
2. Subagents don't get skills registered
3. Specialist prompts don't enforce skills
4. `skills` override replaces defaults
5. Missing domain vocabulary for skills
6. Plan lifecycle brittle (no mid-plan step addition)
7. No active introspection tools

**21 User Stories covering:**
- Orchestrator reading ask-matt skill for routing
- Skills listed in system prompt via `<available_skills>` XML
- Subagent resource loader registration
- Dynamic skill/tool discovery at runtime
- Plan lifecycle improvements

## 4. Spec Summaries

### UI Spec (docs/specs/SPEC-UI.md)
**Three-Layer Hierarchy:**
- **Layer 1 (Plan Panel)**: Widget above editor, 9-line budget
- **Layer 2 (Step Progress)**: Inline in chat history, full rendering
- **Layer 3 (Peek Overlay)**: Ctrl+Q, 50% width, 80% max height

**Status Icons:**
- Completed: `✓` (checkmark)
- Active: `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (spinner, 80ms cycle)
- Pending: `○` (unfilled circle)

**Rendering Format:**
- Goal line: `◆ <goal>`
- Progress dots: `●○○ N/M` (active dot blinks at 1s interval)
- Steps: 2-space indent with `Step N: <label>` format
- Substeps: 4-space indent with logical actions
- Tool detail: 8-space indent (ephemeral, appears during tool execution)

**Key Rules:**
- Collapse not erase (completed elements remain visible)
- Two-tier rule: Layer 2 preserves all, Layer 1 trims oldest on budget
- Duration shown only for completed steps (`(45s)`, `(2m 13s)`)
- Substep parsing from subagent output (`## Goal`, `## Steps`, `- bullet` items)

### Fusion Spec (docs/specs/FUSION-SPEC.md)
**Multi-Model Deliberation Pattern:**
- Panel of advisor models → Judge synthesizes → Structured analysis
- Inspiration from OpenRouter's Fusion architecture and Mixture-of-Agents research

**Architecture:**
- Tool registered as `fusion` with params: `context`, `draft_plan` (optional), `task`
- Panel runs with concurrency limit of 2 via `mapWithConcurrencyLimit()`
- Judge receives all panel responses + original context
- Adaptive temperature fallback for incompatible models
- Judge JSON extraction with retry loop (up to 3 attempts)

**Toggle Mechanisms:**
1. Config-level: `.pi/fusion.json` with `enabled` field
2. Session-level: `/fusion on|off` commands
3. TUI: `/fusion` opens interactive model picker

**Model Selection Guide:**
- Panel: Different from each other and orchestrator
- Judge: Strongest available model, different provider than most panelists
- Default: deepseek-v4-flash-2 + kimi-k2.6-2 panel, kimi-k2.6-2 judge (~$0.008/call)

### Lint Spec (docs/specs/LINT-SPEC.md)
**Project-Agnostic Lint Guard:**
- Auto-detects language from file extension
- 14 linters across 7 languages (TypeScript, JavaScript, Python, Go, Rust, Java, Ruby)
- Walk-up config detection (tsconfig.json, pyproject.toml, go.mod, etc.)
- Standalone fallbacks when no config found

**Emission:**
- Visible `lint` tool call result via `pi.sendMessage()`
- Cache-safe: Never modifies original tool_result content
- LLM self-correction flow: lint failure → assistant fixes → lint passes

**Performance:**
- <5 seconds for single-file edits
- Timeout at 10 seconds with warning

### Bash Token Saver Spec (docs/specs/BASH-TOKEN-SAVER-SPEC.md)
**Three-Layer Architecture:**
1. **Tool Availability**: Per-specialist tool selection in specialists.ts
2. **Per-Specialist Tool Selection**: Scout gets git-read/gh tools, no bash; Coder gets full bash
3. **Output Compression**: RTK rewrite + line budgets (RTK 60-90% + line budgets ~80% = ~90-98% reduction)

**Per-Specialist Bash Access:**
- Scout: No bash (git-read + gh custom tools)
- Coder: Full bash with RTK rewrite via spawnHook
- Reviewer: Bash but prompt says read-only
- Researcher: No bash (web tools only)
- Writer: No bash (read/write/edit tools)

## 5. Test Plan (TEST-PLAN.md)

**11 Tests via interactive_shell:**
1. Extension loads without error
2. Delegate tool available (only `delegate()` listed)
3. Basic scout delegation
4. Basic coder delegation
5. Full scout → coder flow
6. Scope enforcement (scope-guard blocks out-of-scope writes)
7. Caveman mode active (terse responses)
8. Adaptive gating — coder blocked without scout
9. Adaptive gating — self-correction flow
10. Adaptive gating — single-file relaxed mode
11. Adaptive gating — multi-file strict mode

**Key Verification Points:**
- No crash on startup
- Only `delegate` tool available to orchestrator
- Scout returns file listing, plan panel updates
- Coder creates files within scope
- Scope-guard blocks unauthorized writes
- Response style matches caveman mode
- Coder blocked when no prior scout scope exists
- LLM self-corrects after adaptive gate block
- Single-file changes skip maxLinesPerFile enforcement
- Multi-file changes enforce maxLinesPerFile

## 6. Agent-Related Docs

### Domain Docs (docs/agents/domain.md)
**Instructions for engineering skills:**
- Read `CONTEXT.md` and ADRs before exploring codebase
- Use glossary vocabulary from CONTEXT.md
- Flag ADR conflicts explicitly
- Proceed silently if files don't exist

### Issue Tracker (docs/agents/issue-tracker.md)
**GitHub Issues:**
- Use `gh` CLI for all operations
- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- Apply labels: `gh issue edit <number> --add-label "..."`
- PRs as triage surface optional (off by default)

### Status (docs/agents/STATUS.md)
**Current State (2026-06-24):**
- All core features implemented and tested
- 21 test files covering all modules (all passing)
- Recent work: Fusion description normalization, prompt slimming, clarification dedup

**Open Issues (GitHub):**
- #52: ask_orchestrator escalation never prompts user directly
- #47: fusion-toggle.test.ts mismatch
- #45: Goal-achieved early stop
- #44: Subagent minimal context
- #43: ask-matt routing table
- #42: Specialist default skills + delegate override
- #41: SDK skill discovery for subagents
- #37: Deduplicate clarification instructions
- #36: Slim orchestrator prompt appendix
- #35: Normalize tool schemas
- #31: PRD: Orchestrator extension prompt streamlining

### Triage Labels (docs/agents/triage-labels.md)
**5 Canonical Roles:**
- `needs-triage`: Maintainer needs to evaluate
- `needs-info`: Waiting on reporter for information
- `ready-for-agent`: Fully specified, ready for AFK agent
- `ready-for-human`: Requires human implementation
- `wontfix`: Will not be actioned

## 7. Operational Docs

### Orchestrator Refactor Audit (Audit/ORCHESTRATOR-REFACTOR-AUDIT.md)
**8 Areas with 50+ Issues:**

1. **Fusion** (10 issues): Panel model empty responses, judge JSON parsing, concurrency, streaming progress
2. **Plan Panel** (10 issues): Session step persistence, pending substeps visibility, error rendering, budget trimming
3. **Activity Feed** (8 issues): Pending substep visibility, substep merging, error rendering, helper duplication
4. **Subagent Runner** (12 issues): Module-level globals, env leakage, output cap, planSteps guard
5. **Lint Guard** (4 issues): Synthetic messages, monorepo path resolution, timeout
6. **Token Saver** (5 issues): Caveman validation, read dedup normalization
7. **Harness/Workflow** (7 issues): Command noise, duplicate delegate render, scope guard termination
8. **Architecture/SDK** (11 issues): Tool schema slot-filling, guard rails, specialist prompts, retry reasons

**Execution Order:**
1. State hygiene (RUN-001, RUN-002, ARCH-005, ARCH-006)
2. Schema stability (ARCH-001, ARCH-002, HAR-006, ARCH-011)
3. Output & truncation (RUN-004, ARCH-007, FEED-002, FEED-008)
4. Scope & guard rails (ARCH-002, RUN-012)
5. Plan panel accuracy (PAN-003, PAN-002, PAN-005, PAN-006, PAN-001)
6. Activity feed correctness (FEED-003, FEED-001, FEED-004, FEED-005)
7. Fusion robustness (FUS-002, FUS-005, FUS-007, FUS-004)
8. Lint/token/commands polish (LINT-002, TOK-001, TOK-002, CMD-002, CMD-003)
9. Prompt architecture (ARCH-003, ARCH-010, TOK-003 docs)
10. Type safety & versioning (ARCH-008, ARCH-009)

### Peek Overlay Flickering Postmortem (docs/peek-overlay-flickering-postmortem.md)
**Root Cause:** Two independent render triggers compounding:
1. Text deltas from model (100-300ms) → immediate re-render
2. Spinner timer (250ms) → unnecessary re-render for static `●`

**Fixes Applied:**
1. H2: Removed spinner timer re-render calls (overlay uses static `●`)
2. H1: Added 200ms debounce to `pushStreamingText()` (max ~5fps)

**Verification:** 4 regression tests added (deterministic render, spinner timer, pushStreamingText safety, MIN_HEIGHT stability)

## Key File Paths

### Root Level
- `/CONTEXT.md` - Domain glossary and module definitions
- `/TEST-PLAN.md` - Orchestrator test plan
- `/AGENTS.md` - Developer reference and project layout

### Documentation
- `/docs/VISION.md` - Three-layer visibility system vision
- `/docs/UBIQUITOUS_LANGUAGE.md` - Canonical terms and relationships
- `/docs/CACHE-WORKFLOW.md` - DeepSeek prefix cache fix workflow
- `/docs/peek-overlay-flickering-postmortem.md` - Debugging journey for flickering issue

### ADRs
- `/docs/adr/0001-scope-enforcement-json-seam.md`
- `/docs/adr/0002-scope-file-fail-closed.md`
- `/docs/adr/0003-activity-feed-researcher-display.md`
- `/docs/adr/0004-fusion-tool-split.md`
- `/docs/adr/0005-delegate-controller-split.md`
- `/docs/adr/0006-scope-glob-patterns.md`

### PRDs
- `/docs/prd/PRD.md` - Orchestrator extension refactor
- `/docs/prd/orchestrator-handoff-scope-cache-fusion-ask.md` - Handoff, scope, cache, fusion, ask
- `/docs/prd/prd-skill-aware-delegation.md` - Skill-aware delegation

### Specs
- `/docs/specs/SPEC-UI.md` - UI/UX specification
- `/docs/specs/FUSION-SPEC.md` - Multi-model deliberation
- `/docs/specs/LINT-SPEC.md` - Project-agnostic lint guard
- `/docs/specs/BASH-TOKEN-SAVER-SPEC.md` - Bash + token saver

### Agents
- `/docs/agents/domain.md` - Domain documentation instructions
- `/docs/agents/issue-tracker.md` - GitHub issue conventions
- `/docs/agents/STATUS.md` - Current status and open issues
- `/docs/agents/triage-labels.md` - Triage label mappings

### Audit
- `/Audit/ORCHESTRATOR-REFACTOR-AUDIT.md` - Comprehensive audit with 50+ issues

## Summary Statistics
- **Total Documentation Files**: 20+ files across 6 directories
- **ADRs**: 6 (5 accepted, 1 draft)
- **PRDs**: 3 comprehensive product requirements
- **Specs**: 4 detailed specifications
- **Test Plan**: 11 interactive shell tests
- **Agent Docs**: 4 operational documents
- **Audit Issues**: 50+ tracked issues across 8 areas
- **Key Modules**: 20+ core modules defined in ubiquitous language