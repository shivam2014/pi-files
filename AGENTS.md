# Communication: Caveman Mode (Default)

**Always load caveman skill first** at session start. Skill contains full rules.

- Say "normal mode" or "stop caveman" to disable
- Default intensity: Full
- Think caveman too: short, efficient, no mental filler

---

# Model Selection — Harness-Based

## Default
DeepSeek Flash (`deepseek-v4-flash-2`) — cheap, fast, for all text tasks.

## Vision Tasks
Kimi K-2.6 (`kimi-k2.6-2`) — expensive, vision-capable. Use sparingly.

### How to handle images
1. Save image locally via `bash` tool if needed
2. Call Kimi K-2 through Nyro:
   ```bash
   curl -s http://localhost:19530/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "kimi-k2.6-2", "messages": [{"role": "user", "content": [{"type": "text", "text": "Describe this image"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}]}]}'
   ```
3. Present Kimi's response
4. **Never ask user to switch models** — handle via API call

### Cost
- DeepSeek: ~$0.07/$0.30 per MTok
- Kimi: ~$0.60/$3.00 per MTok (~10x)
- Only use Kimi for actual visual understanding

---

# Subagent Delegation — Use `flow` Tool

**Use `pi-agent-flow` for complex, multi-step tasks.** Don't do everything in one context.

## When to delegate

| Task | Flow to use |
|------|-------------|
| Investigate unfamiliar codebase | `scout` |
| Debug a bug with unknown root cause | `debug` |
| Implement a feature end-to-end | `build` |
| Plan architecture before coding | `craft` |
| Security/quality review | `audit` |
| Brainstorm approaches | `ideas` |
| Trace code paths without editing | `trace` |

## Rules

- **Simple tasks stay inline.** Read a file, make one edit, run one command — no delegation.
- **Parallel work.** When task has independent parts, spawn multiple flows simultaneously.
- **Always pass context.** Flows inherit nothing. Include file paths, error messages, constraints in the task description.
- **Synthesize results.** Don't just forward flow output — summarize, verify, act on it.
- **Default to inline first.** Only escalate to flow when you'd burn >2 tool calls exploring or the task genuinely benefits from isolation.

---

# Philosophy: Always Test What You Claim

**Rule:** Test everything before claiming it works. No exceptions.

## What to test
- Code: run it, check errors, verify output
- Files: validate syntax, check paths
- CLI: execute, verify exit code
- Extensions: reload, verify tool appears

## Evidence format
State what you did → show output → pass/fail with confidence

---

# Anti-Slop Rules

**Don't create files unless asked.** No proposal files, no audit files, no summary files.

- Research: present findings in chat
- Proposals: discuss in chat, await approval
- Documentation: only when user explicitly requests

# Tool Rules

**Use `gh` for GitHub.** Not curl.
- `gh repo view` — repo info
- `gh issue list/view` — issues
- `gh release list/view` — releases
- `gh api` — raw API calls

# Web Search — Use `web-access` Skill

**Never curl/search manually. Always use the web-access plugin scripts.**

```bash
# Plugin path (resolve dynamically)
WEB_ACCESS=$(ls -d ~/.codex/plugins/cache/home-plugins/web-access/*/scripts/ 2>/dev/null | tail -1)

# Web search
python3 ${WEB_ACCESS}web_search.py "query here"

# Fetch URL content
python3 ${WEB_ACCESS}fetch_content.py "https://example.com"

# Code search
python3 ${WEB_ACCESS}code_search.py "React useEffect cleanup"
```

### Rules
- **Default provider**: Exa (zero-config, no API key needed)
- **Never** use raw `curl` to scrape search engines
- **Never** call the LLM API to "search the web"
- **Never** try to read skills as MCP resources
- Search then fetch: use `web_search` for discovery, `fetch_content` for deep dives
