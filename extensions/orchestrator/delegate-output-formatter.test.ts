import { describe, it, expect } from 'vitest';
import { extractFindingsFromOutput, extractAuditFromOutput, formatResult } from './delegate-pipeline';
import type { DelegationMetrics } from './types';

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[\d;]+m/g, '');
}

const m: DelegationMetrics = {
  readCalls: 3, grepCalls: 2, findCalls: 0,
  editCalls: 1, writeCalls: 0, bashCalls: 5,
  lsCalls: 1, scopeViolations: 0,
};

const fmt = (overrides: Record<string, unknown> = {}) => formatResult({
  output: 'output', metrics: m, elapsed: 1.0, turns: 1, toolCalls: 0,
  status: 'ok' as const, ...overrides,
});

describe('extractFindingsFromOutput', () => {
  it('parses a full findings block', () => {
    const output = `## Findings
- summary: Found hardcoded JWT secret in config
- key_files: [config/auth.ts, src/middleware.ts]
- issues: [hardcoded secret, weak validation]
- recommendation: Move secrets to env vars
`;
    const r = extractFindingsFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.summary).toBe('Found hardcoded JWT secret in config');
    expect(r!.key_files).toEqual(['config/auth.ts', 'src/middleware.ts']);
    expect(r!.issues).toEqual(['hardcoded secret', 'weak validation']);
    expect(r!.recommendation).toBe('Move secrets to env vars');
  });

  it('returns null when no findings block', () => {
    expect(extractFindingsFromOutput('Just some plain text')).toBeNull();
  });

  it('handles findings block at end of output', () => {
    const output = `Some output here.\nMore output.\n\n## Findings\n- summary: Bug found in auth\n- key_files: [auth.ts]\n- issues: [none]\n- recommendation: Fix auth\n`;
    const r = extractFindingsFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.summary).toBe('Bug found in auth');
    expect(r!.key_files).toEqual(['auth.ts']);
  });

  it('handles empty key_files and issues', () => {
    const output = `## Findings\n- summary: All good\n- key_files: []\n- issues: []\n- recommendation: No action needed\n`;
    const r = extractFindingsFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.key_files).toEqual([]);
    expect(r!.issues).toEqual([]);
  });

  it('handles missing fields gracefully', () => {
    const output = `## Findings\n- summary: Partial findings only\n`;
    const r = extractFindingsFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.summary).toBe('Partial findings only');
    expect(r!.key_files).toEqual([]);
    expect(r!.issues).toEqual([]);
    expect(r!.recommendation).toBe('');
  });
});

describe('extractAuditFromOutput', () => {
  it('parses a full audit block with problems', () => {
    const output = `## Audit\n- problems: [file not found, permission denied]\n- resolution: [used alternative path, retried with different approach]\n- scope_stayed: yes\n- scope_notes: stayed within assigned task\n`;
    const r = extractAuditFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.problems).toEqual(['file not found', 'permission denied']);
    expect(r!.resolution).toEqual(['used alternative path', 'retried with different approach']);
    expect(r!.scope_stayed).toBe(true);
    expect(r!.scope_notes).toBe('stayed within assigned task');
  });

  it('returns null when no audit block', () => {
    expect(extractAuditFromOutput('No audit here')).toBeNull();
  });

  it('parses audit with no problems', () => {
    const output = `## Audit\n- problems: [none]\n- resolution: [none]\n- scope_stayed: yes\n- scope_notes: no deviations\n`;
    const r = extractAuditFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.problems).toEqual(['none']);
    expect(r!.scope_stayed).toBe(true);
  });

  it('parses audit with scope_stayed false', () => {
    const output = `## Audit\n- problems: [none]\n- resolution: [none]\n- scope_stayed: no\n- scope_notes: modified file outside allowed list\n`;
    const r = extractAuditFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.scope_stayed).toBe(false);
    expect(r!.scope_notes).toBe('modified file outside allowed list');
  });

  it('parses audit embedded in larger output', () => {
    const output = `Some analysis output here.\n\n## Audit\n- problems: [tool error]\n- resolution: [retried]\n- scope_stayed: true\n- scope_notes: minor deviation\n\n## Findings\n- summary: Done\n`;
    const r = extractAuditFromOutput(output);
    expect(r).not.toBeNull();
    expect(r!.problems).toEqual(['tool error']);
    expect(r!.scope_stayed).toBe(true);
  });

  it('handles scope_stayed as true', () => {
    const output = `## Audit\n- problems: [none]\n- resolution: [none]\n- scope_stayed: true\n- scope_notes: ok\n`;
    expect(extractAuditFromOutput(output)!.scope_stayed).toBe(true);
  });
});

