---
name: agents-md-writer
description: "Write AGENTS.md files for codebases/projects. Covers what sections to include, what to skip, format rules, and caveman-style variant. Use when user asks: create AGENTS.md, write agent instructions, make a project guide for AI, how to structure AGENTS.md, what to put in AGENTS.md, AGENTS.md template, or similar. Also use when asked to create CLAUDE.md, .cursorrules, or .github/copilot-instructions.md."
---

# AGENTS.md Writer

Write AGENTS.md (and similar CLAUDE.md / .cursorrules) for projects. This guide = what goes in, what stays out, how to format.

---

## What AGENTS.md Is

Plain markdown file in project root. Tells coding agents (pi, Cursor, Claude Code, Copilot, Codex) how to work in this codebase. One page of high-signal instructions. Agent reads it at session start.

**Not a README.** README = dev humans. AGENTS.md = AI agent. Different audience, different format.

**30+ tools read it.** Format is intentionally unopinionated.

---

## What Goes In

### 1. Project Overview (1-2 lines)
Tech stack with versions. What the project does. One sentence.

```
TypeScript + React 18 + Vite + Tailwind. Chrome extension (MV3) for auto-filling job forms.
```

### 2. Quick Commands (THE most used section)
Copy-pasteable CLI commands. One per line. Comment after.

```bash
npm run dev                  # start dev server
npm test -- --watch         # run tests in watch mode
npm run build               # production build
node scripts/deploy.mjs     # deploy to staging
```

**Rules:** Exact commands. Not "run tests" but `pnpm vitest run`. Include flags. Include working directory if not root.

### 3. Architecture / Key Files
Annotated tree or table. What each file does. Not full file listing — only files agent touches.

```
src/
├── app.tsx          # Root component, router setup
├── components/      # UI components (Button, Card, Modal)
├── lib/api.ts       # API client, all external calls go here
└── utils/format.ts  # Date/number formatting helpers
```

or table:

| File | Purpose |
|------|---------|
| `src/lib/api.ts` | All API calls. Add new endpoints here. |
| `src/stores/auth.ts` | Auth state. Tokens, login/logout. |

### 4. Code Style & Conventions
Specific, enforceable rules. Not "write clean code."

Good:
- 2-space indent, no semicolons
- Named exports only (no default exports)
- React: function components, hooks for state
- CSS: Tailwind utility classes, no custom CSS
- Error handling: return `{ok, error}` tuples, no throw

Bad:
- Write clean, maintainable code
- Use best practices
- Follow the style guide (link breaks agent attention budget)

### 5. Testing Instructions
Exact commands. File patterns. What to test.

```
Tests: vitest in __tests__/ next to source.
Run: pnpm vitest run --reporter=verbose
Pattern: src/**/*.test.ts
Requirement: test error cases, not just happy path
```

### 6. Git Workflow / Commit Rules
Only if project has specific conventions.

```
Branch: feature/description
Commit: conventional commits (feat:, fix:, chore:, docs:)
PR: squash merge, link issue
```

### 7. Boundaries (Critical)
What agent should NEVER do. Prevents damage.

```
Never:
- Modify package.json without asking
- Edit generated files in dist/ or build/
- Add new dependencies without approval
- Change API response formats
- Delete files
```

### 8. Key Learnings / Pitfalls (Optional but gold)
Tricky things about this project. Saves agent hours.

```
Key Learnings:
- Extension reload: MUST reload page after reloading extension. Old content script stays otherwise.
- Oracle combobox: Click toggle button (#{id}-toggle-button), not the input. Value in button text, not input.value.
- Synthetic click() doesn't work on Oracle React buttons. Use PointerEvent + mousedown + mouseup + click.
```

### 9. Session Workflow (Optional)
Step sequence for common tasks. Helps agent stay on track.

```
1. Launch: npm run dev
2. Inspect: node scripts/test/inspect.mjs
3. Test fields one by one
4. Run Fill All at end
5. Commit after each fix
```

---

## What NOT to Put In

### ❌ README Duplication
Don't copy README content. Princeton study: -2% success, +23% cost when duplicating. AGENTS.md = what agent needs to work, not what users need to use.

### ❌ Vague Prompts
"You are a helpful coding assistant" — wastes context. Be specific: "You are a test engineer who writes tests for React components."

### ❌ Full Style Guides
Don't paste entire ESLint/Prettier config or style guide. Agent already has implicit knowledge. Just note deviations.

### ❌ Auto-Generated Content
Don't auto-generate AGENTS.md from README + file tree. Results in low-signal noise. Write manually.

### ❌ Verbose Prose
One paragraph max per section. Fragments OK. Agent skims, not reads.

### ❌ Links to External Docs
Agent can't browse well mid-task. Inline what matters. Use `[name](path)` for on-demand docs in same repo.

### ❌ Long Lists (>10 items)
Agent attention budget limited. Top 5-7 items per section max.

### ❌ File Permissions / Ownership
Agent doesn't care who owns what. Skip.

### ❌ Installation Instructions
Unless unusual. `npm install` is assumed knowledge.

### ❌ Outdated/Superseded Information
Every stale line erodes trust. Keep minimal and update when code changes.

---

## Format Rules

