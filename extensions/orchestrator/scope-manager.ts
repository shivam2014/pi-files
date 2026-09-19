import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync, statSync, renameSync } from 'fs';
import { join, dirname, basename, isAbsolute, resolve } from 'path';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getDefaultWriterScope, getReadOnlyDefaultScope } from './scope-policy.ts';
import { debugLog } from './debug.ts';

/**
 * Normalize a scope path to an absolute path.
 * - Absolute paths are returned as-is.
 * - Paths starting with ~ are resolved from the home directory.
 * - Relative paths are resolved relative to cwd.
 */
export function normalizeScopePath(p: string): string {
  if (isAbsolute(p)) return p;
  if (p.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return resolve(home, p.slice(1));
  }
  return resolve(p);
}

/**
 * Atomically write JSON to `filePath`: write to a temp file in the SAME
 * directory, then rename over the target. POSIX rename is atomic, so a
 * concurrent reader never observes a partially-written (torn) file — it sees
 * either the previous file or the complete new one.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

/** ScopeGateMode type */
export type ScopeGateMode = 'strict' | 'relaxed';

/**
 * Generate documentation string for ResolvedScope fields (SSOT for scope shape docs).
 * Used by prompt-builder to show ScopeObject shape to orchestrator agents.
 */
export function generateScopeDocumentation(): string {
    return `**ScopeObject shape:**
\`\`\`
{
    filesToModify: ["src/auth.ts"],
    filesToCreate: ["tests/**/*.test.ts"],
    directories: ["src"],
    maxFiles: 10,
    maxLinesPerFile: 400,
    changeType: "single-file" | "multi-file",
    requiresApprovalBeyondScope: true,
    gateMode: "strict" | "relaxed",
    boundaries?: "do not modify src/legacy"
}
\`\`\`
Glob patterns (*, **, ?) supported. Bare wildcard '/*' rejected — must include a literal path segment.`;
}

export interface ScopeFileContract {
  version: number;
  schema: string;
  scope: ResolvedScope;
  /** Optional marker: which delegation wrote this shared scope file. Used by
   * clearScope() so a finishing delegation never unlinks a sibling's file. */
  delegationId?: string;
}

/** Input/authoring view of a Scope, before normalization.
 * filesToModify and filesToCreate support both exact paths and
 * glob patterns (picomatch syntax: *, **, ?, [...], {...}).
 * Glob patterns are compiled at enforcement time by ScopeGuard.
 * At least one entry must have a literal segment (non-glob path
 * component) to pass the ask-resolver specificity gate. */
export interface ScopeManifest {
  filesToModify: string[];
  filesToCreate: string[];
  directories: string[];
  maxFiles?: number;
  requiresApprovalBeyondScope?: boolean;
  changeType?: 'single-file' | 'multi-file';
  maxLinesPerFile?: number;
  gateMode?: ScopeGateMode;
  boundaries?: string;
}

/** Enforcement view produced by ScopeManager.normalize().
 * filesToModify and filesToCreate support both exact paths and
 * glob patterns (picomatch syntax). The guard checks in order:
 * 1) exact path match, 2) glob pattern match, 3) directory prefix. */
export interface ResolvedScope {
  filesToModify: string[];
  filesToCreate: string[];
  directories: string[];
  maxFiles: number;
  requiresApprovalBeyondScope: boolean;
  changeType: 'single-file' | 'multi-file';
  maxLinesPerFile: number;
  gateMode: ScopeGateMode;
  boundaries?: string;
}

// Backward-compat alias
export type Scope = ResolvedScope;

/**
 * Pure function: parse a `.pi/scope.json` file and return the ResolvedScope.
 * Returns null if missing, malformed, or wrong version/schema (fail-closed).
 * Shared by ScopeManager.readScope() and ScopeGuard._readScope().
 */
export function parseScopeFile(scopePath: string): ResolvedScope | null {
  try {
    if (!existsSync(scopePath)) return null;
    const raw = JSON.parse(readFileSync(scopePath, 'utf-8'));
    if (!raw.version || !raw.schema || !raw.scope) return null;
    if (raw.version !== 1 || raw.schema !== 'scope-file-contract-v1') return null;
    return raw.scope as ResolvedScope;
  } catch {
    return null;
  }
}

export class ScopeManager {
  constructor(private cwd: string) {}

  normalize(manifest: ScopeManifest): ResolvedScope {
    return {
      ...manifest,
      maxFiles: manifest.maxFiles ?? 10,
      requiresApprovalBeyondScope: manifest.requiresApprovalBeyondScope ?? true,
      maxLinesPerFile: manifest.maxLinesPerFile ?? 400,
      changeType: manifest.changeType ?? 'multi-file',
      gateMode: this.gateMode(manifest.changeType ?? 'multi-file', manifest.gateMode),
    };
  }

  gateMode(changeType: 'single-file' | 'multi-file', explicit?: ScopeGateMode): ScopeGateMode {
    if (explicit) return explicit;
    return changeType === 'single-file' ? 'relaxed' : 'strict';
  }

