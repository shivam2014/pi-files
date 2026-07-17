import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ScopeGuard } from './scope-guard';

describe('ScopeGuard checkFileSize READ bypass', () => {
  let tmpDir: string;
  let guard: ScopeGuard;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'check-filesize-read-fix-'));
    guard = new ScopeGuard(tmpDir);
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.pi', 'scope.json'),
      JSON.stringify({
        version: 1,
        schema: 'scope-file-contract-v1',
        scope: {
          filesToModify: [],
          filesToCreate: [],
          directories: [],
          maxFiles: 10,
          requiresApprovalBeyondScope: true,
          changeType: 'multi-file',
          maxLinesPerFile: 200,
          gateMode: 'strict',
        },
      })
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('checkFileSize with operation=read on 500-line content returns { allowed: true }', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = guard.checkFileSize('large.ts', content, 'read');
    expect(result).toEqual({ allowed: true });
  });

  it('checkFileSize with operation=write on 500-line content returns { allowed: false }', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = guard.checkFileSize('large.ts', content, 'write');
    expect(result.allowed).toBe(false);
  });

  it('checkFileSize with no operation on 500-line content returns { allowed: false } (backwards compat)', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = guard.checkFileSize('large.ts', content);
    expect(result.allowed).toBe(false);
  });

  it('checkFileSize with operation=read on 100-line content returns { allowed: true }', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = guard.checkFileSize('small.ts', content, 'read');
    expect(result).toEqual({ allowed: true });
  });
});
