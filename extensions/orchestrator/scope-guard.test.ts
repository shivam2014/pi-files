import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ScopeGuard } from './scope-guard';

describe('ScopeGuard', () => {
  let tmpDir: string;
  let guard: ScopeGuard;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scope-guard-test-'));
    guard = new ScopeGuard(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('isScopeValid', () => {
    it('returns false when no scope file exists', () => {
      expect(guard.isScopeValid()).toBe(false);
    });

    it('returns false for malformed JSON', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(join(tmpDir, '.pi', 'scope.json'), 'not-valid-json');
      expect(guard.isScopeValid()).toBe(false);
    });

    it('returns false when missing version field', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(join(tmpDir, '.pi', 'scope.json'), JSON.stringify({ schema: 'v1', scope: {} }));
      expect(guard.isScopeValid()).toBe(false);
    });

    it('returns true for valid scope file', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: { filesToModify: [], filesToCreate: [], directories: [] },
        })
      );
      expect(guard.isScopeValid()).toBe(true);
    });
  });

  describe('isPathAllowed', () => {
    it('allows files listed in filesToModify', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: {
            filesToModify: ['src/test.ts'],
            filesToCreate: [],
            directories: [],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: 'multi-file',
            maxLinesPerFile: 400,
            gateMode: 'strict',
          },
        })
      );
      const result = guard.isPathAllowed('src/test.ts', 'write');
      expect(result.allowed).toBe(true);
    });

    it('blocks files outside scope', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: {
            filesToModify: ['src/test.ts'],
            filesToCreate: [],
            directories: [],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: 'multi-file',
            maxLinesPerFile: 400,
            gateMode: 'strict',
          },
        })
      );
      const result = guard.isPathAllowed('src/other.ts', 'write');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('blocks write when no scope file (fail-closed)', () => {
      const result = guard.isPathAllowed('src/test.ts', 'write');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('No scope file');
    });

    it('blocks directory traversal escape', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: {
            filesToModify: [],
            filesToCreate: [],
            directories: ['src'],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: 'multi-file',
            maxLinesPerFile: 400,
            gateMode: 'strict',
          },
        })
      );
      const result = guard.isPathAllowed('../etc/passwd', 'write');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe('checkFileSize', () => {
    it('blocks content exceeding maxLinesPerFile', () => {
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
            maxLinesPerFile: 10,
            gateMode: 'strict',
          },
        })
      );
      const content = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n');
      expect(guard.checkFileSize('test.ts', content).allowed).toBe(false);
    });

    it('allows content exceeding maxLinesPerFile when gateMode is relaxed', () => {
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
            changeType: 'single-file',
            maxLinesPerFile: 10,
            gateMode: 'relaxed',
          },
        })
      );
      const content = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n');
      expect(guard.checkFileSize('test.ts', content).allowed).toBe(true);
    });
  });

  describe('requestExpansion', () => {
    it('returns expansion request for blocked path', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: {
            filesToModify: ['src/test.ts'],
            filesToCreate: [],
            directories: [],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: 'multi-file',
            maxLinesPerFile: 400,
            gateMode: 'strict',
          },
        })
      );
      const result = guard.requestExpansion('src/other.ts');
      expect(result).not.toBeNull();
      expect(result!.path).toBe('src/other.ts');
      expect(result!.suggestedExpansion.filesToModify).toContain('src/other.ts');
    });

    it('returns null for allowed path', () => {
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.pi', 'scope.json'),
        JSON.stringify({
          version: 1,
          schema: 'scope-file-contract-v1',
          scope: {
            filesToModify: ['src/test.ts'],
            filesToCreate: [],
            directories: [],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: 'multi-file',
            maxLinesPerFile: 400,
            gateMode: 'strict',
          },
        })
      );
      expect(guard.requestExpansion('src/test.ts')).toBeNull();
    });

    it('returns null when no scope file exists', () => {
      expect(guard.requestExpansion('src/test.ts')).toBeNull();
    });
  });
});