  writeScope(manifest: ScopeManifest, delegationId?: string): void {
    const scope = this.normalize(manifest);
    // Normalize file paths to absolute
    scope.filesToModify = scope.filesToModify.map(normalizeScopePath);
    scope.filesToCreate = scope.filesToCreate.map(normalizeScopePath);
    scope.directories = scope.directories.map(d => normalizeScopePath(d));
    const contract: ScopeFileContract = {
      version: 1,
      schema: 'scope-file-contract-v1',
      scope,
      // Marker consumed by clearScope() (see ScopeFileContract.delegationId).
      ...(delegationId ? { delegationId } : {}),
    };
    // Atomic: a concurrent subagent's guard must never read a torn file.
    writeJsonAtomic(join(this.cwd, '.pi', 'scope.json'), contract);
  }

  readScope(): ResolvedScope | null {
    const path = join(this.cwd, '.pi', 'scope.json');
    return parseScopeFile(path);
  }

  clearScope(expectedDelegationId?: string): void {
    const path = join(this.cwd, '.pi', 'scope.json');
    try {
      if (!existsSync(path)) return;
      // Concurrency guard: only remove the shared scope file if it still belongs
      // to the caller. If a sibling delegation has overwritten it meanwhile,
      // deleting it would invalidate that sibling's legitimate in-scope writes
      // (a false-positive over-block). See delegationId marker in writeScope().
      if (expectedDelegationId) {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw?.delegationId !== expectedDelegationId) return;
      }
      unlinkSync(path);
    } catch (err) {
      // FIX 4: never swallow silently. A failed unlink leaves a stale scope file
      // that could keep a subagent believing it still has scope it should not have.
      debugLog('scope-manager: clearScope failed to unlink scope file', path, err);
    }
  }

  /** Normalize an explicit scope by filling in defaults for missing fields */
  private static normalizeExplicitScope(scope: Scope): Scope {
    return {
      ...scope,
      filesToModify: scope.filesToModify ?? [],
      filesToCreate: scope.filesToCreate ?? [],
      directories: scope.directories ?? [],
      maxFiles: scope.maxFiles ?? 10,
      requiresApprovalBeyondScope: scope.requiresApprovalBeyondScope ?? true,
      changeType: scope.changeType ?? "multi-file",
      maxLinesPerFile: scope.maxLinesPerFile ?? 400,
      gateMode: scope.gateMode ?? (scope.changeType === 'single-file' ? 'relaxed' as const : 'strict' as const),
      boundaries: scope.boundaries,
    };
  }

  /**
   * Resolve scope for a delegation. Pure function — no side effects.
   *
   * Returns:
   * - null → caller should trigger error (e.g. coder without scope)
   * - Scope object → use this scope
   */
  static resolveScope(
    params: { specialist: string; scope?: Scope },
    specialistDef: { name: string; tools: string[] },
    cwd: string,
  ): Scope | null {
    const specialist = params.specialist;
    const isReadOnly = !specialistDef.tools.includes('edit') && !specialistDef.tools.includes('write');

    // Explicit scope provided → normalize and use
    if (params.scope) {
      return ScopeManager.normalizeExplicitScope(params.scope);
    }

    // Per-specialist defaults when no explicit scope
    if (specialist === "coder") {
      return null; // coder requires explicit scope
    }

    if (specialist === "writer") {
      return getDefaultWriterScope(cwd);
    }

    if (isReadOnly) {
      return getReadOnlyDefaultScope();
    }

    return null; // other specialists require explicit scope
  }

}

// ─── Per-delegation scope (parallel mode isolation) ───────────

/** Per-delegation scope path */
function _delegationScopePath(delegationId: string): string {
  const agentDir = getAgentDir();
  return join(agentDir, 'scopes', `${delegationId}.json`);
}

/** Create a new delegation scope (returns delegationId) */
export function createDelegationScope(scope: Scope): string {
  const delegationId = randomUUID();
  const scopePath = _delegationScopePath(delegationId);
  // Atomic write: a sibling delegation's guard may read this concurrently.
  writeJsonAtomic(scopePath, scope);
  return delegationId;
}

/** Absolute path of a delegation's per-delegation scope file (test/debug aid). */
export function delegationScopePath(delegationId: string): string {
  return _delegationScopePath(delegationId);
}

/** Read a delegation scope */
export function readDelegationScope(delegationId: string): Scope | null {
  const scopePath = _delegationScopePath(delegationId);
  if (!existsSync(scopePath)) return null;
  return JSON.parse(readFileSync(scopePath, 'utf-8'));
}

/** Clear a delegation scope */
export function clearDelegationScope(delegationId: string): void {
  const scopePath = _delegationScopePath(delegationId);
  if (existsSync(scopePath)) unlinkSync(scopePath);
}

// Manifest for tracking active delegations
export interface DelegationManifest {
  active: string[];
  completed: string[];
}

function _manifestPath(): string {
  return join(getAgentDir(), 'scopes', 'manifest.json');
}

export function getManifest(): DelegationManifest {
  const path = _manifestPath();
  if (!existsSync(path)) return { active: [], completed: [] };
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function updateManifest(active: string[], completed: string[]): void {
  const path = _manifestPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ active, completed }, null, 2));
}

/** Cleanup stale scope files (>24h old) */
export function cleanupStaleScopes(): void {
  const scopesDir = join(getAgentDir(), 'scopes');
  if (!existsSync(scopesDir)) return;

  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  readdirSync(scopesDir).forEach(file => {
    if (file === 'manifest.json') return;
    const filePath = join(scopesDir, file);
    const stat = statSync(filePath);
    if (now - stat.mtimeMs > maxAge) {
      unlinkSync(filePath);
    }
  });
}
