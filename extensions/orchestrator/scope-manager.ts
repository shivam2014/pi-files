import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

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
\`\`\``;
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
    try {
      if (!existsSync(path)) return null;
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (!raw.version || !raw.schema || !raw.scope) return null;
      return raw.scope as ResolvedScope;
    } catch {
      return null;
    }
  }

  clearScope(): void {
    const path = join(this.cwd, '.pi', 'scope.json');
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // noop
    }
  }
}
