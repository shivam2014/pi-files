import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ScopeGuard } from './scope-guard';

describe('edit-filesize bug — edit on large file incorrectly blocked', () => {
  let tmpDir: string;
  let guard: ScopeGuard;

  const MAX_LINES = 80;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'edit-filesize-bug-'));
    guard = new ScopeGuard(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: build a ScopeGuard with the given maxLinesPerFile setting.
   * Writes a minimal .pi/scope.json so checkFileSize can read it.
   */
  function makeGuardWithLimit(max: number): ScopeGuard {
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.pi', 'scope.json'),
      JSON.stringify({
        version: 1,
        schema: 'scope-file-contract-v1',
        scope: {
          filesToModify: ['big-file.ts'],
          filesToCreate: [],
          directories: [],
          maxFiles: 10,
          requiresApprovalBeyondScope: true,
          changeType: 'single-file',
          maxLinesPerFile: max,
          gateMode: 'strict',
        },
      })
    );
    return new ScopeGuard(tmpDir);
  }

  const largeContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');

  it('edit operation on file exceeding maxLinesPerFile is allowed (FIXED)', () => {
    // 200-line file exceeds the 80-line limit, but edits are surgical — exempt from size check
    writeFileSync(join(tmpDir, 'big-file.ts'), largeContent);
    const g = makeGuardWithLimit(MAX_LINES);
    const result = g.checkFileSize(join(tmpDir, 'big-file.ts'), largeContent, 'edit');
    expect(result.allowed).toBe(true);
  });

  it('write operation on file exceeding maxLinesPerFile uses new content (FIXED)', () => {
    // Existing file is 200 lines, but the NEW write content is only 50 lines
    writeFileSync(join(tmpDir, 'big-file.ts'), largeContent);
    const newContent = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const g = makeGuardWithLimit(MAX_LINES);
    // subagent-tool-guard passes input.content (new content) for writes — this works
    const result = g.checkFileSize(join(tmpDir, 'big-file.ts'), newContent, 'write');
    expect(result.allowed).toBe(true);
  });

  it('edit operation with small edit on large file should be allowed', () => {
    // Desired behavior AFTER the fix:
    // subagent-tool-guard should pass the RESULTING content (after applying edits)
    // to checkFileSize, not the raw existing file content.
    writeFileSync(join(tmpDir, 'big-file.ts'), largeContent);
    const g = makeGuardWithLimit(MAX_LINES);
    // Simulate: a trim edit that shrinks the file from 200 → 79 lines
    const trimmedContent = Array.from({ length: 79 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = g.checkFileSize(join(tmpDir, 'big-file.ts'), trimmedContent, 'edit');
    expect(result.allowed).toBe(true);
  });
});