- **Plain Markdown** only. No YAML frontmatter in the AGENTS.md itself (that's only for pi skills).
- **20-30 lines ideal.** Max 32 KiB (Codex truncates beyond).
- **H1** = project name. **H2** = sections. **H3** = subsections.
- **Tables** for file→purpose mappings.
- **Code blocks** for commands and examples.
- **Short lines.** One idea per line. Fragments OK.
- **Bold** for rules and warnings. `Code` for filenames, commands, types.
- **Shorter beats longer.** Every line competes for attention budget.

---

## Location & Naming

| File | Tool That Reads It |
|------|-------------------|
| `AGENTS.md` (root) | pi, OpenAI Codex, Cline, many others |
| `CLAUDE.md` (root) | Claude Code |
| `.cursor/rules/` (dir) | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `GEMINI.md` (root) | Gemini CLI |

**Rules:**
- Root AGENTS.md applies project-wide
- Nested AGENTS.md overrides for subdirectory (Codex uses 88 AGENTS.md files)
- Nearest-file-in-directory-tree precedence
- Can have multiple files for different tools (AGENTS.md + CLAUDE.md + .cursorrules)
- pi treats AGENTS.md as a skill — loaded automatically at session start

---

## Caveman-Style Variant

For projects that want ultra-terse agent instructions. Adapt from pi's own AGENTS.md.

**Changes from normal AGENTS.md:**
- Drop articles (a/an/the)
- Drop filler (just/really/basically/actually/simply)
- Drop pleasantries (sure/certainly/happy to)
- Fragments OK. "Not full sentences."
- Short synonyms: big→large, fix→repair, implement→build
- One idea per line. No paragraphs.
- Use bold for rules. Use `code` for exact commands.
- Pattern: [thing] [action] [reason].

**Caveman section examples:**

```
## Commands
npm run dev          # start
npm test -- --watch  # test loop
npm run build        # ship

## Style
- 2-space indent. No semi.
- Named exports. No default.
- Tailwind classes. No custom CSS.

## Never
- Edit package.json.
- Touch dist/ files.
- Add deps w/o ask.

## Pitfalls
- Extension reload: MUST page.reload() too. Else old code runs.
- Oracle combobox: Click toggle button, not input.
```

**Caveman meta-rule:** Think short. No mental filler. If you can say it in 3 words, do.

---

## Templates

### Minimal (20 lines)

```
# Project Name

Tech: React 18 + TypeScript + Vite + Tailwind.

## Commands
npm run dev            # dev server
npm test               # run tests
npm run build          # production build

## Structure
src/
├── app.tsx           # Root
├── components/       # Reusable UI
├── lib/api.ts        # All API calls
└── types/            # TypeScript types

## Style
- 2-space indent, no semicolons
- Named exports only
- React function components + hooks

## Boundaries
- Never modify package.json without asking
- Don't edit generated files in dist/
```

### Standard (40 lines)

```
# Project Name

FastAPI + PostgreSQL + Redis. Async web service for X.

---

## Quick Commands
```bash
poetry run uvicorn app.main:app --reload  # dev
poetry run pytest -v                       # test
poetry run ruff check .                    # lint
```

---

## Key Files
| File | Purpose |
|------|---------|
| `app/main.py` | App entry, routes |
| `app/api/v1/` | API endpoints |
| `app/models/` | SQLAlchemy models |
| `app/services/` | Business logic |

---

## Testing
- pytest with async support. Tests in `tests/`.
- Run: `poetry run pytest tests/api/` for API tests
- Mock external services with `pytest-httpx`

---

## Code Style
- 4-space indent, line length 100
- Type hints everywhere. mypy strict mode.
- Error handling: return `Result[T, Error]` types
- Async def for I/O, sync for CPU

---

## Git
- Branch from main: `feat/short-description`
- Commits: conventional (feat/fix/chore)
- Merge: squash + merge

---

## Never
- Direct DB writes outside service layer
- Expose secrets in env vars without prefix
- Add deps without discussion
```

### Caveman (25 lines)

```
# Project Name

Stack: FastAPI + PostgreSQL + Redis. Async web service.

## Commands
poetry run uvicorn app.main:app --reload  # dev
poetry run pytest -v                       # test
poetry run ruff check .                    # lint

## Files
| File | Why |
|------|-----|
| app/main.py | Entry + routes |
| app/api/v1/ | API endpoints |
| app/models/ | DB models |
| app/services/ | Business logic |

## Rules
- 4-space indent. Type hints everywhere.
- Result[T, Error] returns. No exceptions.
- Async for I/O. Sync for CPU.

## Boundaries
- No direct DB writes outside services.
- No deps w/o ask.
- No secrets in code.

## Pitfalls
- Mock external services with pytest-httpx.
- Model changes need alembic revision.
```

---

## Writing Process

1. **Scout first**: Read project README, package.json, file tree, test config, lint config. Understand stack.
2. **Extract commands**: From package.json scripts, Makefile, CI config. Get exact flags.
3. **Map architecture**: Key files list. What each does. Which ones agent edits.
4. **Find rules**: From CONTRIBUTING.md, PR templates, code review comments, style guides.
5. **Document pitfalls**: From git history, issue tracker, developer chats. What breaks often.
6. **Write minimal first**: 20 lines. Then expand if needed. Never start verbose.
7. **Trim**: Read every line. If agent can infer it, delete it. If it's obvious, delete it.
8. **Review**: Does this help agent work faster? If no, purge.

---

## Anti-Patterns Checklist

- [ ] No README duplication?
- [ ] No vague prompts?
- [ ] No full style guides?
- [ ] Commands have exact flags?
- [ ] Each section <7 items?
- [ ] Total <30 lines (unless unavoidable)?
- [ ] No external links that break context?
- [ ] Boundaries section present?
- [ ] No auto-generated content?
- [ ] Caveman-style if project tone supports it?

---

After writing, verify:
1. `wc -l ~/.pi/agent/skills/agents-md-writer/SKILL.md`
2. `head -5 ~/.pi/agent/skills/agents-md-writer/SKILL.md`
3. `grep "name:" ~/.pi/agent/skills/agents-md-writer/SKILL.md`
4. `grep "description:" ~/.pi/agent/skills/agents-md-writer/SKILL.md | head -c 80`
