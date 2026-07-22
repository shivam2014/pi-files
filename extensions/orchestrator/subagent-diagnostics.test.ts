import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureDiagnostic, truncatePreview, redactSecrets, persistDiagnostic, cleanupOldDiagnostics, isDiagnosticsEnabled, getDiagnosticsDir, type CaptureDiagnosticInput } from './subagent-diagnostics';
import type { SubagentDiagnostic } from './types';

const baseInput: CaptureDiagnosticInput = {
  output: 'Task completed successfully with all files modified.',
  turns: 3,
  toolCallTrail: [
    { tool: 'read' },
    { tool: 'edit' },
    { tool: 'bash' },
  ],
  elapsedMs: 1200,
  specialist: 'coder',
  task: 'Fix the auth middleware in src/auth.ts',
  sessionId: 'sess-001',
  model: 'test-model',
  stopReason: 'end_turn',
  metrics: {
    readCalls: 2,
    grepCalls: 1,
    findCalls: 0,
    editCalls: 1,
    writeCalls: 0,
    bashCalls: 1,
    lsCalls: 0,
  },
};

describe('captureDiagnostic', () => {
  it('returns null for normal subagent — toolCalls > 0, turns > 0, non-empty output', () => {
    const result = captureDiagnostic(baseInput);
    expect(result).toBeNull();
  });

  it('returns diagnostic for 0 tool calls — toolCalls === 0, turns >= 1, short output', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: 'x',
      turns: 2,
      toolCallTrail: [],
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toBe(0);
    expect(result!.turns).toBe(2);
    expect(result!.crashed).toBe(false);
    expect(result!.specialist).toBe('coder');
    expect(result!.task).toBe('Fix the auth middleware in src/auth.ts');
    expect(result!.sessionId).toBe('sess-001');
    expect(result!.elapsedMs).toBe(1200);
  });

  it('returns diagnostic with crashed:true — no assistant message, empty toolCallTrail, turns > 0, no output', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: '',
      turns: 1,
      toolCallTrail: [],
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(result!.crashed).toBe(true);
    expect(result!.toolCalls).toBe(0);
    expect(result!.turns).toBe(1);
    expect(result!.outputPreview).toBe('');
  });

  it('QA-like task with 0 tool calls still produces diagnostic', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: '',
      turns: 2,
      toolCallTrail: [],
      task: 'What is the capital?',
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toBe(0);
    expect(result!.turns).toBe(2);
  });

  it('Task with 0 tool calls still caught', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: '',
      turns: 3,
      toolCallTrail: [],
      task: 'Implement the login endpoint in src/auth/login.ts and add tests',
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toBe(0);
    expect(result!.turns).toBe(3);
  });

  it('Output preview capped at 200 chars — truncatePreview returns first 200 chars plus ellipsis', () => {
    const text = 'A'.repeat(250);
    const result = truncatePreview(text, 200);
    expect(result.length).toBe(203); // 200 + '...'
    expect(result).toBe('A'.repeat(200) + '...');
  });

  it('truncatePreview returns original text when under maxLen', () => {
    const text = 'short';
    expect(truncatePreview(text, 200)).toBe('short');
  });

  it('truncatePreview returns original text when exactly maxLen', () => {
    const text = 'A'.repeat(200);
    expect(truncatePreview(text, 200)).toBe(text);
  });

  it('Secrets redacted from output preview — redactSecrets replaces tokens with [REDACTED]', () => {
    const input = 'Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890abc, API: sk-abcdefghijklmnopqrstuvwxyz1234567890, Bearer: Bearer 12345abcdefghijklmnopqrstuvwxyz67890';
    const result = redactSecrets(input);
    expect(result).not.toContain('ghp_');
    expect(result).not.toContain('sk-');
    expect(result).not.toContain('12345abcdefghijklmnopqrstuvwxyz67890');
    expect(result).toContain('[REDACTED]');
  });

  it('crashed diagnostic has outputPreview set to empty string when no output', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: '',
      turns: 2,
      toolCallTrail: [],
      task: 'Fix the bug in src/worker.ts',
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(result!.crashed).toBe(true);
    expect(result!.outputPreview).toBe('');
  });

  it('includes metrics in the diagnostic result', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: '',
      turns: 1,
      toolCallTrail: [],
      task: 'Refactor the module in src/lib.ts',
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(result!.metrics).toEqual(input.metrics);
    expect(result!.metrics.readCalls).toBe(2);
    expect(result!.metrics.scopeNotes).toBeUndefined();
  });

  it('schemaVersion is set to 1', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: '',
      turns: 1,
      toolCallTrail: [],
      task: 'Add feature in src/index.ts',
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(1);
  });

  it('timestamp is a valid ISO string', () => {
    const input: CaptureDiagnosticInput = {
      ...baseInput,
      output: '',
      turns: 1,
      toolCallTrail: [],
      task: 'Update config in src/settings.ts',
    };
    const result = captureDiagnostic(input);
    expect(result).not.toBeNull();
    expect(() => new Date(result!.timestamp)).not.toThrow();
    expect(new Date(result!.timestamp).toISOString()).toBe(result!.timestamp);
  });
});

