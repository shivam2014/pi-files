# FUSION-SPEC: Multi-Model Deliberation for Orchestrator Planning

## 1. Overview

Fusion is a **multi-model deliberation** pattern that improves the orchestrator's planning quality by consulting a panel of models before writing the final plan. It draws inspiration from Mixture-of-Agents (MoA) research and OpenRouter's Fusion architecture, adapted for the orchestrator's planning phase within an agentic coding system.

### Why Fusion

The orchestrator runs on a cheap, fast model — currently `deepseek-v4-flash-2`. While flash handles research, delegation, and execution well, planning benefits from diverse perspectives. Different models have different training distributions, different blind spots, and different reasoning styles. Fusion exposes the orchestrator's draft plan to a panel of advisor models, then uses a judge model to synthesize their feedback into a structured analysis.

The key insight from OpenRouter's Fusion research: **~75% of the quality lift comes from synthesis, not model diversity.** A strong judge can extract significant improvements even from a panel of identical models. This means Fusion is cost-effective — we don't need four frontier models, just one capable judge and a few cheap panelists.

### Lifecycle

Fusion is called **once per task**, during the planning phase:

```
Scout/Researcher gather findings
       ↓
Orchestrator drafts preliminary plan
       ↓
Fusion (panel → judge → structured analysis)
       ↓
Orchestrator reads analysis, writes final plan
       ↓
Coder executes plan
```

The orchestrator does the legwork (scouting, researching, delegating, executing). Frontier models advise on the plan. This keeps costs low while reaping the benefits of diverse model perspectives.

### Cost

A single Fusion call costs approximately **~$0.008** with the recommended default configuration (flash panel + Kimi judge). Even with three panelists and a frontier judge, the cost stays under ~$0.015 per call — negligible for a planning step that guides potentially hundreds of tool calls.

---

## 2. Research Summary

### OpenRouter Fusion (source: openrouter.ai/blog/announcements/fusion-beats-frontier)

OpenRouter's Fusion architecture was the primary inspiration. Their architecture uses a **parallel panel → judge → calling model** flow:

- **Quality preset**: Fable 5 + GPT-5.5 panel, Opus 4.8 judge → **69.0% DRACO**
- **Budget preset**: Gemini 3 Flash + Kimi K2.6 + DeepSeek V4 Pro panel → **64.7% at ~half cost**
- **Self-fusion** (same model × 2): **65.5%** vs solo **58.8%** — a **+6.7pt lift from synthesis alone**
- Key insight: ~75% of the quality improvement comes from the judge's synthesis, not from panel diversity
- No cross-model caching currently supported
- Recursion prevention via the `x-openrouter-fusion-depth` header

The self-fusion result is particularly important for our design: **even without diverse models, the judge adds value.** This means Fusion works even in resource-constrained environments where only one or two models are available.

### Real-World Community Sentiment (HN, Reddit, Hands-On Tests)

Extensive community testing across Nyro, OpenRouter, and local deployments reveals the following model characteristics relevant to our panel and judge selection:

| Model | Cost | Strengths | Weaknesses | Verdict |
|-------|------|-----------|------------|---------|
| **DeepSeek V4 Flash** | Very low | Community favorite for cost/reliability. ~"3h/day under $1/week". Often outperforms Pro in agentic harnesses. | Less capable on complex reasoning tasks. | **Best orchestrator model. Good panelist.** |
| **DeepSeek V4 Pro** | Medium | Strong one-shot responses. Good on benchmarks. | Inconsistent in practice. "Significant amount of time it just sucks" (HN). Unreliable in tool loops. | **Avoid for panel.** |
| **Kimi K2.6** | Low | Strongest reasoning on Nyro. "~80% of Claude Opus at 1/7 cost". Best open-weight for coding per multiple hands-on tests. | None significant at this price point. | **Best judge model. Excellent panelist.** |
| **MiniMax M3** | Medium | Best AA Index (55). Newest architecture (June 2026). Promising coding capability. | "Half-migration" problem — knowledge cutoff issues. Weights not released. Raw/immature. | **Good third panelist for diversity.** |
| **GLM 5.1** | Low | 4th place for coding. Endurance — "wins marathon 8-hour agent sessions". | No vision capability. Not exceptional at any single task. | **Niche use case only.** |
| **MiMo V2.5 Pro** | Medium | Token-efficiency king. 40-60% fewer tokens than peers. | Tool-call formatting issues. Less reliable with structured output. | **Avoid for panel — format problems.** |

### Panel vs Judge: The Roles

The distinction between panel and judge is critical to Fusion's design:

**Panel = advisors.** Each panel model receives the same context (findings, draft plan, task prompt) and provides independent feedback. Different training data means different blind spots — a panel model trained heavily on code may miss UX concerns, while one trained on chat may spot them immediately. Panel models should be **different from each other** and **different from the orchestrator** to maximize perspective diversity.

