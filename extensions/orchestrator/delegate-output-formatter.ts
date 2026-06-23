import type { DelegationMetrics } from "./types";

export interface FormatResultInput {
  output: string;
  metrics: DelegationMetrics;
  elapsed: number;
  turns: number;
  toolCalls: number;
  status: 'ok' | 'error' | 'aborted';
  toolCallTrail?: { tool: string; outputPreview?: string; completed: boolean }[];
}

export interface FormatResultOutput {
  formatted: string;
  findings: { summary: string; key_files: string[]; issues: string[]; recommendation: string } | null;
  audit: { problems: string[]; resolution: string[]; scope_stayed: boolean; scope_notes: string } | null;
}

export function extractFindingsFromOutput(output: string): { summary: string; key_files: string[]; issues: string[]; recommendation: string } | null {
    const findingsMatch = output.match(/##\s+Findings\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
    if (!findingsMatch) return null;
    const block = findingsMatch[1];
    const extract = (key: string): string => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*(.+)`, 'i'));
        return m ? m[1].trim() : '';
    };
    const extractList = (key: string): string[] => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*\\[?(.+?)\\]?\\s*$`, 'im'));
        if (!m) return [];
        const inner = m[1].trim();
        if (inner === ']' || inner === '') return [];
        return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    };
    return {
        summary: extract('summary') || '',
        key_files: extractList('key_files'),
        issues: extractList('issues'),
        recommendation: extract('recommendation') || '',
    };
}

export function extractAuditFromOutput(output: string): { problems: string[]; resolution: string[]; scope_stayed: boolean; scope_notes: string } | null {
    const auditMatch = output.match(/##\s+Audit\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
    if (!auditMatch) return null;
    const block = auditMatch[1];
    const extractList = (key: string): string[] => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*\\[?(.+?)\\]?\\s*$`, 'im'));
        if (!m) return [];
        const inner = m[1].trim();
        if (inner === ']' || inner === '') return [];
        return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    };
    const extract = (key: string): string => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*(.+)`, 'i'));
        return m ? m[1].trim() : '';
    };
    const scopeStayed = extract('scope_stayed').toLowerCase();
    return {
        problems: extractList('problems'),
        resolution: extractList('resolution'),
        scope_stayed: scopeStayed === 'yes' || scopeStayed === 'true',
        scope_notes: extract('scope_notes') || '',
    };
}

export function formatResult(input: FormatResultInput): FormatResultOutput {
    const turns = input.turns || 0;
    const turnWord = turns === 1 ? 'turn' : 'turns';
    const toolCount = input.toolCalls || 0;
    const toolWord = toolCount === 1 ? 'tool call' : 'tool calls';

    let statusNote: string;
    switch (input.status) {
        case 'ok':
            statusNote = `✓ Completed (${turns} ${turnWord}, ${toolCount} ${toolWord})`;
            break;
        case 'aborted':
            statusNote = `■ Aborted — interrupted by user (${turns} ${turnWord}, ${toolCount} ${toolWord})`;
            break;
        case 'error':
            statusNote = `✗ Error (${turns} ${turnWord}, ${toolCount} ${toolWord})`;
            break;
    }

    const m = input.metrics;
    const metricsLine = `[Metrics: read=${m.readCalls}, grep=${m.grepCalls}, find=${m.findCalls}, edit=${m.editCalls}, write=${m.writeCalls}, bash=${m.bashCalls}, ls=${m.lsCalls}, scopeViolations=${m.scopeViolations}]`;

    const execStatus = input.status === 'error' ? 'error' : 'ok';
    const execMeta = `[Execution: elapsed=${input.elapsed.toFixed(1)}s, turns=${turns}, status=${execStatus}]`;

    let trailBlock = '';
    if (input.toolCallTrail && input.toolCallTrail.length > 0) {
        const trail = input.toolCallTrail.map(t =>
            `${t.completed ? '✓' : '⚠'} ${t.tool}${t.outputPreview ? ` → ${t.outputPreview}` : ''}`
        ).join('\n');
        trailBlock = `[Tool Calls (${input.toolCallTrail.length}):\n${trail}\n]\n\n`;
    }

    // Extract structured findings and audit from output
    const findings = extractFindingsFromOutput(input.output);
    const audit = extractAuditFromOutput(input.output);

    // Prepend findings summary line
    let output = input.output;
    if (findings && findings.summary) {
        const summaryParts = [`[Findings: ${findings.summary}]`];
        if (findings.key_files.length > 0) summaryParts.push(`Files: ${findings.key_files.join(', ')}`);
        if (findings.issues.length > 0 && findings.issues[0] !== 'none') summaryParts.push(`Issues: ${findings.issues.join('; ')}`);
        if (findings.recommendation) summaryParts.push(`Next: ${findings.recommendation}`);
        output = summaryParts.join('\n') + '\n\n' + output;
    }

    // Prepend audit line when problems or scope deviation
    if (audit) {
        const auditParts: string[] = [];
        if (audit.problems.length > 0 && audit.problems[0] !== 'none') {
            auditParts.push(`Problems: ${audit.problems.join('; ')}`);
            auditParts.push(`Resolution: ${audit.resolution.join('; ')}`);
        }
        if (!audit.scope_stayed) {
            auditParts.push(`Scope deviation: ${audit.scope_notes}`);
        }
        if (auditParts.length > 0) {
            output = `[Audit: ${auditParts.join(' | ')}]\n` + output;
        }
    }

    let formatted = `${statusNote}\n${metricsLine}\n${trailBlock}${execMeta}\n\n${output}`;

    if (input.status === 'error') {
        formatted += `\n\n[Error: ${input.output.slice(0, 200)}]`;
    }

    return {
        formatted,
        findings,
        audit,
    };
}
