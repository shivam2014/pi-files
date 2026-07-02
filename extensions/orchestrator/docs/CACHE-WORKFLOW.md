# DeepSeek Prefix Cache — Orchestrator Fix Workflow

## Problem

DeepSeek's ds4 inference engine uses **prefix caching**: it caches the tokenized prompt
from token 0 onward. On subsequent requests, if the prefix matches, cached tokens are
reused (zero cost). If even one token differs, the entire cache is invalidated.

The orchestrator extension was breaking this cache between turn 1 and turn 2 of every
session, doubling inference cost.

---

## How pi Builds the System Prompt

### Step 1: Extension Init (`_buildRuntime`)

During startup, pi loads extensions and registers tools. The relevant SDK code:

```
// agent-session.js — _buildRuntime()
for (const ext of extensions) {
    ext.module.default(api, ext.userConfig);   // ← extension init runs here
}
// After all extensions init:
this._refreshToolRegistry({ includeAllExtensionTools: true });
this._baseSystemPrompt = this._rebuildSystemPrompt(this._activeToolNames);
```

**Key**: After init, `_baseSystemPrompt` contains ALL registered tools in the
`Available tools:` section. The orchestrator registers `plan`, `delegate`, `fusion`.
Pi's built-in registers `edit`, `write`, `bash`, `grep`, `find`, `ls`, etc.
Token-saver registers `read`, `bash`, `grep`, `find`, `ls` as overrides.

At this point the system prompt has 15+ tools listed.

### Step 2: `session_start` fires

```
// agent-session.js — _buildRuntime()
await this._extensionRunner.emit("session_start", {});
// This fires AFTER tool registry is set up, BEFORE any prompts.
```

Extensions receive this event. The token-saver logs `[token-saver] Active — full mode (rtk ✓)`.

### Step 3: First User Prompt → `prompt()`

```
// agent-session.js — prompt()
// Create turn state from _baseSystemPrompt
const turnState = createTurnState({ ... this._baseSystemPrompt ... });

// Emit before_agent_start — extensions can modify the system prompt
const result = await this._extensionRunner.emitBeforeAgentStart(
    expandedText, currentImages,
    this._baseSystemPrompt,       // ← current base prompt
    this._baseSystemPromptOptions
);

// Apply extension-modified system prompt
if (result?.systemPrompt) {
    this.agent.state.systemPrompt = result.systemPrompt;
}

// Send to API with agent.state.systemPrompt as the system message
await this._runAgentPrompt(messages);
```

### Step 4: `setActiveTools` → Rebuilds `_baseSystemPrompt`

```
// agent-session.js — setActiveToolsByName(toolNames)
setActiveToolsByName(toolNames) {
    this._activeToolNames = validToolNames;
    this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);  // ← REBUILT
    this.agent.state.systemPrompt = this._baseSystemPrompt;
}
```

**Critical**: This mutates `_baseSystemPrompt` **immediately**. The next turn's
`createTurnState()` will read the new value.

---

## How the Cache Was Being Broken

### Before Fix: `setActiveTools` inside `before_agent_start`

The orchestrator extension called `pi.setActiveTools(["plan", "delegate", "fusion"])`
inside its `before_agent_start` hook:

```typescript
// orchestrator/index.ts (BEFORE fix)
pi.on("before_agent_start", async (event, ctx) => {
    pi.setActiveTools(["plan", "delegate", "fusion"]);  // ← BUG: 1-turn lag
    // ...
    return { systemPrompt: buildOrchestratorPrompt(...) };
});
```

### Execution Timeline (Before Fix)

