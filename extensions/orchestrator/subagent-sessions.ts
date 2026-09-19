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

export interface BlockedToolCall {
  /** Name of the tool that was blocked (e.g., "write", "edit", "bash") */
  tool: string;
  /** The file path that was targeted */
  target: string;
  /** Why it was blocked */
  reason: string;
  /** When the block occurred */
  timestamp: number;
}

export interface SubagentState {
  /** Name of the specialist running in this subagent session */
  specialistName: string;
  /** Whether the subagent has called planSteps() at least once */
  planParsed: boolean;
  /** Tool calls blocked by the scope guard during this session */
  blockedCalls: BlockedToolCall[];
  /**
   * Per-delegation scope id for THIS subagent session. Set by the runner when it
   * creates the session (threaded from the delegate pipeline's
   * createDelegationScope()). The scope guard resolves this session's own
   * ~/.pi/agent/scopes/<delegationId>.json instead of the shared
   * <cwd>/.pi/scope.json, which prevents a concurrent sibling delegation from
   * being validated against the wrong scope (cross-delegation permit).
   * Optional so unwired/test states fall back to the shared-file contract.
   */
  delegationId?: string;
  /**
   * The delegation's authoritative working directory — the cwd the subagent's
   * AgentSession was created with (SubagentRunner.run → createSession({ cwd })).
   * The scope guard resolves relative tool paths against THIS, not the
   * process/orchestrator cwd: the tool_call `ctx.cwd` can be the orchestrator
   * (or the bare process) cwd, which would resolve a subagent's relative path
   * into the wrong tree and produce false-positive scope blocks (Defect A).
   * Set by the runner at session creation; absent only for unwired/test states.
   */
  cwd?: string;
}

/**
 * Authoritative source of truth for subagent session routing.
 * Key = session ID from ctx.sessionManager.getSessionId()
 * Value = per-session state (specialist name, plan status)
 */
export const subagentSessions = new Map<string, SubagentState>();
