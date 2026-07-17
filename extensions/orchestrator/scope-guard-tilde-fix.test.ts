import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { ScopeGuard, normalizePath } from './scope-guard';

describe('Tilde expansion in scope guard', () => {
  let tmpDir: string;
  let guard: ScopeGuard;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scope-guard-tilde-test-'));
    guard = new ScopeGuard(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('normalizePath — tilde expansion', () => {
    it('expands ~/ to home directory', () => {
      const result = normalizePath('~/.pi/agent/extensions/orchestrator/scope-guard.ts', '/tmp/cwd');
      expect(result).toBe(
        join(homedir(), '.pi/agent/extensions/orchestrator/scope-guard.ts'),
      );
    });

    it('leaves absolute paths unchanged', () => {
      const result = normalizePath('/absolute/path.ts', '/tmp/cwd');
      expect(result).toBe('/absolute/path.ts');
    });

    it('resolves relative paths against cwd', () => {
      const result = normalizePath('relative/path.ts', '/tmp/cwd');
      // normalizePath returns posix-normalized relative path when inside cwd
      expect(result).toBe('relative/path.ts');
    });
  });

  describe('isPathAllowed — tilde paths in scope', () => {
    it('allows tilde path matching directory in scope', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: {
            filesToModify: [],
            filesToCreate: [],
            directories: [join(homedir(), '.pi/agent')],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: 'multi-file',
            maxLinesPerFile: 400,
            gateMode: 'strict',
          },
        }),
      );
      // Tilde path should expand and match the directory
      const result = guard.isPathAllowed(
        '~/.pi/agent/extensions/orchestrator/scope-guard.ts',
        'edit',
      );
      expect(result.allowed).toBe(true);
    });

    it('allows tilde path in filesToModify', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: {
            filesToModify: [join(homedir(), '.pi/agent/config.ts')],
            filesToCreate: [],
            directories: [],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: 'multi-file',
            maxLinesPerFile: 400,
            gateMode: 'strict',
          },
        }),
      );
      const result = guard.isPathAllowed(
        '~/.pi/agent/config.ts',
        'edit',
      );
      expect(result.allowed).toBe(true);
    });
  });
});
