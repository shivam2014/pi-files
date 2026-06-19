import { join, relative, isAbsolute, resolve } from 'path';
import { ScopeManager, type ResolvedScope, type ScopeFileContract } from './scope-manager.ts';

export type { ResolvedScope, ScopeFileContract };

export interface ScopeExpansionRequest {
  path: string;
  currentScope: {
    filesToModify: string[];
    filesToCreate: string[];
    directories: string[];
  };
  suggestedExpansion: {
    filesToModify?: string[];
    filesToCreate?: string[];
    directories?: string[];
  };
}

function normalizePath(filePath: string, cwd: string): string | null {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(cwd, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

export class ScopeGuard {
  constructor(private cwd: string) {}

  isScopeValid(): boolean {
    return new ScopeManager(this.cwd).readScope() !== null;
  }

  isPathAllowed(filePath: string, operation: 'write' | 'edit' | 'read'): { allowed: boolean; reason?: string } {
    const scope = new ScopeManager(this.cwd).readScope();
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
    const scope = new ScopeManager(this.cwd).readScope();
    if (!scope) return { allowed: false, reason: 'No scope file found' };
    if (scope.gateMode === 'relaxed') return { allowed: true };
    const maxLines = scope.maxLinesPerFile;
    if (maxLines <= 0) return { allowed: true };
    const lines = content.split('\n').length;
    return { allowed: lines <= maxLines };
  }

  requestExpansion(filePath: string): ScopeExpansionRequest | null {
    const scope = new ScopeManager(this.cwd).readScope();
    if (!scope) return null;

    const normalized = normalizePath(filePath, this.cwd);
    if (!normalized) return null;

    // Check if path is already allowed
    const allApproved = [...scope.filesToModify, ...scope.filesToCreate];
    for (const approved of allApproved) {
      const approvedRel = isAbsolute(approved) ? normalizePath(approved, this.cwd) : approved;
      if (!approvedRel) continue;
      if (approvedRel === normalized) return null;
    }

    for (const dir of scope.directories) {
      const normalizedDir = dir.replace(/\/$/, '') + '/';
      if (normalized.startsWith(normalizedDir) || normalized === dir) return null;
    }

    // Path is blocked, suggest expansion
    return {
      path: normalized,
      currentScope: {
        filesToModify: scope.filesToModify,
        filesToCreate: scope.filesToCreate,
        directories: scope.directories,
      },
      suggestedExpansion: {
        filesToModify: [normalized],
      },
    };
  }
}
