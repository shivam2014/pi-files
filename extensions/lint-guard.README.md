# lint-guard

Every edit is auto-linted. No config.

## What it solves

A model can write code that compiles in its head but not on disk. lint-guard hooks into `tool_result` after every `edit`/`write` and runs the project's own linter, so a broken edit is caught in the same turn.

## Two modes

- **Auto-lint** — runs after each `edit`/`write`.
- **Manual** — the `lint` tool, for explicit calls.

## Coverage

14 linters across 7 languages, auto-detected from project config files:

| Language | Linters |
|----------|---------|
| TypeScript | `tsc` |
| JavaScript / Node | `eslint`, `node` |
| Python | `ruff`, `py_compile` |
| Go | `go vet`, `gofmt` |
| Rust | `cargo`, `rustc` |
| Java | `mvn`, `gradle`, `javac` |
| Ruby | `rubocop`, `ruby` |

Detection looks for `tsconfig.json`, `biome.json`, `.eslintrc*`, `eslint.config.*`, `ruff.toml`, `build.gradle*`, `.rubocop.yml`, and similar files.

## Notes

- No configuration: it picks the linter from what the project already has.
- Each run times out after 10s and caps error output at 2000 chars.
- Source: `lint-guard.ts` (SDK adapter) + `lint-guard/lib/lint-guard-core.ts` (pure lint logic, no SDK imports).
