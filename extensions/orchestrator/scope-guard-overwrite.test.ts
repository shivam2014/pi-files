import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ScopeGuard } from './scope-guard';
import { handleSubagentToolCall } from './subagent-tool-guard';

describe('Scope guard — create-then-modify diagnosis', () => {
  let tmpDir: string;
  let guard: ScopeGuard;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scope-overwrite-test-'));
    guard = new ScopeGuard(tmpDir);
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.pi', 'scope.json'),
      JSON.stringify({
        version: 1,
        schema: 'scope-file-contract-v1',
        scope: {
          filesToModify: [],
          filesToCreate: ['new-file.ts'],
          directories: [],
          maxFiles: 10,
          requiresApprovalBeyondScope: true,
          changeType: 'single-file',
          maxLinesPerFile: 400,
          gateMode: 'strict',
        },
      })
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Group 1: isPathAllowed — create-then-modify', () => {
    it('allows write to new file listed in filesToCreate', () => {
      const result = guard.isPathAllowed('new-file.ts', 'write');
      expect(result.allowed).toBe(true);
    });

    it('allows edit to file after it exists (was in filesToCreate)', () => {
      writeFileSync(join(tmpDir, 'new-file.ts'), 'initial content');
      const result = guard.isPathAllowed('new-file.ts', 'edit');
      expect(result.allowed).toBe(true);
    });

    it('allows write (overwrite) to file after it exists (was in filesToCreate)', () => {
      writeFileSync(join(tmpDir, 'new-file.ts'), 'initial content');
      const result = guard.isPathAllowed('new-file.ts', 'write');
      expect(result.allowed).toBe(true);
    });

    it('allows write with absolute path to file in filesToCreate', () => {
      const result = guard.isPathAllowed(join(tmpDir, 'new-file.ts'), 'write');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Group 2: checkFileSize — existing content bug', () => {
    it('checkFileSize blocks write when EXISTING content exceeds maxLinesPerFile', () => {
      // Create a file with 500 lines (exceeds maxLinesPerFile: 400)
      const bigContent = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
      writeFileSync(join(tmpDir, 'big-file.ts'), bigContent);
      // checkFileSize is called with EXISTING content (read by subagent-tool-guard)
      const result = guard.checkFileSize(join(tmpDir, 'big-file.ts'), bigContent, 'write');
      // This SHOULD be allowed: the new content might be small, but
      // subagent-tool-guard passes EXISTING content, not new content
      expect(result.allowed).toBe(false); // EXPECTED: blocked (bug confirmed)
    });

    it('checkFileSize allows write when existing content is under maxLinesPerFile', () => {
      const smallContent = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      writeFileSync(join(tmpDir, 'small-file.ts'), smallContent);
      const result = guard.checkFileSize(join(tmpDir, 'small-file.ts'), smallContent, 'write');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Group 3: handleSubagentToolCall — full integration', () => {
    it('does NOT block write tool call for file in filesToCreate', () => {
      const result = handleSubagentToolCall(
        { toolName: 'write', input: { path: 'new-file.ts', content: 'hello' } },
        true,
        { cwd: tmpDir },
        { planParsed: true, specialistName: 'coder', blockedCalls: [] }
      );
      expect(result?.block).toBeFalsy();
    });

    it('does NOT block edit tool call for file that exists (was in filesToCreate)', () => {
      // First create the file
      writeFileSync(join(tmpDir, 'new-file.ts'), 'hello');
      const result = handleSubagentToolCall(
        { toolName: 'edit', input: { path: 'new-file.ts', edits: [{ oldText: 'hello', newText: 'world' }] } },
        true,
        { cwd: tmpDir },
        { planParsed: true, specialistName: 'coder', blockedCalls: [] }
      );
      expect(result?.block).toBeFalsy();
    });
  });
});
