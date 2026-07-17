/**
 * Per-session subagent state — concurrent-safe replacement for module-level
 * _batchLoadSubagent, _planParsed, PI_SPECIALIST_NAME.
 *
 * Each subagent session registers an entry keyed by sessionId when runSubagent()
 * starts, and removes it in the finally block when the run completes.
 *
 * The unified tool_call handler in index.ts checks this Map via
 * ctx.sessionManager.getSessionId() to route tool calls to the correct
 * enforcement path.
 */

export interface SubagentState {
  /** Name of the specialist running in this subagent session */
  specialistName: string;
  /** Whether the subagent has called planSteps() at least once */
  planParsed: boolean;
}

/**
 * Authoritative source of truth for subagent session routing.
 * Key = session ID from ctx.sessionManager.getSessionId()
 * Value = per-session state (specialist name, plan status)
 */
export const subagentSessions = new Map<string, SubagentState>();