**Judge = synthesizer.** The judge receives all panel responses alongside the original context. Its job is to compare opinions, find contradictions, identify blind spots missed by all panelists, and extract unique insights. The judge must be the **strongest model in the pipeline** — synthesis, contradiction detection, and gap identification are harder than generation. All benchmarks and real-world implementations use the strongest available model as judge.

**Orchestrator should NOT be on the panel.** The orchestrator's perspective is already embedded in how it framed the task, what findings it prioritized, and what plan it drafted. Putting the orchestrator on the panel would add no new perspective — it would just validate its own assumptions.

---

## 3. Architecture Design

### Flow Diagram (Abstract)

```
Orchestrator (deepseek-v4-flash-2)
  │
  ├── delegate(scout, "investigate codebase")
  ├── delegate(researcher, "search patterns")
  │
  └── fusion({
        context: [findings from scout + researcher],
        draft_plan: "My preliminary plan...",
        task: "Critique my plan, find blind spots"
      })
        │
        ├── Panel 1 (kimi-k2.6-2) → "The plan misses error handling..."
        ├── Panel 2 (minimax-m3)  → "Consider breaking X into sub-steps..."
        │
        └── Judge (kimi-k2.6-2) → synth{
              consensus: [...],
              contradictions: [...{topic, stances}],
              blind_spots: [...],
              unique_insights: [...{model, insight}]
            }
        │
        └── Returns structured analysis to orchestrator
      │
      Orchestrator reads analysis, writes final plan
      │
      └── delegate(coder, "implement plan", { scope })
```

### Fusion Tool Registration

The Fusion functionality is registered as a tool on the orchestrator's tool list, following the same pattern as the existing `delegate-tool.ts`:

- **File**: `fusion-tool.ts`
- **Function**: `registerFusionTool(ctx: ExtensionContext)`
- **Tool name**: `"fusion"`
- **Parameters** (TypeBox schema):
  - `context` (string, required) — Findings from scout/researcher, codebase context, etc.
  - `draft_plan` (string, optional) — The orchestrator's preliminary plan for critique
  - `task` (string, required) — What the orchestrator wants the panel to evaluate

**Returns** a structured analysis JSON (blocking — the orchestrator awaits this before writing the final plan).

```typescript
// Pseudocode for fusion-tool.ts structure
function registerFusionTool(ctx: ExtensionContext): void {
  const fusionTool = createReadToolDefinition({
    name: "fusion",
    description: "Run multi-model deliberation (panel + judge) on a plan or question",
    params: Type.Object({
      context: Type.String({ description: "Background findings and context" }),
      draft_plan: Type.Optional(Type.String({ description: "Preliminary plan to critique" })),
      task: Type.String({ description: "What to evaluate or ask the panel" }),
    }),
    callback: async (params) => {
      // 1. Select panel and judge models (from config or defaults)
      // 2. Run panel in parallel via mapWithConcurrencyLimit() with concurrency 2
      // 3. Collect responses
      // 4. Send to judge for synthesis
      // 5. Return structured analysis
    },
  });

  ctx.pi.registerTool(fusionTool);
}
```

### Model Invocation (Internal)

All model calls use the existing `complete()` function from `@earendil-works/pi-ai`, the same function used by the orchestrator for its own reasoning. No custom API clients are needed.

**Panel invocation:**
- `complete()` with the panel model's ID
- **No tools** — panel models are single-turn text generators
- System prompt: `"You are a planning advisor. Review the context and draft plan, then provide constructive criticism. Identify blind spots, suggest alternatives, and flag risks."`
- No conversation history — each panel call is stateless
- Parallelized via `mapWithConcurrencyLimit()` with a concurrency limit of 2. Limiting concurrent requests protects rate-limited models from throttling and token-per-minute penalties while still overlapping network latency.

**Judge invocation:**
- `complete()` with the judge model's ID
- System prompt: A specialized `JUDGE_SYSTEM_PROMPT` that instructs the judge to:
  - Compare all panel responses
  - Identify areas of consensus
  - Flag contradictions (with specific stances from each model)
  - Spot blind spots that ALL panelists missed
  - Extract unique insights (attributed to the originating model)
  - Output a structured JSON analysis
- Judge receives: original context + draft plan + all panel responses concatenated

### Judge JSON Extraction and Validation

The judge returns free-form text, so the Fusion tool extracts and validates the embedded JSON before returning it to the orchestrator.

**Extraction pipeline:**

1. **Strip markdown fences** — Remove leading/trailing ` ```json `, ` ``` `, or language-tag fences so the raw JSON is exposed.
2. **Brace-aware top-level JSON detection** — Scan the text for the outermost balanced `{...}` object, respecting nested braces and strings. This is more reliable than a regex that can be fooled by nested braces or trailing commentary.
3. **Schema validation** — Parse the candidate JSON and verify it contains the required top-level keys (`consensus`, `contradictions`, `blind_spots`, `unique_insights`) with the expected types.
4. **Retry loop (up to 3 attempts)** — If extraction or validation fails, the error is fed back to the judge in a follow-up message asking it to fix the output. The loop includes the previous error so the judge can correct formatting, missing keys, or invalid nesting.

