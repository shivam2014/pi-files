# Scope System

The scope system enforces file-level boundaries on subagent write/edit operations. It is the security backbone of the delegation architecture.

## Core Principle

**Tool-level enforcement, not prompt-level.** Scope boundaries are enforced by intercepting tool calls in `scope-guard.ts`, not by prompt instructions that LLMs can forget or ignore.

## Scope Manifest vs Resolved Scope

### ScopeManifest (Input View)

The authoring view — what the orchestrator provides when delegating:

```typescript
interface ScopeManifest {
  filesToModify: string[];    // Files allowed to edit
  filesToCreate: string[];    // Files allowed to create
  directories: string[];      // Directories in scope
  maxFiles?: number;          // Max files to touch
  requiresApprovalBeyondScope?: boolean;
  changeType?: 'single-file' | 'multi-file';
  maxLinesPerFile?: number;
  gateMode?: ScopeGateMode;   // 'strict' | 'relaxed'
  boundaries?: string;        // Human-readable constraints
}
```

Both `filesToModify` and `filesToCreate` support glob patterns (picomatch syntax: `*`, `**`, `?`, `[...]`, `{...}`). At least one entry must have a literal path segment (non-glob) to pass the ask-resolver specificity gate.

### ResolvedScope (Enforcement View)

The normalized, enforcement-ready view after `ScopeManager.normalize()`:

```typescript
interface ResolvedScope {
  filesToModify: string[];
  filesToCreate: string[];
  directories: string[];
  maxFiles: number;           // Default: 10
  requiresApprovalBeyondScope: boolean;  // Default: true
  changeType: 'single-file' | 'multi-file';  // Default: 'multi-file'
  maxLinesPerFile: number;    // Default: 400
  gateMode: ScopeGateMode;    // Derived from changeType
  boundaries?: string;
}
```

### Gate Mode Selection

| changeType | gateMode | Behavior |
|------------|----------|----------|
| `single-file` | `relaxed` | Fewer restrictions |
| `multi-file` | `strict` | Full enforcement |
| (explicit override) | (explicit) | Explicit wins |

## File Contract

**File**: `/scope-manager.ts`

Scope is persisted as `.pi/scope.json` with this schema:

```json
{
  "version": 1,
  "schema": "scope-file-contract-v1",
  "scope": { /* ResolvedScope fields */ }
}
```

### Parsing

`parseScopeFile(path)` validates:
- File exists
- JSON parses successfully
- Has `version`, `schema`, and `scope` fields
- Version is `1` and schema is `scope-file-contract-v1`

Returns `null` for any validation failure → **fail-closed**.

## ScopeManager

**File**: `/scope-manager.ts`

| Method | Description |
|--------|-------------|
| `normalize(manifest)` | Convert ScopeManifest → ResolvedScope with defaults |
| `writeScope(manifest)` | Normalize + write `.pi/scope.json` |
| `readScope()` | Read and parse scope file |
| `clearScope()` | Delete `.pi/scope.json` |
| `resolveScope(params, specialistDef, cwd)` | Pure function: resolve scope for a delegation |

### Path Normalization

`normalizeScopePath(p)` handles:
- Absolute paths → returned as-is
- `~` prefix → resolved from `$HOME`
- Relative paths → resolved from cwd

All paths in the scope file are stored as absolute paths after normalization.

## ScopeGuard

**File**: `/scope-guard.ts`

Thin enforcement adapter that reads `.pi/scope.json` directly — zero coupling to other orchestrator modules.

### Path Checking

`isPathAllowed(filePath)` checks in order:
1. **Exact path match** against `filesToModify` and `filesToCreate`
2. **Glob pattern match** using picomatch compilation
3. **Directory prefix match** against `directories` list

Returns `{ allowed: boolean, reason?: string }`.

### Blocking Behavior

When a write/edit targets a path outside scope:
- Returns `{ block: true, reason: "Scope violation: <path> is outside the allowed scope" }`
- The subagent **continues running** (does NOT terminate)
- The blocked operation simply does not execute
- `scopeViolations` counter incremented in delegation metrics

### Expansion Requests

`requestExpansion(filePath)` emits a `ScopeExpansionRequest`:
```typescript
interface ScopeExpansionRequest {
  path: string;
  reason: string;
  scopeManifest: ResolvedScope | null;
  suggestedExpansion?: { directories?: string[]; filesToModify?: string[] };
}
```

The orchestrator (not the subagent) decides whether to expand scope.

## Scope Policy Defaults

**File**: `/scope-policy.ts`

### Writer Default Scope
- `directories`: [cwd]
- `maxFiles`: 20
- `changeType`: multi-file
- `gateMode`: strict
- Boundaries: `*.md` files in cwd, `docs/` recursively, common doc filenames

### Read-Only Default Scope
- Empty `filesToModify`/`filesToCreate`/`directories`
- `maxFiles`: 10
- `changeType`: multi-file
- `gateMode`: relaxed
- `requiresApprovalBeyondScope`: false

### Coder
**No default scope** — coder always requires an explicit scope from the orchestrator. If none provided, delegation fails with an error.

## Fail-Closed Design

Missing, malformed, or stale scope files → **ALL writes blocked**. No fallback behavior. No user prompting.

Scenarios that trigger fail-closed:
- `.pi/scope.json` doesn't exist
- File isn't valid JSON
- Missing `version`, `schema`, or `scope` fields
- Wrong version number or schema name
- Parse error