```
Init:
  1. registerTool() for ALL tools
  2. _refreshToolRegistry() → activeToolNames = [edit, write, bash, grep, ..., plan, delegate, fusion]
  3. _rebuildSystemPrompt() → _baseSystemPrompt has ALL tools in "Available tools:"

Turn 1 — "hi":
  4. prompt() calls _baseSystemPrompt (has ALL 15+ tools)
  5. before_agent_start fires:
     5a. orchestrator calls pi.setActiveTools(["plan", "delegate", "fusion"])
         → setActiveToolsByName immediately mutates _baseSystemPrompt
         → NOW _baseSystemPrompt has ONLY fusion (plan/deliver lack promptSnippet)
     5b. buildOrchestratorPrompt appends orchestrator instructions
         → result.systemPrompt = narrowed_base + orchestrator_text
  6. API receives system prompt with:
     "Available tools: - fusion: Get multi-model advice..."
     + orchestrator instructions

Turn 2 — user message:
  7. prompt() calls _baseSystemPrompt (NOW has only fusion — mutated by step 5a)
  8. before_agent_start fires:
     8a. setActiveTools NOT called again (same code path, same value → no mutation)
     8b. buildOrchestratorPrompt checks dedup → finds "## Orchestrator Mode" → returns unchanged
  9. API receives system prompt with:
     "Available tools: - fusion: Get multi-model advice..."
     + orchestrator instructions
```

### Why Turn 1 ≠ Turn 2

Turn 1's `emitBeforeAgentStart` receives `this._baseSystemPrompt` which still has ALL
tools (from step 3). The orchestrator's handler mutates it during processing, but the
**input** to `emitBeforeAgentStart` was the old prompt.

Turn 2's `emitBeforeAgentStart` receives the **already-mutated** `_baseSystemPrompt`
with only fusion.

But wait — the **result** returned by `emitBeforeAgentStart` replaces
`agent.state.systemPrompt`. Both turns return `narrowed_base + orchestrator_text`. So
they SHOULD be the same...

**The actual cache break is earlier**: the tool schemas (function definitions) sent to
the API also change. `setActiveTools` filters which tool schemas are sent. Turn 1 sends
ALL tool schemas. Turn 2 sends ONLY plan, delegate, fusion schemas. DeepSeek caches the
entire request including the tool schema array, so different schemas = cache miss.

Additionally, looking at the trace more carefully:

```
812 !=  live 19482 " edit" | prompt 25571 " fusion"
```

Token 812 diverges. This is in the system prompt's `Available tools:` section. Turn 1
had `- edit: Make precise file...` but Turn 2 had `- fusion: Get multi-model advice...`.

This means the `_baseSystemPrompt` mutation IS leaking into the system prompt text
between turns. The `emitBeforeAgentStart` call passes `this._baseSystemPrompt` by
reference — when the orchestrator mutates it via `setActiveTools`, the next turn reads
the mutated value.

### The Root Cause (Summary)

`setActiveTools` inside `before_agent_start` causes:

1. **Turn 1 system prompt**: Built from pre-mutation `_baseSystemPrompt` (ALL tools),
   then handler mutates it mid-processing → actual API call uses mutated version
2. **Turn 2 system prompt**: Built from post-mutation `_baseSystemPrompt` (narrowed)
3. **Different tool schemas**: Turn 1 sends 15+ tool definitions, Turn 2 sends 3
4. **Different system prompt text**: `Available tools:` section differs
5. **ds4 prefix cache**: Token 0+ diverges → `token-mismatch` → full cache miss

---

## The Fix

Move `setActiveTools` from `before_agent_start` to `session_start`:

```typescript
// orchestrator/index.ts (AFTER fix)

// Freeze active tools at session_start — runtime is bound by now,
// fires BEFORE first prompt, so _baseSystemPrompt is narrowed from turn 1.
pi.on("session_start", async () => {
    const fusionConfig = loadFusionConfig(process.cwd());
    const activeTools: string[] = ["plan", "delegate"];
    if (fusionConfig.enabled) {
        activeTools.push("fusion");
    }
    pi.setActiveTools(activeTools);
});

// System prompt modification — NO setActiveTools call here
pi.on("before_agent_start", async (event, ctx) => {
    new ScopeManager(process.cwd()).clearScope();
    clearPlanPanel(ctx);
    // ... build orchestrator prompt ...
    return { systemPrompt: buildOrchestratorPrompt(...) };
});
```

### Execution Timeline (After Fix)