If all retries are exhausted, the tool falls back to returning the raw panel responses with a note that synthesis failed.

### Cache Preservation

Fusion must not pollute the orchestrator's conversation cache — the orchestrator's session state should be unaffected by the Fusion call:

- Panel calls are **stateless `complete()` calls** — no session, no conversation history stored
- The orchestration session's message list is untouched throughout the Fusion process
- Only the **final tool result** (structured analysis text) is appended to the orchestrator's conversation, exactly like a delegate result
- Analysis text is compact: ~500–1000 tokens of structured JSON, comparable to a delegate return value

This means the orchestrator can call Fusion, get back a structured analysis, and continue planning with its full context intact.

### Error Handling

- **Partial success**: If at least 1 panelist responds successfully, the judge still runs on whatever panel output is available. Even a single panelist can benefit from the judge's structured extraction and synthesis, so the orchestrator receives a normalized `FusionResult` rather than raw advice.
- **Single-panelist fallback**: When only one panelist succeeds, the judge receives that one response plus the original context and still produces `consensus`, `contradictions` (empty if none), `blind_spots`, and `unique_insights`. This keeps the orchestrator's consumption path uniform.
- **All panelists fail**: Return a `{ error: string }` with diagnostic information. The orchestrator can then proceed without Fusion input.
- **Judge fails**: Return the raw panel responses with a note that synthesis failed. The orchestrator still gets the individual perspectives.
- **Timeouts**: Each panel call has a 30-second timeout; the judge has 60 seconds.

### Panel Reporting Mechanism

Panel models now have access to the `reportFinding` tool during their analysis, identical to the mechanism used by subagent specialists.

**Flow:**
1. Each panel model receives `tools: [reportFinding]` via `context.tools` in `complete()`
2. During analysis, the model deterministically calls `reportFinding("key finding")` for each noteworthy insight
3. The orchestrator executes the tool call: adds a `✓ Report:` entry to the activity feed (same visual as subagent reports)
4. The tool result is returned to the model, which continues its analysis
5. Once no more tool calls, the final analysis text is extracted

**Benefits:**
- Model decides what's report-worthy (not code parsing/truncation)
- Reports appear in the activity feed as `✓ Report:` — same deterministic mechanism as subagents
- No 300-char truncation of raw responses
- Users see concise key findings from each panelist in real-time

**Fallback for non-reporting panelists:** If a panel model completes without calling `reportFinding`, its full response text is captured as a single finding. This ensures no panel contribution is lost when a model ignores the tool or produces only prose.

**Implementation:**
- `fusion-tool.ts` wraps each panel `complete()` call in a multi-turn loop
- Reports are **batched per model** — emitted as a single `onUpdate` after model completes, not streamed individually
- Fixed tool call message pairing bug: assistant response with `tool_calls` pushed before toolResult messages
- `stopReason` checked for `"error"`/`"aborted"` to prevent silent failures
- Empty-content guard: skips reports with empty `content` field

**Cache optimization**: Each panel `complete()` call receives `sessionId` from `ctx.sessionManager.getSessionId()`. This enables provider-side KV cache keying on session ID, improving cache hit rates across panel evaluation turns (per pi-cache-optimizer best practices).

## 3.5 Toggleable Feature

The Fusion tool can be enabled or disabled without breaking the orchestrator workflow. Three toggle mechanisms:

### Config-level toggle (`enabled` field)

`.pi/fusion.json` has an `enabled` boolean:

```json
{
  "enabled": true,
  "panel": ["nyro/kimi-k2.6-2", "nyro/deepseek-v4-flash-2"],
  "judge": "nyro/kimi-k2.6-2"
}
```

When `enabled: false`:
- The fusion tool is NOT registered (or is blocked at execution)
- The orchestrator's tool list reverts to `["plan", "delegate"]` only
- No system prompt instructions about fusion are injected
- The orchestrator workflow is identical to before Fusion existed

When `enabled: true`:
- Fusion tool is registered and added to `setActiveTools(["plan", "delegate", "fusion"])`
- Fusion instructions are added to the orchestrator's system prompt
- Fusion is removed from the tool blocking list

### Session-level toggle (`/fusion` command)

A `/fusion on|off` slash command overrides the config for the current session:

- `/fusion on` — enable fusion for this session (overrides config `enabled: false`)
- `/fusion off` — disable fusion for this session (overrides config `enabled: true`)
- `/fusion` — show current fusion status (enabled/disabled, panel, judge)

Session state is ephemeral — resets on session restart.

### TUI Management

Typing `/fusion` without arguments opens an interactive TUI overlay via `ctx.ui.custom()` for full configuration management. The TUI provides:

