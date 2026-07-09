import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { getDefaultWriterScope, getReadOnlyDefaultScope } from './scope-policy.ts';

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
    boundaries?: "do not modify src/legacy"
}
\`\`\`
Glob patterns (*, **, ?) supported. Bare wildcard '/*' rejected — must include a literal path segment.`;
}

export interface ScopeFileContract {
  version: number;
  schema: string;
  scope: ResolvedScope;
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

export function normalizeScopePath(filePath: string, cwd: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  return absolute;
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

  writeScope(manifest: ScopeManifest): void {
    const scope = this.normalize(manifest);
    // Normalize file paths to canonical absolute form
    const normalizedManifest: ScopeManifest = {
      ...manifest,
      filesToModify: (manifest.filesToModify ?? []).map(p => normalizeScopePath(p, this.cwd)),
      filesToCreate: (manifest.filesToCreate ?? []).map(p => normalizeScopePath(p, this.cwd)),
    };
    const normalizedScope = this.normalize(normalizedManifest);
    const dir = join(this.cwd, '.pi');
    mkdirSync(dir, { recursive: true });
    const contract: ScopeFileContract = {
      version: 1,
      schema: 'scope-file-contract-v1',
      scope,
    };
    writeFileSync(join(dir, 'scope.json'), JSON.stringify(contract, null, 2));
  }

  readScope(): ResolvedScope | null {
    const path = join(this.cwd, '.pi', 'scope.json');
    return parseScopeFile(path);
  }

  clearScope(): void {
    const path = join(this.cwd, '.pi', 'scope.json');
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // noop
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