```
Init:
  1. registerTool() for ALL tools
  2. _refreshToolRegistry() → activeToolNames = [edit, write, bash, ..., plan, delegate, fusion]
  3. _rebuildSystemPrompt() → _baseSystemPrompt has ALL 15+ tools

session_start:
  4. setActiveTools(["plan", "delegate", "fusion"])
     → _rebuildSystemPrompt() → _baseSystemPrompt now has ONLY fusion
     → _toolDefinitions filtered to plan, delegate, fusion schemas

Turn 1 — "hi":
  5. prompt() → createTurnState reads _baseSystemPrompt (fusion only)
  6. emitBeforeAgentStart receives _baseSystemPrompt (fusion only)
  7. buildOrchestratorPrompt appends orchestrator instructions
  8. API receives:
     System prompt: "Available tools: - fusion: Get multi-model advice..."
                    + orchestrator instructions
     Tool schemas: plan, delegate, fusion

Turn 2 — user message:
  9. prompt() → createTurnState reads _baseSystemPrompt (STILL fusion only — unchanged)
 10. emitBeforeAgentStart receives _baseSystemPrompt (STILL fusion only)
 11. buildOrchestratorPrompt dedup → unchanged
 12. API receives:
     System prompt: "Available tools: - fusion: Get multi-model advice..."
                    + orchestrator instructions
     Tool schemas: plan, delegate, fusion
```

### Why This Fixes the Cache

| Aspect | Turn 1 | Turn 2 | Match? |
|--------|--------|--------|--------|
| System prompt text | fusion + orchestrator | fusion + orchestrator | ✓ |
| Tool schemas | plan, delegate, fusion | plan, delegate, fusion | ✓ |
| Messages | user: "hi" | assistant: reply + user: msg | (different — expected) |

The system prompt + tool schemas are **identical** between turns. DeepSeek's prefix
cache sees the same token 0..N prefix → cache hit on tokens from turn 1.

### Subagent Isolation

The `setActiveTools` call only affects the **parent** session's `_baseSystemPrompt` and
`_toolDefinitions`. Subagents created by `delegate()` use `createAgentSession()` with
their own `tools` and `allowedToolNames` — completely isolated state. The fix does not
affect subagent tool sets.

```
Parent session: setActiveTools(["plan", "delegate", "fusion"])
  ↓ only affects parent's _baseSystemPrompt and _toolDefinitions
  ↓ subagents are separate AgentSession instances with their own state
Subagent (scout): tools = ["read", "grep", "find", "ls"]
Subagent (coder): tools = ["read", "bash", "edit", "write"]
Subagent (reviewer): tools = ["read", "bash", "grep"]
```

---

## ds4 Trace Evidence

From `trace1.txt`:

```
--- request 1 ---
live_tokens_before: 0
prompt_tokens: 7598
memory_miss_reason: no-live-checkpoint
cache_source: none
cached_tokens: 0

--- request 2 ---
live_tokens_before: 0
prompt_tokens: 6337
memory_miss_reason: token-mismatch
live_prompt_common: 812
first_mismatch_token: 812

811 ==  live 15 "-"      | prompt 15 "-"
812 !=  live 19482 " edit" | prompt 25571 " fusion"
```

Turn 1: 7598 tokens, full tool list → token 812 = " edit"
Turn 2: 6337 tokens, narrowed tool list → token 812 = " fusion"
1261 fewer tokens in turn 2 (the pruned tool descriptions).
Cache miss at token 812 — entire prefix invalidated.

After fix: both turns will have ~6337 prompt tokens with identical tool list.
Turn 2 gets `cached_tokens: ~812+` (at minimum the system prompt prefix).

---

## Testing

```bash
# Run smoke test — verify orchestrator still works
bash ~/.pi/tui-smoke.sh pi "create a hello world script"

# Check snapshots for:
# 1. "[token-saver] Active" appears (session_start fired)
# 2. System prompt in turn 2 has same tool list as turn 1
# 3. No "token-mismatch" in subsequent requests
```