describe('formatResult', () => {
  describe('status note', () => {
    it('formats ok status with toolCalls', () => {
      const result = fmt({ output: 'Some output', elapsed: 5.2, turns: 3, toolCalls: 4, status: 'ok' }).formatted;
      expect(stripAnsi(result)).toMatch(/^✓ Completed \(3 turns, 4 tool calls\)/);
    });

    it('formats aborted status', () => {
      const result = fmt({ output: 'Interrupted', turns: 2, toolCalls: 1, status: 'aborted' }).formatted;
      expect(stripAnsi(result)).toMatch(/^− Aborted — interrupted by user \(2 turns, 1 tool call\)/);
    });

    it('formats error status', () => {
      expect(fmt({ output: 'Something broke', elapsed: 0.5, toolCalls: 2, status: 'error' }).formatted)
        .toMatch(/^✗ Error \(1 turn, 2 tool calls\)/);
    });

    it('uses singular/plural for turns and tool calls', () => {
      expect(fmt({ turns: 1, toolCalls: 1 }).formatted).toContain('1 turn, 1 tool call)');
      expect(fmt({ turns: 1, toolCalls: 1 }).formatted).not.toContain('1 turns');
      expect(fmt({ turns: 1, toolCalls: 1 }).formatted).not.toContain('1 tool calls)');
      expect(fmt({ turns: 5, toolCalls: 5 }).formatted).toContain('5 turns, 5 tool calls)');
    });

    it('includes original output after status note', () => {
      expect(fmt({ output: 'Line 1\nLine 2' }).formatted).toContain('Line 1\nLine 2');
    });
  });

  describe('metrics line', () => {
    it('formats metrics after status note', () => {
      expect(fmt({ turns: 2, toolCalls: 3 }).formatted)
        .toContain('[Metrics: read=3, grep=2, find=0, edit=1, write=0, bash=5, ls=1, scopeViolations=0]');
    });

    it('metrics appear after status note but before output', () => {
      const lines = fmt({ output: 'Some output', turns: 2 }).formatted.split('\n');
      expect(stripAnsi(lines[0])).toMatch(/^✓ Completed/);
      expect(lines[1]).toMatch(/^\[Metrics:/);
    });

    it('reflects actual metric values', () => {
      const metrics: DelegationMetrics = {
        readCalls: 10, grepCalls: 5, findCalls: 2, editCalls: 3,
        writeCalls: 1, bashCalls: 8, lsCalls: 4, scopeViolations: 2,
      };
      const r = fmt({ metrics, toolCalls: 6 });
      expect(r.formatted).toContain('read=10');
      expect(r.formatted).toContain('scopeViolations=2');
    });
  });

  describe('error path', () => {
    it('appends error info when status is error', () => {
      const r = fmt({ output: 'Something went wrong during execution', toolCalls: 2, status: 'error' });
      expect(r.formatted).toContain('[Error: Something went wrong during execution]');
    });

    it('truncates error output to 200 chars', () => {
      const longOutput = 'x'.repeat(300);
      const r = fmt({ output: longOutput, status: 'error' });
      expect(r.formatted).toContain(`[Error: ${'x'.repeat(200)}]`);
      expect(r.formatted).not.toContain(`[Error: ${'x'.repeat(201)}]`);
    });

    it('does not append error info for ok status', () => {
      expect(fmt({ output: 'All good', status: 'ok' }).formatted).not.toContain('[Error:');
    });

    it('does not append error info for aborted status', () => {
      expect(fmt({ output: 'Interrupted', status: 'aborted' }).formatted).not.toContain('[Error:');
    });
  });

  describe('execution metadata', () => {
    it('includes elapsed, turns, and status', () => {
      expect(fmt({ elapsed: 5.2, turns: 3, toolCalls: 4 }).formatted)
        .toContain('[Execution: elapsed=5.2s, turns=3, status=ok]');
    });

    it('shows error status when status is error', () => {
      expect(fmt({ toolCalls: 1, status: 'error' }).formatted).toContain('status=error');
    });

    it('execution metadata appears after metrics line', () => {
      const r = fmt({ turns: 2, toolCalls: 3 });
      const metricsIdx = r.formatted.indexOf('[Metrics:');
      const execIdx = r.formatted.indexOf('[Execution:');
      expect(metricsIdx).toBeGreaterThanOrEqual(0);
      expect(execIdx).toBeGreaterThan(metricsIdx);
    });
  });

  describe('tool trail', () => {
    it('formats tool calls when trail provided', () => {
      const r = fmt({ toolCalls: 2, toolCallTrail: [
        { tool: 'bash', outputPreview: 'file.txt', completed: true },
        { tool: 'read', completed: true },
      ]});
      expect(r.formatted).toContain('[Tool Calls (2):');
      expect(stripAnsi(r.formatted)).toContain('✓ bash');
      expect(stripAnsi(r.formatted)).toContain('→ file.txt');
      expect(stripAnsi(r.formatted)).toContain('✓ read');
    });

    it('shows warning icon for incomplete tool calls', () => {
      const result = fmt({ toolCalls: 1, toolCallTrail: [{ tool: 'bash', completed: false }] }).formatted;
      expect(stripAnsi(result)).toContain('⚠ bash');
    });

    it('omits tool trail when no trail provided', () => {
      expect(fmt({ toolCalls: 3 }).formatted).not.toContain('[Tool Calls');
    });

    it('omits tool trail when empty array', () => {
      expect(fmt({ toolCalls: 3, toolCallTrail: [] }).formatted).not.toContain('[Tool Calls');
    });
  });

  describe('full chain', () => {
    it('formats complete chain with all components', () => {
      const output = `## Findings\n- summary: Bug found in auth\n- key_files: [auth.ts]\n- issues: [hardcoded secret]\n- recommendation: Fix auth\n\n## Audit\n- problems: [none]\n- resolution: [none]\n- scope_stayed: yes\n- scope_notes: ok\n`;
      const r = fmt({ output, elapsed: 5.2, turns: 3, toolCalls: 4, status: 'ok',
        toolCallTrail: [{ tool: 'read', outputPreview: 'auth.ts', completed: true }],
      });
      const lines = r.formatted.split('\n');
      expect(stripAnsi(lines[0])).toMatch(/^✓ Completed/);
      expect(lines[1]).toMatch(/^\[Metrics:/);
      expect(r.formatted).toContain('[Tool Calls (1):');
      expect(r.formatted).toContain('[Execution:');
      expect(r.formatted).toContain('[Findings: Bug found in auth]');
      expect(r.formatted).toContain('## Findings');
    });

    it('extracts findings into result object', () => {
      const output = `## Findings\n- summary: All clear\n- key_files: []\n- issues: []\n- recommendation: None\n`;
      const r = fmt({ output });
      expect(r.findings).not.toBeNull();
      expect(r.findings!.summary).toBe('All clear');
    });

    it('extracts audit into result object', () => {
      const output = `## Audit\n- problems: [tool error]\n- resolution: [retried]\n- scope_stayed: yes\n- scope_notes: ok\n`;
      const r = fmt({ output, toolCalls: 1 });
      expect(r.audit).not.toBeNull();
      expect(r.audit!.problems).toEqual(['tool error']);
      expect(r.audit!.scope_stayed).toBe(true);
    });

    it('returns null findings/audit when blocks absent', () => {
      const r = fmt({ output: 'Just plain output' });
      expect(r.findings).toBeNull();
      expect(r.audit).toBeNull();
    });

    it('order: status > metrics > trail > exec > findings > output', () => {
      const output = `## Findings\n- summary: Done\n- key_files: []\n- issues: []\n- recommendation: None\n\n## Audit\n- problems: [none]\n- resolution: [none]\n- scope_stayed: yes\n- scope_notes: ok\n`;
      const r = fmt({ output, turns: 2, toolCalls: 2,
        toolCallTrail: [{ tool: 'bash', completed: true }],
      });
      const i = (s: string) => stripAnsi(r.formatted).indexOf(s);
      const indices = [i('✓ Completed'), i('[Metrics:'), i('[Tool Calls'), i('[Execution:'), i('[Findings:'), i('## Findings')].filter(x => x >= 0);
      for (let idx = 1; idx < indices.length; idx++) {
        expect(indices[idx]).toBeGreaterThan(indices[idx - 1]);
      }
    });
  });
});
