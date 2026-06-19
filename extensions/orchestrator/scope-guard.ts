import { existsSync, readFileSync } from 'fs';
import { join, relative, isAbsolute, resolve, sep } from 'path';

export interface ResolvedScope {
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

export interface ScopeFileContract {
  version: number;
  schema: string;
  scope: ResolvedScope;
}

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

  private scopePath(): string {
    return join(this.cwd, '.pi', 'scope.json');
  }

  private readScopeFile(): { version: number; schema: string; scope: any } | null {
    try {
      const path = this.scopePath();
      if (!existsSync(path)) return null;
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (!raw.version || !raw.schema || !raw.scope) return null;
      return raw;
    } catch {
      return null;
    }
  }

  isScopeValid(): boolean {
    return this.readScopeFile() !== null;
  }

  isPathAllowed(filePath: string, operation: 'write' | 'edit' | 'read'): { allowed: boolean; reason?: string } {
    const data = this.readScopeFile();
    if (!data) return { allowed: false, reason: 'No scope file' };

    const { scope } = data;
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

  checkFileSize(filePath: string, content: string): boolean {
    const data = this.readScopeFile();
    if (!data) return true; // no scope = no limit
    const { scope } = data;
    if (scope.gateMode === 'relaxed') return true;
    const maxLines = scope.maxLinesPerFile;
    if (maxLines <= 0) return true;
    const lines = content.split('\n').length;
    return lines <= maxLines;
  }

  requestExpansion(filePath: string): ScopeExpansionRequest | null {
    const data = this.readScopeFile();
    if (!data) return null;

    const { scope } = data;
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

  resetSession(): void {
    // noop for now
  }
}
