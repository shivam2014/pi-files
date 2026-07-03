/**
 * Delegate result formatting — extracts metadata, findings, audit, metrics into output string.
 */

import type { DelegationMetrics } from "./types.ts";
import { formatMetricsLine } from "./types.ts";
import { extractFindingsFromOutput, extractAuditFromOutput } from "./delegate-output-formatter.ts";

/**
 * Format a successful subagent result with findings, metadata, trail, audit, metrics.
 */
function formatSuccess(
	output: string,
	metrics: DelegationMetrics,
	elapsedMs: number,
	toolCallTrail: any[],
	turns: number,
): string {
	let result = output;

	// Prepend findings summary
	const findings = extractFindingsFromOutput(result);
	if (findings && findings.summary) {
		const summaryParts = [`[Findings: ${findings.summary}]`];
		if (findings.key_files.length > 0) summaryParts.push(`Files: ${findings.key_files.join(', ')}`);
		if (findings.issues.length > 0 && findings.issues[0] !== 'none') summaryParts.push(`Issues: ${findings.issues.join('; ')}`);
		if (findings.recommendation) summaryParts.push(`Next: ${findings.recommendation}`);
		result = summaryParts.join('\n') + '\n\n' + result;
	}

	// Prepend execution metadata
	const execStatus = result?.startsWith("[error]") ? "error" : "ok";
	const execMeta = [`[Execution: elapsed=${(elapsedMs / 1000).toFixed(1)}s, turns=${turns}, status=${execStatus}]`];
	if (execStatus === "error") {
		execMeta.push(`[Error: ${result.slice(0, 200)}]`);
	}
	result = execMeta.join('\n') + '\n\n' + result;

	// Prepend tool call trail
	if (toolCallTrail && toolCallTrail.length > 0) {
		const trail = toolCallTrail.map(t =>
			`${t.completed ? '✓' : '⚠'} ${t.tool}${t.outputPreview ? ` → ${t.outputPreview}` : ''}`
		).join('\n');
		result = `[Tool Calls (${toolCallTrail.length}):\n${trail}\n]\n\n` + result;
	}

	// Extract and prepend audit trail
	const audit = extractAuditFromOutput(output);
	if (audit) {
		const auditParts: string[] = [];
		if (audit.problems.length > 0 && audit.problems[0] !== 'none') {
			auditParts.push(`Problems: ${audit.problems.join('; ')}`);
			auditParts.push(`Resolution: ${audit.resolution.join('; ')}`);
		}
		if (!audit.scope_stayed) {
			auditParts.push(`Scope deviation: ${audit.scope_notes}`);
			metrics.scopeViolations++;
		}
		if (auditParts.length > 0) {
			result = `[Audit: ${auditParts.join(' | ')}]\n` + result;
		}
	}

	// Prepend metrics line
	const metricsLine = formatMetricsLine(metrics);
	result = metricsLine + '\n' + result;

	// Status note
	const toolCalls = toolCallTrail?.length || 0;
	const turnWord = turns === 1 ? "turn" : "turns";
	const toolWord = toolCalls === 1 ? "tool call" : "tool calls";
	const statusNote = `✓ Completed (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;
	result = `${statusNote}\n${result}`;

	return result;
}

/**
 * Format an error/abort result with trail and status note.
 */
function formatErrorAbort(
	output: string,
	toolCallTrail: any[],
	turns: number,
	isAborted: boolean,
): string {
	const toolCalls = toolCallTrail?.length ?? 0;
	const turnWord = turns === 1 ? "turn" : "turns";
	const toolWord = toolCalls === 1 ? "tool call" : "tool calls";

	let trailStr = "";
	if (toolCallTrail && toolCallTrail.length > 0) {
		trailStr = "\nCompleted tool calls:\n" + toolCallTrail.map(t => `${t.completed ? '✓' : '⚠'} ${t.tool}`).join("\n");
	}

	const statusNote = isAborted
		? `■ Aborted — interrupted by user (${turns} ${turnWord}, ${toolCalls} ${toolWord})`
		: `✗ Error (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;

	return `${statusNote}${trailStr}\n\n${output}`;
}

/**
 * Process a delegate result into a formatted output string.
 * Pure function — no side effects.
 */
export function processDelegateResult(
	output: string,
	metrics: DelegationMetrics,
	elapsedMs: number,
	toolCallTrail: any[],
	turns: number,
	isAborted: boolean,
	isError: boolean,
): string {
	if (isAborted || isError) {
		return formatErrorAbort(output, toolCallTrail, turns, isAborted);
	}
	return formatSuccess(output, metrics, elapsedMs, toolCallTrail, turns);
}
