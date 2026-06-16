# LINT-SPEC.md — Project-Agnostic Lint Guard

> Defines the deterministic, project-agnostic lint checking system
> that runs after every edit/write and emits visible tool call results.

---

## 1. Core Principles

### 1.1 Project-Agnostic by Default

The lint guard MUST work in ANY directory without configuration files.
It detects the programming language from file extension and selects
the appropriate tool automatically.

### 1.2 Visible Tool Call Results

Lint results MUST be emitted as a visible `lint` tool call in the
conversation, so the LLM sees errors and can self-correct. Results
MUST NOT be hidden in `steer` messages.

### 1.3 Deterministic, Cache-Safe

Lint results MUST be sent as a separate message via `pi.sendMessage()`,
NOT by modifying the original tool_result content. This preserves
the provider's prefix cache for the edit/write tool call.

### 1.4 Fast Feedback

The lint check MUST complete in under 5 seconds for single-file edits.
Tools exceeding this threshold (e.g., tsc without incremental mode)
should be avoided for per-edit checks.

---

## 2. Per-Language Tool Selection

The lint guard selects the tool based on the edited file's extension.
It walks up the directory tree to find project config files.
If found, it uses the project-aware tool. If not found, it uses
a standalone/fallback tool that requires no configuration.

### 2.1 File Extension → Tool Mapping

| Extension | Standalone (no project config) | Project-Aware (config found) |
|-----------|-------------------------------|------------------------------|
| .ts, .tsx | `tsc --noEmit --strict <file>` (~1s) | `tsc --noEmit --incremental` with tsconfig.json (~2s cached) |
| .js, .jsx | `node --check <file>` (~5ms) | `tsc --allowJs --checkJs --noEmit` with tsconfig.json (~2s) |
| .mjs      | `node --check <file>` (~5ms) | `tsc --allowJs --checkJs --noEmit` with tsconfig.json (~2s) |
| .py       | `ruff check <file>` (~20ms) | `ruff check` with pyproject.toml (~0.3s) |
| .go       | Falls through — Go always has go.mod | `go vet ./...` (~1s) |
| .rs       | Falls through — Rust always has Cargo.toml | `cargo check` (~2s cached) |
| .java     | `javac -Xlint:all <file>` (~20ms) | `javac -Xlint:all` with project classpath (~1s) |
| .rb       | `ruby -c <file>` (~3ms) | `rubocop --lint` with .rubocop.yml (~0.5s) |
| .kt, .kts | Fallback — no standalone tool | `gradle compileKotlin` with build.gradle.kts (~5s) |
| .swift    | Fallback — no standalone tool | `swift build` with Package.swift (~5s) |

### 2.2 Config Detection (Walk-Up)

When an edit/write tool call fires on a file, the lint guard walks up
the directory tree from the file's location, checking each directory
for known config files:

| Config File | Language | Tool Selected |
|-------------|----------|---------------|
| tsconfig.json | TypeScript | tsc |
| biome.json / biome.jsonc | TypeScript/JavaScript | biome |
| eslint.config.js | JavaScript | eslint |
| pyproject.toml | Python | ruff, mypy |
| ruff.toml | Python | ruff |
| go.mod | Go | go vet |
| Cargo.toml | Rust | cargo check |
| pom.xml | Java | mvn compile |
| build.gradle / build.gradle.kts | Java/Kotlin | gradle |
| .rubocop.yml | Ruby | rubocop |

Walk-up stops at the FIRST config file found. If no config file is
found in any parent directory up to filesystem root, the standalone
fallback is used.

---

## 3. Detection Algorithm

```
function detectTool(filePath: string): LintTool {
    ext = filePath.extension.toLowerCase()
    
    // Language-specific standalone tools (always available)
    switch ext:
        .ts, .tsx → return { tool: "tsc", standalone: true, args: ["--noEmit", "--strict", filePath] }
        .js, .jsx → return { tool: "node", standalone: true, args: ["--check", filePath] }
        .py       → return { tool: "ruff", standalone: true, args: ["check", filePath] }
        .rb       → return { tool: "ruby", standalone: true, args: ["-c", filePath] }
        .java     → return { tool: "javac", standalone: true, args: ["-Xlint:all", filePath] }
    
    // Project-aware tools (walk up for config)
    config = walkUpForConfig(filePath, CONFIG_FILES)
    
    if config:
        switch config.type:
            "tsconfig.json"   → return { tool: "tsc", args: ["--noEmit", "--incremental"], cwd: config.dir }
            "go.mod"          → return { tool: "go", args: ["vet", "./..."], cwd: config.dir }
            "Cargo.toml"      → return { tool: "cargo", args: ["check"], cwd: config.dir }
            ...
    
    // No config found, no standalone tool = unsupported
    return null
}
```

