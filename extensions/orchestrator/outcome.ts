/**
 * Canonical delegation outcome taxonomy — the vocabulary for how a delegation
 * can terminate. This is the SSOT enum that the intervention state machine and
 * callers will use when wiring termination later. Nothing here triggers
 * termination yet; it only defines the states.
 *
 * Notes on scope:
 *  - These are TERMINAL states (the delegation has ended / been classified).
 *  - `stalled_no_progress` is an AGENT-level outcome (the agent is not making
 *    observable progress). It must never be emitted for a provider/infra fault —
 *    those route to `provider_failure` instead (see PROVIDER_FAILURE_KIND).
 *  - `blocked` covers scope/guard-blocked tool calls and unresolvable clarifications.
 *  - `incomplete` covers a clean early stop with steps left over (not an error).
 */
export const DELEGATION_OUTCOME = {
	DONE: "done",
	PROVIDER_FAILURE: "provider_failure",
	STALLED_NO_PROGRESS: "stalled_no_progress",
	RESOURCE_LIMIT: "resource_limit",
	BLOCKED: "blocked",
	INCOMPLETE: "incomplete",
} as const;

export type DelegationOutcome = (typeof DELEGATION_OUTCOME)[keyof typeof DELEGATION_OUTCOME];

/** Human-readable label per outcome (for status messages / audits). */
export const DELEGATION_OUTCOME_LABEL: Record<DelegationOutcome, string> = {
	done: "Completed",
	provider_failure: "Provider/infrastructure failure",
	stalled_no_progress: "Stalled (no observable progress)",
	resource_limit: "Hit resource/turn/budget limit",
	blocked: "Blocked (scope/guard/clarification)",
	incomplete: "Stopped before completion",
};

/**
 * Provider/infrastructure failure taxonomy — a SEPARATE axis from agent-level
 * stuckness. Provider faults (5xx, rate-limit, transport timeout, auth, dns...)
 * are infrastructure problems, not agent behaviour, and they must NEVER be
 * classified as `stalled_no_progress`.
 *
 * Retries/backoff for these belong OUTSIDE the agent loop: a provider retry
 * must not consume agent turns.
 */
export const PROVIDER_FAILURE_KIND = {
	HTTP_5XX: "http_5xx",
	RATE_LIMIT: "rate_limit",
	TRANSPORT_TIMEOUT: "transport_timeout",
	AUTH: "auth",
	OTHER_TRANSPORT: "other_transport",
} as const;

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KIND)[keyof typeof PROVIDER_FAILURE_KIND];

/**
 * (kind, regex) pairs tested in priority order against a result/error string.
 *
 * These patterns must only fire on GENUINE provider/infra faults. A bare
 * "Permission denied" (bash chmod/exec), a generic "timeout" in tool output,
 * or an unanchored "503" inside test results are AGENT-level errors: if they
 * matched here they would be routed to the provider taxonomy and mask real
 * agent stuckness (the detector never marks STALLED for provider failures).
 * Hence every pattern is anchored to transport/provider vocabulary.
 */
const PROVIDER_PATTERNS: Array<[ProviderFailureKind, RegExp]> = [
	// AUTH — requires explicit credential/provider context. A bare "permission
	// denied" is far more often a chmod/exec failure, so it does NOT match alone.
	[PROVIDER_FAILURE_KIND.AUTH, /\b(401|403)\b|unauthori[sz]ed|authentication (denied|failed)|invalid (api key|token)|missing credentials|(?:api|oauth|bearer|token|api[- ]key|credential\w*|openai|anthropic)[\s\S]{0,40}\bpermission denied\b|\bpermission denied\b[\s\S]{0,40}(?:api|provider|token|api[- ]key|credential)\b/i],
	[PROVIDER_FAILURE_KIND.RATE_LIMIT, /\brate[- ]?limit|429\b|too many requests|quota (exceeded|reached)|throttl|exceeded (your|the) (current )?quota/i],
	// TRANSPORT_TIMEOUT — must name a transport-level timeout (socket/connection/
	// request/gateway/deadline/504). Generic "timeout"/"timed out" from a test or
	// CLI command stays agent-level.
	[PROVIDER_FAILURE_KIND.TRANSPORT_TIMEOUT, /\betimedout\b|\besockettimedout\b|\b(?:connection|request|gateway|socket|read|idle|operation) timed? ?out\b|\bgateway timeout\b|\bdeadline (?:has been )?exceeded\b|\b504\b/i],
	// HTTP_5XX — 5xx codes require a provider-context anchor (api/upstream/gateway/
	// server/proxy/http); canonical provider phrases still match on their own. A
	// bare "500"/"502"/"503" inside tool/test output stays agent-level.
	[PROVIDER_FAILURE_KIND.HTTP_5XX, /\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\b(?:api|upstream|gateway|server|proxy|http)\b[\s\S]{0,60}?\b(5\d\d)\b|\b(5\d\d)\b[\s\S]{0,60}?(?:\berror\b|\bresponse\b|\bfrom (?:the )?(?:api|server|upstream|gateway)\b)/i],
	[PROVIDER_FAILURE_KIND.OTHER_TRANSPORT, /\b(connect|socket|network|dns|lookup|fetch failed|tls|ssl|reset|refused)\b[\s\S]{0,60}\b(error|failed|refused|reset|unreachable)\b/i],
];

/**
 * Pure classifier: inspect a tool/provider result string and return the provider
 * failure kind it encodes, or null if it is not a provider/infra failure.
 *
 * This is the SSOT seam for separating provider faults from agent-level errors:
 * only strings matching these patterns are routed to `provider_failure`.
 */
export function classifyProviderFailure(text: string | null | undefined): ProviderFailureKind | null {
	if (!text) return null;
	for (const [kind, re] of PROVIDER_PATTERNS) {
		if (re.test(text)) return kind;
	}
	return null;
}