const sampleDiagnostic: SubagentDiagnostic = {
  schemaVersion: 1,
  sessionId: 'sess-test-001',
  timestamp: '2026-06-15T10:30:00.000Z',
  specialist: 'coder',
  task: 'Fix the auth middleware in src/auth.ts',
  turns: 3,
  toolCalls: 0,
  elapsedMs: 1200,
  crashed: false,
  outputPreview: 'some output',
  metrics: {
    readCalls: 2,
    grepCalls: 1,
    findCalls: 0,
    editCalls: 1,
    writeCalls: 0,
    bashCalls: 1,
    lsCalls: 0,
  },
  kind: 'silent_failure',
  diagnosticId: 'test-diag-001',
  model: 'test-model',
  stopReason: 'end_turn',
};

describe('persistDiagnostic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'diag-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes to correct date-based path', () => {
    const filePath = persistDiagnostic(tmpDir, sampleDiagnostic);
    // Path should contain extensions/orchestrator/diagnostics/2026-06-15/sess-test-001/incident-...-coder-....json
    expect(filePath).toContain('diagnostics');
    expect(filePath).toContain('2026-06-15');
    expect(filePath).toContain('sess-test-001');
    expect(filePath).toContain('coder');
    expect(filePath).toMatch(/\.json$/);
    expect(existsSync(filePath)).toBe(true);
  });

  it('creates directories recursively', () => {
    const filePath = persistDiagnostic(tmpDir, sampleDiagnostic);
    expect(existsSync(filePath)).toBe(true);
    // Verify intermediate dirs exist
    expect(existsSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics'))).toBe(true);
    expect(existsSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', '2026-06-15'))).toBe(true);
    expect(existsSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', '2026-06-15', 'sess-test-001'))).toBe(true);
  });

  it('uses atomic write (tmp → rename)', () => {
    const filePath = persistDiagnostic(tmpDir, sampleDiagnostic);
    // .tmp file should not exist after successful write
    expect(existsSync(filePath + '.tmp')).toBe(false);
    // json file should exist
    expect(existsSync(filePath)).toBe(true);
    // Content should be valid JSON matching input
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.sessionId).toBe('sess-test-001');
    expect(content.specialist).toBe('coder');
  });

  it('returns the file path', () => {
    const filePath = persistDiagnostic(tmpDir, sampleDiagnostic);
    expect(typeof filePath).toBe('string');
    expect(filePath.length).toBeGreaterThan(0);
  });
});

describe('cleanupOldDiagnostics', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'diag-clean-'));
    // Create an old directory (90 days ago)
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const oldDirName = oldDate.toISOString().slice(0, 10);
    mkdirSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', oldDirName), { recursive: true });
    writeFileSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', oldDirName, 'test.json'), '{}');
    // Create a recent directory (1 day ago)
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const recentDirName = recentDate.toISOString().slice(0, 10);
    mkdirSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', recentDirName), { recursive: true });
    writeFileSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', recentDirName, 'test.json'), '{}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes old directories older than maxAgeDays', () => {
    const deleted = cleanupOldDiagnostics(tmpDir, 30);
    expect(deleted).toBe(1);
    // Old dir should be gone
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const oldDirName = oldDate.toISOString().slice(0, 10);
    expect(existsSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', oldDirName))).toBe(false);
  });

  it('keeps recent directories within maxAgeDays', () => {
    cleanupOldDiagnostics(tmpDir, 30);
    // Recent dir should still exist
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const recentDirName = recentDate.toISOString().slice(0, 10);
    expect(existsSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', recentDirName))).toBe(true);
  });

  it('returns 0 when no diagnostics directory exists', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'diag-empty-'));
    try {
      const deleted = cleanupOldDiagnostics(emptyDir, 30);
      expect(deleted).toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('skips non-date directories', () => {
    mkdirSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', 'not-a-date'), { recursive: true });
    const deleted = cleanupOldDiagnostics(tmpDir, 30);
    expect(deleted).toBe(1); // Only the old date dir
    expect(existsSync(join(tmpDir, 'extensions', 'orchestrator', 'diagnostics', 'not-a-date'))).toBe(true);
  });
});

describe('isDiagnosticsEnabled', () => {
  const originalEnv = process.env.PI_ORCHESTRATOR_DIAGNOSTICS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PI_ORCHESTRATOR_DIAGNOSTICS;
    } else {
      process.env.PI_ORCHESTRATOR_DIAGNOSTICS = originalEnv;
    }
  });

  it('returns false when env var is off', () => {
    process.env.PI_ORCHESTRATOR_DIAGNOSTICS = 'off';
    expect(isDiagnosticsEnabled()).toBe(false);
  });

  it('returns true when env var unset', () => {
    delete process.env.PI_ORCHESTRATOR_DIAGNOSTICS;
    expect(isDiagnosticsEnabled()).toBe(true);
  });

  it('returns true when env var set to any non-off value', () => {
    process.env.PI_ORCHESTRATOR_DIAGNOSTICS = 'on';
    expect(isDiagnosticsEnabled()).toBe(true);
  });

  it('returns true when env var is empty string', () => {
    process.env.PI_ORCHESTRATOR_DIAGNOSTICS = '';
    expect(isDiagnosticsEnabled()).toBe(true);
  });
});

describe('getDiagnosticsDir', () => {
  it('returns path joined with diagnostics', () => {
    expect(getDiagnosticsDir('/some/agent/dir')).toBe('/some/agent/dir/extensions/orchestrator/diagnostics');
  });

  it('handles relative paths', () => {
    expect(getDiagnosticsDir('./agent')).toBe('agent/extensions/orchestrator/diagnostics');
  });
});