- **Model picker** — Browse and select panel/judge models from the registry
- **Toggle switch** — Enable/disable Fusion with inline boolean switch
- **Temperature control** — Cycle through presets or input custom value
- **Live config summary** — Shows current panel, judge, and settings before saving

For quick non-interactive actions, slash command variants cover the most common tasks:

| Command | Action |
|---------|--------|
| `/fusion on` | Enable Fusion for this session (overrides config `enabled: false`) |
| `/fusion off` | Disable Fusion for this session (overrides config `enabled: true`) |
| `/fusion status` | Show current Fusion status (enabled/disabled, panel, judge, temperature) |

The TUI writes changes to `~/.pi/fusion.json` on save, so config persists across sessions. Slash commands use ephemeral session state only.

### Auto-disable on config errors

If the fusion config is invalid (e.g., panel models resolve to nothing, judge model not found), the tool gracefully degrades:
- Logs a warning
- Skips fusion registration
- Continues with normal orchestrator workflow
- No crash, no error messages to the user

### Implementation

```typescript
// index.ts — registration logic (actual implementation)
registerFusionTool(pi, ctx.cwd);  // reads config internally, skips if disabled
const activeTools = ["plan", "delegate"];
if (pi.getAllTools().some(t => t.name === "fusion")) {
    activeTools.push("fusion");
}
pi.setActiveTools(activeTools);
```

The `registerFusionTool()` function checks `fusionConfig.enabled` and skips registration if false. The `/fusion` command stores session state in a module-level variable that `registerFusionTool` checks at runtime.

---

## 5. Config Format (`.pi/fusion.json`)

### Default Configuration

```json
{
  "enabled": true,
  "panel": ["nyro/kimi-k2.6-2", "nyro/deepseek-v4-flash-2"],
  "judge": "nyro/kimi-k2.6-2",
  "maxPanelModels": 3,
  "temperature": 0.3,
  "maxTokensPerPanel": 2048,
  "maxTokensForJudge": 4096
}
```

### Resolution Priority

The system resolves the Fusion configuration in the following order, from highest to lowest priority:

1. **`.pi/fusion.json` (project-local)** — Per-project configuration checked into the repo. Allows teams to set panel/judge models appropriate for their codebase.

2. **`~/.pi/agent/fusion.json` (user-global)** — User-level configuration that applies across all projects. Useful for setting personal preferences (e.g., "I always want Kimi as judge").

3. **Auto-diverse (intelligent defaults)** — If no config file exists, the system automatically selects 2 models from `getAvailable()` that have different providers (e.g., DeepSeek + Moonshot). This ensures basic diversity without any configuration.

4. **Fallback: current session model** — If `getAvailable()` returns only one model, or if auto-diversity fails, the system falls back to using the orchestrator's current session model for both panel and judge roles. This ensures Fusion never blocks on configuration.

### Configuration Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the Fusion tool. When false, tool is not registered. |
| `panel` | string[] | `["kimi-k2.6-2", "deepseek-v4-flash-2"]` | Model IDs for panel advisors. 2-3 recommended. |
| `judge` | string | `"kimi-k2.6-2"` | Model ID for the synthesizer. Should be strongest model. |
| `maxPanelModels` | number | `3` | Maximum panel size if config specifies more. |
| `temperature` | number | `0.3` | Generation temperature for all Fusion calls. Lower = more focused. |
| `maxTokensPerPanel` | number | `2048` | Max tokens per panel response. |
| `maxTokensForJudge` | number | `4096` | Max tokens for judge synthesis. Larger needed to ingest all panel responses. |

**Cache optimization**: The `sessionId` from the active pi session is automatically passed to all panel model `complete()` calls for provider-side KV cache affinity. No user configuration required.

### TUI-Based Configuration

The `/fusion` command opens an interactive TUI overlay that replaces manual JSON editing. The TUI uses `ctx.ui.custom()` for rendering and `ctx.modelRegistry.getAvailable()` to populate model pickers.

**Model picker mechanics:**

- **Panel models** — Multi-select from `ctx.modelRegistry.getAvailable()`. Only auth-configured models appear. Order matters — first selected is primary panelist. Limit: 1-3 selections enforced.
- **Judge model** — Single-select from the same registry. Labeled "Judge" and visually separated from panel selection.
- **Toggle** — Inline boolean switch for `enabled` field. Toggled via enter/click.
- **Temperature** — Cycle through preset values (0.1, 0.3, 0.5, 0.7) or type a custom float.

**Save behavior:**

On save, the TUI writes to `~/.pi/fusion.json` using the same JSON format as manual config. The file remains compatible with all resolution priority rules (project-local → user-global → auto-diverse → fallback). Users can switch between TUI and direct file editing freely.

**Quick shorthand:**

| Command | Effect |
|---------|--------|
| `/fusion` | Open interactive TUI overlay |
| `/fusion on` | Enable Fusion (session) |
| `/fusion off` | Disable Fusion (session) |
| `/fusion status` | Print current config to chat |

