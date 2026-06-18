# pi-files

Custom extensions, skills, and configuration for my [Pi coding agent](https://github.com/earendil-works/pi).

## Structure

```
pi-files/
├── extensions/              # Pi extensions (see below)
├── nyro-sync/               # Nyro model sync plugin
├── .vibe-orch/              # Vibe orchestration config
├── AGENTS.md                # Agent configuration
├── tui-smoke.sh             # TUI smoke test
└── README.md                # This file
```

### extensions/

```
extensions/
├── orchestrator/            # Dev copy with full 2-month commit history
├── token-saver.ts
├── lint-guard.ts
├── scope-guard.ts
├── vision-router.ts
├── herdr-agent-state.ts
├── local-latex/
├── tsconfig.json
└── .gitignore
```

## Extensions

- **orchestrator/** — Subagent delegation with plan panel, scope enforcement, activity feed, and fusion TUI. Dev copy with full commit history preserved.
- **scope-guard.ts** — Tool-level write scope enforcement (reads .pi/scope.json)
- **lint-guard.ts** — Auto-lint after edits, blocks sed/awk in bash
- **token-saver.ts** — Token compression, caveman mode enforcement
- **vision-router.ts** — Vision model routing
- **herdr-agent-state.ts** — Agent state management
- **local-latex/** — Local LaTeX compilation support

## Setup

Clone to any machine and symlink into `~/.pi/`:
```bash
ln -s ~/pi-files/extensions ~/.pi/agent/extensions
```
