/**
 * Subagent diagnostic capture + persist. No UI notifications, no plan step updates.
 */

import type { SubagentDiagnostic, DelegationMetrics, DelegateControllerContext } from "./types.ts";
import { captureDiagnostic, isDiagnosticsEnabled, persistDiagnostic, cleanupOldDiagnostics } from "./subagent-diagnostics.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug.ts";

/**
 * Capture and persist diagnostic if diagnostics are enabled and subagent failed.
 *
 * Returns the diagnostic (or null) — caller decides what to do with UI/display.
 * Does NOT call ctx.ui.notify, updatePlanStepDetail, or recordTimelineFrame.
 */
export function handleDiagnostics(
	result: any,
	specialistName: string,
	task: string,
	ctx: DelegateControllerContext,
	metrics: DelegationMetrics,
	startTime: number,
): SubagentDiagnostic | null {
	if (!isDiagnosticsEnabled()) return null;

	const diagnostic = captureDiagnostic({
		output: result?.output || '',
		turns: result?.turns || 0,
		toolCallTrail: result?.toolCallTrail || [],
		elapsedMs: Date.now() - startTime,
		specialist: specialistName,
		task,
		sessionId: ctx.sessionId || 'unknown',
		metrics,
		agentDir: getAgentDir(),
		model: result?.model,
		stopReason: result?.stopReason,
		errorMessage: result?.errorMessage,
	});

	if (!diagnostic) return null;

	debugLog('[diagnostic]', diagnostic.specialist, diagnostic.turns, diagnostic.toolCalls);

	// Persist to disk
	try {
		const filePath = persistDiagnostic(getAgentDir(), diagnostic);
		debugLog('[diagnostic] persisted to', filePath);
	} catch (e) {
		debugLog('[diagnostic] persist failed', e);
	}

	// Cleanup old diagnostics (non-blocking best-effort)
	try {
		const cleaned = cleanupOldDiagnostics(getAgentDir(), 30);
		if (cleaned > 0) debugLog('[diagnostic] cleaned', cleaned, 'old directories');
	} catch (e) {
		debugLog('[diagnostic] cleanup failed', e);
	}

	return diagnostic;
}