---

## 6. Model Selection Guide

> This section is user-facing. It should appear in documentation and help output.

### How to Choose Panel Models

Panel models are **advisors**. They should be:

1. **Different from each other** — Pick models from different providers (e.g., DeepSeek + MiniMax + Kimi). Models from the same family (e.g., DeepSeek V4 Flash and DeepSeek V4 Pro) have correlated training data and correlated errors, which adds minimal diversity to the panel.

2. **Different from the orchestrator model** — The orchestrator already embedded its perspective in the research findings and draft plan. The panel should bring fresh viewpoints. If the orchestrator is using `deepseek-v4-flash-2`, don't put another DeepSeek model on the panel.

3. **Capable but not necessarily frontier** — OpenRouter's budget preset proved that a panel of cheap, capable models combined with a strong judge can beat an expensive solo model. The panel doesn't need to be the most expensive or powerful models available.

4. **Reliable with structured contexts** — Some models (e.g., DeepSeek V4 Pro) are strong in one-shot benchmark scenarios but inconsistent in practice. Panel models need to reliably follow instructions and stay on topic. Community-verified reliability matters more than benchmark scores.

### How to Choose the Judge

The judge is **the single most important model** in Fusion. It must be:

1. **The strongest model you have available** — Synthesis, contradiction detection, and gap identification are harder tasks than generation. Every benchmark and real-world implementation uses the strongest available model as judge. Do not economize on the judge.

2. **From a different provider than most panel models** — This reduces **self-preference bias**, where models favor their own output over others'. If the panel is DeepSeek + MiniMax, the judge should be Kimi.

3. **Capable of structured output** — The judge must produce a consistent JSON structure with top-level keys for `consensus`, `contradictions`, `blind_spots`, and `unique_insights`. It should follow formatting instructions reliably.

4. **Large context window** — The judge needs to ingest the original context, the draft plan, and 2-3 panel responses (each ~2000 tokens). A context window of at least 16K tokens is recommended.

### Default Configuration for This Nyro Setup

**Recommended (Best Quality)** — **~$0.008 per call:**

```
Panel:  deepseek-v4-flash-2  +  kimi-k2.6-2
Judge:  kimi-k2.6-2
```

**Why this works:**
- **Flash** is the community-favorite cheap workhorse — reliable, fast, good at following instructions
- **Kimi K2.6** is the strongest reasoning model on Nyro based on multiple hands-on tests and community consensus
- **Different providers** (DeepSeek + Moonshot/AI-Kimi) ensures perspective diversity
- **Kimi as judge** is strong enough to catch Flash's blind spots, and the self-fusion effect (Kimi × 2) provides additional lift from synthesis alone

#### Real-World Surprise: DeepSeek V4 Flash > Pro (for tool use)

Community reports (HN, Reddit, hands-on evals) consistently show DeepSeek V4 Flash outperforming V4 Pro in agentic/tool-use scenarios, despite Pro having higher benchmark scores. Key findings:

- Flash won 7/20 tasks against ALL 4 Pro modes in one hands-on test (Chew Long Nian)
- HN reports: "Pro significant amount of time it just sucks. Flash is amazing"
- Pro is overfit to common benchmark harnesses — struggles with custom tool setups
- Flash is 3-4x cheaper ($0.14 vs $0.435/M input) and 3x faster

This reinforces the Fusion design principle: **trust real-world reliability over benchmark scores** when selecting panel models.

### Alternative Configurations

| Config | Panel | Judge | Cost | Best For |
|--------|-------|-------|------|----------|
| **Budget** | flash × 2 (self-fusion) | flash | ~$0.001 | Routine plans, cost-sensitive environments |
| **Balanced** | flash + minimax-m3 | kimi | ~$0.006 | General use, day-to-day planning |
| **Max diversity** | flash + kimi + minimax-m3 | kimi | ~$0.01 | High-stakes decisions, complex multi-step plans |
| **Strongest** | kimi + minimax-m3 | kimi | ~$0.015 | Critical architecture calls, design decisions |

### Quick Rules of Thumb

- **Judge must always be your best model.** Never compromise here.
- **Panel should have at least 2 models** from different providers.
- **Don't put your orchestrator model on the panel** — it adds nothing new.
- **2 panelists + 1 judge is the sweet spot.** 3 panelists for high-stakes tasks.
- **If in doubt, use self-fusion** (same model × 2 on panel, same model as judge). The judge alone adds ~6.7 points.

### TUI Model Picker

When using the `/fusion` TUI overlay, model selection works differently from raw config editing. Instead of typing model IDs (error-prone, prone to typos), the TUI presents a filtered, searchable list of **real available models** from pi's model registry (`ctx.modelRegistry.getAvailable()`).

**Key behaviors:**

