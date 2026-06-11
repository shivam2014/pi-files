# pi-files

Custom extensions, skills, and configuration for my [Pi coding agent](https://github.com/earendil-works/pi).

## Structure

```
extensions/       # Pi extensions (orchestrator, lint-guard, scope-guard, token-saver)
skills/           # Custom skills (writing-x-posts)
AGENTS.md         # Agent configuration
```

## Extensions

- **orchestrator/** — Subagent delegation with plan panel, scope enforcement, and activity feed
- **scope-guard.ts** — Tool-level write scope enforcement (reads .pi/scope.json)
- **lint-guard.ts** — Auto-lint after edits, blocks sed/awk in bash
- **token-saver.ts** — Token compression, caveman mode enforcement

## Setup

Clone to any machine and symlink into `~/.pi/`:
```bash
ln -s ~/pi-files/extensions ~/.pi/agent/extensions
```