## Bash Write-Command Blocking

Read-only specialists with bash access (currently: **reviewer**) have tool-level enforcement against write-modifying bash commands. This uses the pi SDK `tool_call` event pattern for interception.

### Overview

`createBashInterceptor()` in `bash-interceptor.ts` returns an event handler that intercepts `tool_call` events for the `bash` tool. Two independent checks run:

1. **Dangerous command blocking** — Always active. Blocks destructive system commands regardless of specialist mode.
2. **Write command blocking** — Active only when `readOnly: true`. Blocks file-modifying and git-write commands.

The handler returns `{ block: true, reason }` to halt execution, or `undefined` to allow the command through.

```typescript
const interceptor = createBashInterceptor({ readOnly: true, blockDangerous: true });
// Register as pi SDK tool_call handler
```

### Blocked Commands Table

#### Always blocked (dangerous)

| Command | Reason |
|---------|--------|
| `rm -rf /`, `rm -rf /*` | Root filesystem destruction |
| `git push --force`, `git push -f` | Force push to remote |
| `git reset --hard` | Discards all local changes |
| `sudo rm` | Privileged deletion |
| `dd if=` | Raw disk write |
| `mkfs` | Filesystem formatting |
| `> /dev/sda` | Direct disk write |

#### Blocked in read-only mode

| Command type | Example | Blocked? |
|-------------|---------|----------|
| File deletion | `rm file.txt` | ✅ Yes |
| Recursive delete | `rm -rf dir/` | ✅ Yes |
| File move/copy | `mv a b`, `cp a b` | ✅ Yes |
| File permissions | `chmod 777 file` | ✅ Yes |
| Output redirect | `echo x > file` | ✅ Yes |
| In-place edit | `sed -i 's/x/y/' file` | ✅ Yes |
| Package install | `npm install`, `pip install` | ✅ Yes |
| Git write | `git commit`, `git push` | ✅ Yes |
| Git read | `git log`, `git diff` | ❌ Allowed |
| Diagnostic | `curl localhost:19530` | ❌ Allowed |
| Port check | `lsof -i :19530` | ❌ Allowed |

### Specialist Permissions

| Specialist | `readOnly` | `blockDangerous` | Behavior |
|------------|------------|------------------|----------|
| **reviewer** | `true` | `true` | Read-only + dangerous command blocking |
| **coder** | `false` | `true` | Read-write + dangerous command blocking |
| **writer** | `false` | `true` | Read-write + dangerous command blocking |
| Other specialists | `false` | `true` | Read-write + dangerous command blocking |

**Override bypass:** The `override: true` flag on bash calls bypasses bash-to-SDK command redirection but does **NOT** bypass `readOnly` or `blockDangerous` blocking. This is intentional — these are security boundaries, not convenience features.

### Adding New Commands

#### Adding to dangerous commands list

Edit the `DANGEROUS_COMMANDS` array in `bash-interceptor.ts`:

```typescript
const DANGEROUS_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  // ... existing entries ...
  "your-new-pattern",  // Added: description of why
];
```

Matching is substring-based (`command.includes(pattern)`), so patterns like `rm -rf /` will match `rm -rf / --no-preserve-root`.

#### Adding to write-command classifier

Edit `bash-classifier.ts` — the `isWriteCommand()` function. This classifier checks command structure:

- First command extraction via `firstCommandName()`
- Recursive `rm` detection via `isBlockedRmRecursive()`
- File write indicators (`>`, `>>`, `open()`, `fs.writeFile()`)
- Mutating editor flags (`sed -i`, `perl -i`)

#### Adding new specialist permissions

1. Add the specialist name to `isReadOnlySpecialist()` in `index.ts`
2. Set `readOnly: true` in the `BashInterceptorOptions` when creating the interceptor
3. Update the Specialist Permissions table above

### Architecture Alignment

This implements the core principle from this document: *"Tool-level enforcement, not prompt-level."* The prompt instruction ("Do NOT use bash to modify files") is defense-in-depth; the event handler is the actual enforcement.

### Source Files

| File | Role |
|------|------|
| `bash-interceptor.ts` | `createBashInterceptor()` — SDK tool_call event handler, dangerous command list |
| `bash-classifier.ts` | `isWriteCommand()` — pure function classifying write commands |
| `index.ts` | `isReadOnlySpecialist()` — determines readOnly from specialist name |
| `subagent-runner.ts` | Sets `PI_SPECIALIST_NAME` env var for specialist identification |

## Concurrency Caveat

Scope is stored in a single `.pi/scope.json` file per cwd. When multiple delegations run concurrently, the last writer wins. This can cause scope conflicts — a known limitation.

## Key Source Files

| File | Role |
|------|------|
| `/scope-manager.ts` | Concept owner, read/write/normalize scope |
| `/scope-guard.ts` | Path enforcement, glob matching, expansion requests |
| `/scope-policy.ts` | Per-specialist default scope policies |
| `/types.ts` | `ScopeManifest`, `ResolvedScope` type definitions |

## Related ADRs

- `/docs/adr/0001-scope-enforcement-json-seam.md` — Why scope uses JSON file as the contract
- `/docs/adr/0002-scope-file-fail-closed.md` — Why missing scope blocks all writes
- `/docs/adr/0006-scope-glob-patterns.md` — Glob pattern support in scope paths