- **Grouped by provider** — Models are organized under provider headings (e.g., `nyro/`, `openai/`, `anthropic/`). Users can collapse/expand providers.
- **Only auth-configured models shown** — If a model isn't configured with valid API keys in pi's config, it doesn't appear. No invalid selections possible.
- **Search/filter** — Typing filters the list by model name or provider. Useful when the registry has many entries.
- **Visual indicators** — Shows context window, cost tier, and capability badges alongside each model name.
- **Eliminates typos** — Users never type model IDs. Selection is always a valid, configured model from the registry.

This approach means the TUI model picker is **self-documenting** — the list of available models reflects the user's actual pi setup at that moment, not a static documentation page.

---

## 7. Implementation Plan

### Files to Create or Modify

| Action | File | Approx. Size | Description |
|--------|------|--------------|-------------|
| **CREATE** | `fusion-tool.ts` | ~310 lines | `registerFusionTool()`, panel execution, judge synthesis, result formatting |
| **MODIFY** | `types.ts` | +20 lines | `FusionConfig` interface, `FusionOptions` type, `FusionResult` type |
| **MODIFY** | `index.ts` | +10 lines | Import `registerFusionTool`, call at startup, add to tool list, update system prompt |
| **CREATE** | `.pi/fusion.json` | ~15 lines | Default config with panel + judge models |
| **CREATE** | `fusion-commands.ts` | ~120 lines | `/fusion`, `/fusion on`, `/fusion off`, `/fusion status` slash command handler |
| **CREATE** | `fusion-tui.tsx` | ~130 lines | TUI model picker component using `SelectList` from `@earendil-works/pi-tui` |

**New code total: ~250 lines** (TUI command handler + model picker component).

**SDK compliance for `fusion-tool.ts`:**
- SDK compliance: uses `throw new Error(...)` for error signaling (SDK canonical pattern sets `isError: true`)
- Includes `promptSnippet` and `promptGuidelines` for LLM tool discovery
- Typed execute signature: `(toolCallId, params: FusionParams, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext)`

### Dependencies (All Already Available in Orchestrator)

```
@earendil-works/pi-ai           → complete(), Message, AssistantMessage
@earendil-works/pi-coding-agent → ExtensionAPI, ExtensionContext, ModelRegistry, createReadToolDefinition
@earendil-works/pi-tui          → SelectList, custom() (nested dep, already available)
typebox                          → Type.Object, Type.String, Type.Optional
```

### Key Implementation Details

- **Tool uses existing pi-fusion patterns**: `ctx.modelRegistry.find()` for model resolution, `complete()` for LLM calls, `mapWithConcurrencyLimit()` for parallel execution
- **Panel runs with bounded concurrency**: Panel models are called via `mapWithConcurrencyLimit()` with concurrency of 2. Limiting simultaneous requests protects rate-limited models from throttling while still overlapping network latency.
- **Judge runs after all panel responses collected**: The judge receives the concatenated panel outputs and original context
- **Panel models use `reportFinding` tool**: Each panel `complete()` call is wrapped in a multi-turn loop. Panel models receive `tools: [reportFinding]` and deterministically call it for key insights. Reports appear in the activity feed as `✓ Report:` entries. Loop continues while `stopReason === "toolUse"`, then final analysis text is extracted.
- **Error handling**: If 1+ panelists succeed, the judge still runs to produce a structured `FusionResult`. If all panelists fail, return a descriptive error. If judge extraction fails after retries, return raw panel responses.
- **Structured output from judge**: The judge must produce JSON with four top-level keys:

```typescript
interface FusionResult {
  consensus: string[];                     // Points all panelists agreed on
  contradictions: Array<{                  // Conflicting opinions
    topic: string;                         // What the contradiction is about
    stances: Array<{ model: string; position: string }>;  // Who said what
  }>;
  blind_spots: string[];                   // Issues all panelists missed
  unique_insights: Array<{                 // Valuable points from individual panelists
    model: string;                         // Which model contributed this
    insight: string;                       // The insight itself
  }>;
}
```

### System Prompts

**Panel system prompt:**
```
You are a planning advisor. Review the provided context and draft plan carefully.
Provide constructive criticism focusing on:
1. Blind spots — what is the plan missing?
2. Risks — what could go wrong?
3. Alternatives — is there a better approach?
4. Sequencing — are the steps in the right order?

Be specific, direct, and practical. Reference code or patterns from the context
where relevant. Do not repeat what the plan already does well — focus on
improvement.
```

