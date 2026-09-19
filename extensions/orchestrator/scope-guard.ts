import * as os from 'os';
import * as fs from 'fs';
import { join, relative, isAbsolute, resolve, posix } from 'path';
import picomatch from 'picomatch';
import { parseScopeFile, readDelegationScope, type ResolvedScope } from './scope-manager';

/**
 * Scope expansion request emitted when a subagent tries to write/edit outside scope.
 * Sent to the orchestrator, which decides whether to expand scope based on conversation context.
 * The subagent continues running — this does NOT terminate it.
 */
export interface ScopeExpansionRequest {
  path: string;
  reason: string;
  scopeManifest: ResolvedScope | null;
  suggestedExpansion?: { directories?: string[]; filesToModify?: string[] };
}

export function normalizePath(filePath: string, cwd: string): string {
  if (filePath.startsWith('~/')) {
    filePath = filePath.replace(/^~/, os.homedir());
  }
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(cwd, absolute);
  // If relative starts with '..', the path escapes cwd — return absolute
  if (rel.startsWith('..') || isAbsolute(rel)) return absolute;
  return posix.normalize(rel);
}

/** True if string contains glob metacharacters */
function hasGlobChars(s: string): boolean {
  return /[*?[!{]/.test(s);
}

/**
 * Temp-scratch prefixes that are always writable regardless of scope.
 * Derived (not hardcoded) so the macOS symlink form is covered:
 *  - '/tmp/'           (Linux + macOS canonical scratch)
 *  - realpath('/tmp')  -> '/private/tmp/'  (macOS resolves /tmp here)
 * The bug this fixes: a resolved macOS scratch path is '/private/tmp/...',
 * which the old hardcoded ['/tmp/'] list did NOT match, so it was falsely blocked.
 *
 * os.tmpdir() is consulted but granted ONLY when it resolves into the same
 * canonical scratch family. On macOS os.tmpdir() is '/var/folders/<...>/T'
 * (realpath '/private/var/folders/.../T'); granting that whole root would permit
 * escaped '../' traversal from any cwd living under it, which the existing
 * scope-guard.test.ts 'blocks directory traversal escape' test correctly forbids.
 */
function computeUniversalAllowedPrefixes(): string[] {
  const prefixes = new Set<string>(['/tmp/']);
  const candidates: string[] = ['/tmp'];
  try { candidates.push(os.tmpdir()); } catch { /* os.tmpdir unavailable */ }
  for (const c of candidates) {
    if (!c) continue;
    try {
      const real = fs.realpathSync(c);
      if (real === '/tmp' || real === '/private/tmp') {
        prefixes.add(real.endsWith('/') ? real : real + '/');
      }
    } catch { /* path may not exist — keep the literal form */ }
  }
  return [...prefixes];
}

const UNIVERSAL_ALLOWED = computeUniversalAllowedPrefixes();

/**
 * Thin enforcement adapter for scope boundaries.
 *
 * Reads `.pi/scope.json` directly (raw JSON). Zero coupling to orchestrator modules —
 * the file path and schema are the shared contract.
 *
 * ## Blocking behavior
 * When a write/edit targets a path outside the allowed scope:
 * - `isPathAllowed()` returns `{ allowed: false, reason }`
 * - The subagent tool guard returns `{ block: true, reason: "Scope violation: <path> is outside the allowed scope" }`
 * - The subagent **continues running** — it does NOT terminate
 * - The blocked operation simply does not execute
 *
 * ## Expansion flow
 * If scope.json exists but the path is not in it, `requestExpansion()` emits a
 * `ScopeExpansionRequest` with the blocked path and current scope manifest.
 * The orchestrator (not the subagent) decides whether to expand.
 *
 * ## Metrics
 * Each blocked call increments `scopeNotes` in the delegation metrics,
 * surfaced in the subagent's diagnostic output.
 *
 * ## Fail-closed
 * Missing, malformed, or stale scope.json → all writes blocked.
 * Reads are always allowed (scope only enforces mutations).
 */
export class ScopeGuard {
  constructor(
    private cwd: string,
    private delegationId?: string,
    /**
     * Permit reading the shared `<cwd>/.pi/scope.json` when no delegation id is
     * supplied. Retained ONLY for non-subagent (orchestrator-side / legacy)
     * callers — subagent enforcement passes `false` so a stale, unrelated
     * shared file can never influence a subagent's writes (Defect B).
     */
    private opts: { allowSharedFallback?: boolean } = {},
  ) {}

  /**
   * Read and validate this guard's scope. Returns null if missing, malformed,
   * or wrong version/schema (fail-closed: null → all writes blocked).
   *
   * Per-session resolution: when the caller supplies a delegation id (threaded
   * from the subagent's SubagentState), resolve THAT subagent's own
   * per-delegation file (~/.pi/agent/scopes/<id>.json). This removes the
   * cross-delegation permit where one delegation validated against a sibling's
   * shared <cwd>/.pi/scope.json. Missing per-delegation file → null (blocked).
   *
   * Defect B: when `allowSharedFallback` is false (all subagent enforcement),
   * an absent delegation id is fail-CLOSED (null) — the shared
   * `<cwd>/.pi/scope.json` is NEVER consulted, so a stale file left by an
   * unrelated delegation cannot permit or block this session's writes. The
   * fallback is retained only for legacy/direct callers that opt in.
   */
  private _readScope(): ResolvedScope | null {
    if (this.delegationId) {
      const scope = readDelegationScope(this.delegationId);
      return scope ? (scope as ResolvedScope) : null;
    }
    if (this.opts.allowSharedFallback === false) return null;
    const path = join(this.cwd, '.pi', 'scope.json');
    return parseScopeFile(path);
  }

  /**
   * Check if the scope file exists and is well-formed.
   */
  isScopeValid(): boolean {
    return this._readScope() !== null;
  }

  /**
   * Build a ScopeExpansionRequest for a blocked path.
   * Returns null if no scope file exists (nothing to expand from).
   * The orchestrator uses this to decide whether scope should be widened.
   */
  requestExpansion(filePath: string): ScopeExpansionRequest | null {
    const manifest = this._readScope();
    if (!manifest) return null;
    return {
      path: filePath,
      reason: `Path ${filePath} is not in the allowed scope`,
      scopeManifest: manifest,
      suggestedExpansion: {
        filesToModify: [filePath],
      },
    };
  }

  /**
   * Core enforcement: check if a path is within the allowed scope.
   *
   * Reads always pass (scope only enforces mutations).
   * For writes/edits, checks: exact file match → glob pattern → directory prefix.
   * Returns `{ allowed: false, reason }` on violation — subagent continues running.
   */
  isPathAllowed(filePath: string, operation: 'write' | 'edit' | 'read'): { allowed: boolean; reason?: string } {
    // Reads are always safe — only enforce scope for mutations
    if (operation === 'read') return { allowed: true };

    const scope = this._readScope();
    if (!scope) return { allowed: false, reason: 'No scope file' };

    const normalized = normalizePath(filePath, this.cwd);

    // Universal scratch paths — always permitted regardless of scope.
    // normalizePath() always returns a non-empty string (absolute when the path
    // escapes cwd and posix.normalize('.') for the cwd itself), so there is no
    // reachable empty-path branch here.
    if (UNIVERSAL_ALLOWED.some(prefix => normalized.startsWith(prefix))) {
      return { allowed: true };
    }

    // Check direct file allowlists
    const filesToModify = Array.isArray(scope.filesToModify) ? scope.filesToModify : [];
    const filesToCreate = Array.isArray(scope.filesToCreate) ? scope.filesToCreate : [];
    const allApproved = [...filesToModify, ...filesToCreate];
    for (const approved of allApproved) {
      const approvedRel = isAbsolute(approved) ? normalizePath(approved, this.cwd) : approved;
      if (!approvedRel) continue;
      if (approvedRel === normalized) return { allowed: true };
    }

    // 2. Glob pattern match — check both lists regardless of operation
    const allGlobs = [...filesToModify, ...filesToCreate];
    for (const pattern of allGlobs) {
      if (hasGlobChars(pattern)) {
        // Block .. traversal in glob patterns
        if (pattern.split('/').includes('..')) continue;
        if (picomatch(pattern)(normalized)) {
          return { allowed: true };
        }
      }
    }

    // Check directory-level allowlist
    const directories = Array.isArray(scope.directories) ? scope.directories : [];
    for (let dir of directories) {
      if (dir.startsWith('~/')) dir = dir.replace(/^~/, os.homedir());
      const normalizedDir = dir.replace(/\/$/, '') + '/';
      if (normalized.startsWith(normalizedDir) || normalized === dir) {
        return { allowed: true };
      }
    }

    return { allowed: false, reason: `File not in approved scope: ${filePath}` };
  }

  /**
   * Check if file content exceeds maxLinesPerFile limit.
   * Skipped when gateMode is 'relaxed' or maxLines <= 0.
   */
  checkFileSize(filePath: string, content: string, operation?: string): { allowed: boolean; reason?: string } {
    // Reads are always safe — don't block large file reads
    if (operation === 'read') return { allowed: true };
    // Edits are surgical patches (oldText→newText), not full file writes.
    // maxLinesPerFile limits new file content size, not edits to existing large files.
    if (operation === 'edit') return { allowed: true };
    const scope = this._readScope();
    if (!scope) return { allowed: false, reason: 'No scope file found' };
    if (scope.gateMode === 'relaxed') return { allowed: true };
    const maxLines = scope.maxLinesPerFile;
    if (maxLines <= 0) return { allowed: true };
    const lines = content.split('\n').length;
    return { allowed: lines <= maxLines };
  }


}
