# Bash + Token Saver — Spec

## Problem

`pi-restrict-bash` (v2.0.0, kotarac) used a global `tool_call` interceptor with a hardcoded blacklist:

- Blocked ALL git write commands (`add`, `commit`, `push`, `rm`, etc.)
- Blocked shell syntax: pipes `|`, redirects `<>`, command substitution `$()`, variable expansion `${}`
- Blocked `cat`, `find`, `grep`, `ls`, `tree` (redirected to `rg`)
- Same rules for ALL agents — no per-specialist differentiation

This forced workarounds (`python3 -c "import subprocess..."`) and lobotomized subagent capabilities.

## Solution: Three Layers

```
┌────────────────────────────────────────────────────────┐
│  Layer 3: Output Compression (token-saver.ts)          │
│  ├─ RTK rewrite via createBashTool(spawnHook)          │
│  ├─ Fallback: 80-line tail cap + ANSI strip            │
│  └─ Read dedup (MD5 fingerprint)                       │
├────────────────────────────────────────────────────────┤
│  Layer 2: Per-Specialist Tool Selection (orchestrator) │
│  ├─ scout: git-read + gh custom tools (no bash)       │
│  ├─ coder: full bash (minus sudo/eval)                 │
│  ├─ reviewer: bash (read-only via system prompt)       │
│  ├─ researcher: no bash (web tools only)               │
│  └─ writer: no bash (no need)                          │
├────────────────────────────────────────────────────────┤
│  Layer 1: Tool Availability (specialists.ts)           │
│  ├─ tools[] array per specialist                       │
│  ├─ excludeTools for writer/researcher                 │
│  └─ customTools for scout (git-read, gh)               │
└────────────────────────────────────────────────────────┘
```

## Architecture

### token-saver.ts — Compression + RTK

Single extension handling all bash/read/grep/find/ls output compression.

**RTK integration (pre-execution):**

```typescript
const originalBash = createBashTool(cwd, {
	spawnHook: ({ command, cwd, env }) => {
		if (!rtkEnabled || !rtkAvailable) return { command, cwd, env };
		if (command.startsWith("rtk ")) return { command, cwd, env };
		const rewritten = rtkRewrite(command);
		return { command: rewritten ?? command, cwd, env };
	},
});
```

- `rtk rewrite <cmd>` rewrites commands with filtering flags (e.g., `git status --no-acknowledgments`)
- Exit codes: 0=rewritten, 1=no-op, 2=deny, 3=rewritten+advisory
- Fail-open: if RTK binary missing, falls back to in-process compression
- Version check: `rtk >= 0.23.0` required

**Output compression (post-execution):**

| Tool | Max Lines | ANSI Strip | Mode |
|---|---|---|---|
| bash | 80 | ✅ | tail-only (keep last N) |
| read | 300 | ❌ | head-only (keep first N) |
| grep | 120 | ❌ | head-only |
| find | 120 | ❌ | head-only |
| ls | 80 | ✅ | head-only |

**Token savings:** RTK 60-90% + line budgets ~80% = ~90-98% total reduction on bash output.

### SDK APIs Used

| API | Purpose |
|---|---|
| `createBashTool(cwd, { spawnHook })` | RTK rewrite before command execution |
| `pi.registerTool({...tool})` | Same-name override of built-in bash |
| `pi.on("session_start")` | Check RTK binary version |
| `pi.on("before_agent_start")` | Inject terse mode system prompt |
| `pi.registerCommand("rtk")` | Toggle RTK rewrite on/off |
| `pi.registerCommand("caveman")` | Toggle terse mode |
| `defineTool({...})` | Define custom tools (git-read, gh) |
| `createAgentSession({ customTools, tools })` | Pass per-specialist tools |

### Per-Specialist Bash Access

| Specialist | Has Bash? | How Restricted | Alternative |
|---|---|---|---|
| scout | ❌ | No bash in tools[] | `git-read` + `gh` custom tools |
| coder | ✅ | Full bash, spawnHook RTK only | — |
| reviewer | ✅ | Bash but prompt says read-only | — |
| researcher | ❌ | excludeTools: ["bash"] | web_search, fetch_content |
| writer | ❌ | excludeTools: ["bash"] | read, write, edit tools |

### Custom Tools for Scout

**git-read** — 27 read-only git subcommands whitelisted:

```
log, diff, status, show, branch, remote, ls-files,
describe, shortlog, blame, rev-parse, rev-list, cat-file,
ls-tree, for-each-ref, merge-base, name-rev, help, version,
var, check-attr, check-ignore, check-mailmap, count-objects,
tag, worktree
```

**gh** — Read-only GitHub CLI operations:

| Group | Subcommands |
|---|---|
| repo | view, list |
| issue | list, view, status |
| pr | list, view, status, diff, checks |
| release | list, view |
| search | issues, prs, repos, code, commits |
| auth | status |

## Key Design Decisions

1. **`createBashTool(spawnHook)` over global `pi.on("tool_call")`** — Restriction lives inside the tool instance, not as a global interceptor. Cache-safe, atomic, no risk of conflicting with other extensions.

2. **Per-specialist via tool selection, not bash command parsing** — Instead of parsing every bash command to decide if scout can run it, scout simply doesn't get bash. It gets purpose-built tools. Simpler, safer, less cache overhead.

3. **token-saver owns ALL compression** — One extension handles bash/read/grep/find/ls + RTK. No need for separate pi-rtk package. `/caveman` and `/rtk` commands in the same place.

4. **Fail-open RTK** — If `rtk` binary not installed, token-saver's line budgets still apply. Zero-dependency progressive enhancement.

5. **No global bash blacklist** — `pi-restrict-bash` removed entirely. Each session decides its own bash policy.

## Comparison: Before vs After

| Aspect | Before (pi-restrict-bash) | After |
|---|---|---|
| Approach | Global blacklist | Per-specialist tool selection |
| Git operations | Blocked (python3 workaround) | `git-read` tool for scout; full git for coder |
| Shell syntax | `\|`, `$()`, `<>` blocked | Full bash for coder, reviewer |
| Token optimization | None | RTK 60-90% + line budgets |
| Per-specialist | ❌ Same rules for all | ✅ scout/coder/reviewer/researcher/writer each unique |
| SDK compliance | Custom `tool_call` handler | `createBashTool(spawnHook)` + `defineTool()` + `createAgentSession({ customTools })` |
| Extensibility | Fork npm package to change rules | Edit TypeScript config or specialists.ts |