**Judge system prompt (JUDGE_SYSTEM_PROMPT):**
```
You are a planning synthesizer. Your job is to compare the responses from
multiple planning advisors and produce a structured synthesis.

Compare all responses carefully and identify:
1. CONSENSUS — where do multiple advisors agree?
2. CONTRADICTIONS — where do advisors disagree, and what is each stance?
3. BLIND SPOTS — what important issues did ALL advisors miss?
4. UNIQUE INSIGHTS — what valuable points did individual advisors make?

Output your analysis as a JSON object with the following structure:
{
  "consensus": ["point 1", "point 2", ...],
  "contradictions": [
    { "topic": "topic description", "stances": [{ "model": "model-id", "position": "stance" }] },
    ...
  ],
  "blind_spots": ["issue 1", "issue 2", ...],
  "unique_insights": [
    { "model": "model-id", "insight": "valuable point" },
    ...
  ]
}

Be thorough. A good synthesis often reveals things no individual advisor saw.
```

### 7.2 pi-fusion Extension Patterns Used

This implementation follows established patterns from the pi-ecosystem's fusion extension:

1. **Tool registration via `pi.registerTool()` with TypeBox params** — Same pattern as `delegate-tool.ts`. The `createReadToolDefinition` factory produces a standard tool definition that integrates with the orchestrator's tool list.

2. **Model resolution via `ModelRegistry.find()` + `getApiKeyAndHeaders()`** — Models are resolved by their string ID (e.g., `"nyro/kimi-k2.6-2"`). The registry handles provider routing, API key lookup, and header construction.

3. **Parallel execution via `mapWithConcurrencyLimit()`** — The same utility used elsewhere in pi-fusion for parallel model calls. Concurrency is limited to 2 to avoid rate limits and stay within API budgets.

4. **Hard-coded tool factories for safety** — Tool implementations are factory functions (not class-based), which makes them easy to test and prevents state leakage between invocations.

5. **Layered config loading** — Configuration is resolved from project-local → user-global → auto-diverse → fallback, matching the pattern used by other pi-fusion extensions.

### 7.3 SDK Audit Summary

All SDK interactions audited against canonical pi patterns:

| API | Status | Notes |
|-----|--------|-------|
| `pi.registerTool()` | ✅ PASS | All required fields present. `promptSnippet`/`promptGuidelines` added for LLM discovery. |
| `execute()` signature | ✅ PASS | Typed with `FusionParams`, `AbortSignal`, `ExtensionContext`. |
| `complete()` | ✅ PASS | Model + Context + ProviderStreamOptions — matches SDK exactly. |
| `ModelRegistry.find()` | ✅ PASS | Returns `Model<Api> \| undefined`. |
| `ModelRegistry.getApiKeyAndHeaders()` | ✅ PASS | Returns `{ ok, apiKey, headers, error }`. |
| `ModelRegistry.getAvailable()` | ✅ PASS | Returns `Model<Api>[]`. |
| Error signaling | ✅ PASS | `throw new Error(...)` — SDK canonical. Sets `isError: true` on tool result. |
| TypeBox parameters | ✅ PASS | `Type.Object` with `description` on all fields. `Type.Optional` for optional fields. |

See [`fusion-tool.ts`](../fusion-tool.ts) for the implementation.

### 7.4 TUI Implementation

**Command handler** (`fusion-commands.ts`):

- Registers slash commands: `/fusion`, `/fusion on`, `/fusion off`, `/fusion status`
- `/fusion` (no args) calls `ctx.ui.custom()` to render the interactive TUI overlay
- Slash command variants (`on|off|status`) execute without TUI — set session state or print status
- Uses same `FusionConfig` interface as `fusion-tool.ts` for consistency
- Session state stored in a module-level variable, checked by `registerFusionTool()` at runtime

**Model picker component** (`fusion-tui.tsx`):

- Uses `SelectList` from `@earendil-works/pi-tui` for keyboard-navigable model selection
- Calls `ctx.modelRegistry.getAvailable()` on mount to populate the list
- Renders models grouped by provider (e.g., `nyro/`, `openai/`, `anthropic/`)
- Multi-select mode for panel models (1-3 limit enforced), single-select for judge
- Supports keyboard navigation, search filtering, and visual capability badges
- On confirm, writes selection to `~/.pi/fusion.json`

**Config persistence:**

Both the TUI overlay and slash commands write to the same `~/.pi/fusion.json` file. The file format is identical to manual config — no migration needed. Config resolution priority (project-local → user-global → auto-diverse → fallback) applies after TUI save.

**Dependencies:**

`@earendil-works/pi-tui` is already available as a nested dependency of the orchestrator extension. No additional `npm install` required.

### 7.5 SDK Compliance & Cache Optimization

The fusion implementation follows pi SDK patterns precisely:

**SDK compliance:**
- `complete()` from `@earendil-works/pi-ai` with correct `Context`, `Tool`, and `ProviderStreamOptions` types
- `registerTool()` with full `ToolDefinition` shape
- `ToolResultMessage` includes all required fields (`role`, `toolCallId`, `toolName`, `content`, `isError`, `timestamp`)
- `stopReason` checked for `"error"`/`"aborted"` to prevent silent failures
- Fixed tool call message pairing: assistant response with `tool_calls` is pushed before toolResult messages (previously pushed after, violating SDK message order)
- Empty-content guard added: reports with empty `content` field are skipped before tool execution