### Walk-Up Implementation

```typescript
function walkUpForConfig(filePath: string, configNames: string[]): { name: string; dir: string } | null {
    let dir = path.dirname(path.resolve(filePath));
    const root = path.parse(dir).root;
    
    while (true) {
        for (const name of configNames) {
            if (existsSync(path.join(dir, name))) {
                return { name, dir };
            }
        }
        if (dir === root) break;
        dir = path.dirname(dir);
    }
    return null;
}
```

---

## 4. Emission: Visible Tool Call

### 4.1 Message Format

After lint completes, emit a message that looks like a tool result:

```
[tool: lint]  ✓ [toolName] file.ts: OK
[tool: lint]  ✗ [toolName] file.ts: <error message>
[tool: lint]  ⚠ [toolName] file.ts: <warning message>
```

### 4.2 Implementation

```typescript
function emitLintResult(
    pi: ExtensionAPI,
    result: { tool: string; success: boolean; errors: string; file: string }
) {
    const icon = result.success ? "✓" : "✗";
    const content = result.success
        ? `${icon} [${result.tool}] ${result.file}: OK`
        : `${icon} [${result.tool}] ${result.file}:\n${result.errors}`;
    
    pi.sendMessage({
        role: "tool",
        toolCallId: `lint-auto-${Date.now()}`,
        toolName: "lint",
        content,
        details: {
            tool: result.tool,
            success: result.success,
            filesChecked: [result.file],
        },
    });
}
```

### 4.3 LLM Self-Correction Flow

The visible lint result enables the LLM to self-correct:

```
[tool: edit]        ✓ patch applied to auth.ts
[tool: lint]        ✗ [tsc] auth.ts: Type 'number' not assignable to type 'string' at line 15
[assistant]         → "Let me fix that type error..."
[tool: edit]        ✓ patch applied to auth.ts (fixed)
[tool: lint]        ✓ [tsc] auth.ts: OK
```

The LLM sees the lint failure, knows the file and line, and fixes it
in the next edit turn. The lint result acts as a guard that catches
errors before they compound.

---

## 5. Cache Safety

### 5.1 Never Modify tool_result

The lint guard operates on the `tool_result` event to READ the file path
and trigger the lint check. It must NEVER modify `event.content` or
`event.details`. This preserves the exact tool output for prefix caching.

### 5.2 pi.sendMessage() Pattern

All lint results are sent via `pi.sendMessage()`. This creates a new
message in the conversation without altering previous messages.
The cache prefix remains intact.

### 5.3 Deterministic Output

The lint check MUST produce the same output for the same file content.
The lint guard must NOT modify the file or its timestamps during checking.

---

## 6. Error Handling

### 6.1 Tool Not Found

If the lint tool binary is not installed, emit a warning but do not
block execution. The LLM should continue without lint feedback.

```
[tool: lint]  ⚠ [esbuild] auth.ts: esbuild not installed. Install with: npm install -g esbuild
```

### 6.2 Lint Timeout

If lint takes longer than 10 seconds, kill the process and emit
a timeout warning. Do not block the LLM's next turn.

### 6.3 Parse Error in Lint Output

If the lint tool produces unparseable output, show the raw output
as-is. The LLM can interpret error messages from any tool.

---

## 7. Supported Languages & Tools Summary

| Language | Extensions | Standalone Tool | Project Tool | Speed (standalone) |
|----------|-----------|----------------|--------------|-------------------|
| TypeScript | .ts, .tsx | `tsc --noEmit --strict` | `tsc --incremental` | ~1s |
| JavaScript | .js, .jsx, .mjs | `node --check` | `tsc --allowJs --checkJs` | ~5ms |
| Python | .py | `ruff check` | `ruff check` (config) | ~20ms |
| Go | .go | — | `go vet ./...` | ~1s |
| Rust | .rs | — | `cargo check` | ~2s cached |
| Java | .java | `javac -Xlint:all` | `javac` + classpath | ~20ms |
| Ruby | .rb | `ruby -c` | `rubocop --lint` | ~3ms |
