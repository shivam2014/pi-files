# token-saver

Cuts token cost on raw tool output, cache-safe.

## What it solves

Every tool result lands in the model's context and is billed on every later turn. token-saver overrides the built-in tools so output is compressed **before** it enters context, keeping the cached prefix clean.

## Commands

- `/caveman [lite|full|ultra|off]` — set the terse reply style, or turn compression off. With no argument, shows the current state and budgets.
- `/tokenstats` — show read-dedup stats.
- `/rtk` — toggle RTK rewrite (`on`/`off`/`status`).

## The 5 compression layers

1. **Terse mode** — instructs the model to reply without filler (lite / full / ultra).
2. **Read dedup** — fingerprints files and returns a stub on re-read.
3. **ANSI strip** — removes color codes from tool output.
4. **Per-tool budgets** — line caps per tool (`bash` 80, `read` 300, `grep` 120, `find` 120, `ls` 80).
5. **Blank collapse** — removes redundant blank lines.

## Notes

- Cache-safe: compression happens before output enters context, so the cached prefix stays clean.
- When the orchestrator is active, terse style is handled by the orchestrator's specialist prompts instead.

## Install

```bash
ln -s "$(pwd)/token-saver.ts" ~/.pi/agent/extensions/token-saver.ts
```
