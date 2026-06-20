import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'path';

interface ResolvedScope {
  filesToModify: string[];
  filesToCreate: string[];
  directories: string[];
  maxFiles: number;
  requiresApprovalBeyondScope: boolean;
  changeType: 'single-file' | 'multi-file';
  maxLinesPerFile: number;
  gateMode: 'strict' | 'relaxed';
  boundaries?: string;
}

export interface ScopeExpansionRequest {
  path: string;
  reason: string;
  scopeManifest: ResolvedScope | null;
  suggestedExpansion?: { directories?: string[]; filesToModify?: string[] };
}

function normalizePath(filePath: string, cwd: string): string | null {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(cwd, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

export class ScopeGuard {
  constructor(private cwd: string) {}

  private _readScope(): ResolvedScope | null {
    const path = join(this.cwd, '.pi', 'scope.json');
    try {
      if (!existsSync(path)) return null;
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (!raw.version || !raw.schema || !raw.scope) return null;
      if (raw.version !== 1 || raw.schema !== 'scope-file-contract-v1') return null;
      return raw.scope as ResolvedScope;
    } catch {
      return null;
    }
  }

  isScopeValid(): boolean {
    return this._readScope() !== null;
  }

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

  isPathAllowed(filePath: string, operation: 'write' | 'edit' | 'read'): { allowed: boolean; reason?: string } {
    const scope = this._readScope();
    if (!scope) return { allowed: false, reason: 'No scope file' };

    const normalized = normalizePath(filePath, this.cwd);
    if (!normalized) {
      return { allowed: false, reason: `Path escapes working directory: ${filePath}` };
    }

    // Check direct file allowlists
    const allApproved = [...scope.filesToModify, ...scope.filesToCreate];
    for (const approved of allApproved) {
      const approvedRel = isAbsolute(approved) ? normalizePath(approved, this.cwd) : approved;
      if (!approvedRel) continue;
      if (approvedRel === normalized) return { allowed: true };
    }

    // Check directory-level allowlist
    for (const dir of scope.directories) {
      const normalizedDir = dir.replace(/\/$/, '') + '/';
      if (normalized.startsWith(normalizedDir) || normalized === dir) {
        return { allowed: true };
      }
    }

    return { allowed: false, reason: `File not in approved scope: ${filePath}` };
  }

  checkFileSize(filePath: string, content: string): { allowed: boolean; reason?: string } {
    const scope = this._readScope();
    if (!scope) return { allowed: false, reason: 'No scope file found' };
    if (scope.gateMode === 'relaxed') return { allowed: true };
    const maxLines = scope.maxLinesPerFile;
    if (maxLines <= 0) return { allowed: true };
    const lines = content.split('\n').length;
    return { allowed: lines <= maxLines };
  }


}