**Cache optimization (per pi-cache-optimizer rules):**
- `sessionId` passed to each `complete()` call for provider-side KV cache affinity
- Static system prompts — stable prefix for prompt caching
- Reports **batched per model** — single `onUpdate` after model completes reduces update overhead (no per-report streaming)
- `reportFindingTool` definition hoisted to module-level constant — identical across turns

**Debug command:** See [section 7.7](#77-debuggability) for how `/debug-orchestrator status` surfaces Fusion panel/judge interactions.

**Audit status:** All checks pass. No deprecated APIs used.

### 7.6 Display Format

Fusion output uses a structured display format for clarity in the activity feed:

**Panel phase display:**
- On start: `⚡ Fusion: panel (kimi-k2.6-2, deepseek-v4-flash-2)` — no trailing `...`
- Each panel model runs, reports are collected internally

**Per-model reports (batched):**
- After each model completes, a single block is emitted:
  ```
  ── Panel: kimi-k2.6-2 ──
    ✓ report1
    ✓ report2
  ```
- Reports are **not streamed individually** — they are batched per model and emitted in one `onUpdate`

**Judge analysis display:**
- Judge output is formatted as structured report entries:
  - `✓ Consensus: ...` — points all panelists agreed on
  - `⚡ Contradiction: ...` — conflicting opinions between panelists
  - `⚠ Blind spot: ...` — issues all panelists missed
  - `→ Recommendation: ...` — actionable recommendations
- Each entry type uses a distinct prefix icon for visual scanning

---

## 7.7 Debuggability

Fusion interactions can be inspected with the `/debug-orchestrator status` command. When run, it surfaces:

- Which panel models were invoked and their raw responses
- Judge synthesis input/output and any retry attempts
- Per-model report timing and `reportFinding` calls
- Current orchestrator state, including active tools and session flags

This is useful for diagnosing malformed judge JSON, unexpected panel failures, or rate-limit behavior.

## 8. Appendices

### A. Related Research and Prior Art

| Work | Source | Year | Key Finding |
|------|--------|------|-------------|
| **Mixture-of-Agents (MoA)** | Together AI | 2024 | Layered multi-agent aggregation improves quality over any single model. Each layer proposes, next layer refines. |
| **Self-MoA** | Princeton | 2025 | Quality of synthesis matters more than diversity of proposers. Self-fusion (same model) provides 60-80% of the lift of diverse MoA. |
| **DRACO Benchmark** | Perplexity AI | 2025 | 100 deep research tasks requiring multi-step reasoning, fact-finding, and synthesis. Used by OpenRouter to benchmark Fusion. |
| **Fusion Architecture** | OpenRouter | 2026 | Parallel panel → judge → calling model. Budget preset achieves 64.7% DRACO at half cost. Self-fusion +6.7pt over solo. |

**Key takeaway for our implementation:** Self-MoA's finding that synthesis quality > proposer diversity validates our design choice to invest in a strong judge (Kimi K2.6) even if we use flash as a panelist. The judge alone contributes the majority of the improvement.

### B. pi-fusion Extension Patterns Used

Content moved to [section 7.2](#72-pi-fusion-extension-patterns-used).

### C. Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-06-19 | Robust judge JSON extraction (strip fences, brace-aware detection, schema validation, retry loop up to 3 with error feedback); panel concurrency capped at 2 via `mapWithConcurrencyLimit`; panel fallback captures full text when `reportFinding` is not used; judge runs even with a single successful panelist; `/debug-orchestrator status` exposes Fusion interactions | — |
| 2026-06-18 | Display fixes — Removed trailing `...` from panel onUpdate, batched reports per model (no per-report streaming), formatted judge analysis as report entries (✓/⚡/⚠/→) | — |
| 2026-06-18 | SDK compliance fixes + cache optimization — `stopReason` check (error/aborted) added to runPanelModel loop; `timestamp` field added to ToolResultMessage for type compliance; `sessionId` passed to `complete()` options for KV cache affinity; SDK audit: all patterns verified against pi official types | — |
| 2026-06-18 | Deterministic panel reporting — Panel models use `reportFinding` tool (same mechanism as subagent specialists); multi-turn `complete()` loop with `stopReason === "toolUse"` check; reports per-model via `onUpdate` callback; activity feed shows `✓ Report:` entries with panelist model ID attribution; no 300-char truncation | — |
| 2026-06-18 | TUI model picker integration — `/fusion` opens `ctx.ui.custom()` overlay with `SelectList` from `@earendil-works/pi-tui`; model list from `ctx.modelRegistry.getAvailable()`; grouped by provider; search/filter; multi-select panel (1-3 limit), single-select judge; writes to `~/.pi/fusion.json`; slash shortcuts `on|off|status` for session toggles | — |
| 2026-06-17 | Initial spec created. Research complete. Ready for implementation. | — |
