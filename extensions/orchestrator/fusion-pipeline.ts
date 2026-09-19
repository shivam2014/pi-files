import { complete } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FusionConfig, FusionAnalysis } from "./types.ts";
import { debugLog } from "./debug.ts";
import { extractText, mapWithConcurrencyLimit } from "./fusion-utils.ts";
import { getDefaultReasoningEffort } from "./fusion-config.ts";
import { extractJsonObject, parseJudgeAnalysis } from "./fusion-judge.ts";
import { formatFusionResult, formatPanelResults } from "./fusion-format.ts";

// ─── FusionRunContext: per-execution state bag ─────────────
export class FusionRunContext {
	readonly temperaturePreferenceCache = new Map<string, boolean>();
	/** Session id used for provider attribution headers (captured by panelPhase). */
	sessionId?: string;
}

// Fallback temperature cache for the backward-compat free-function API (callers may
// omit ctx, e.g. tests). It holds ONLY cached temperature preferences keyed by model
// id — it deliberately does NOT carry a sessionId, so no run's attribution state can
// leak into another run through a shared module-level object.
const _fallbackTemperatureCache = new Map<string, boolean>();

function temperatureCacheFor(ctx?: FusionRunContext): Map<string, boolean> {
	return ctx?.temperaturePreferenceCache ?? _fallbackTemperatureCache;
}

export function _resetTemperatureCacheForTests(ctx?: FusionRunContext): void {
	temperatureCacheFor(ctx).clear();
}

// ─── Provider attribution headers (parity with pi's normal SDK path) ───
// pi-ai's complete() only emits `x-opencode-session` / `x-opencode-client` when
// the model sets compat.sendSessionAffinityHeaders; the opencode-go models do
// not, so a bare complete() reaches the gateway without the session header and
// gets 400 MissingSessionID. pi's own SDK provider wrapper injects the header
// explicitly (provider-attribution.ts getSessionHeaders). Fusion calls complete()
// directly, so it must inject the same headers itself — but ONLY for providers
// that require them.
const OPENCODE_HOST = "opencode.ai";

function matchesOpencodeHost(baseUrl: unknown): boolean {
	if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
	try {
		const host = new URL(baseUrl).hostname; // lowercased, port stripped
		// Match the apex host and any subdomain (*.opencode.ai), but NOT lookalikes
		// such as "opencode.ai.evil.com" or "notopencode.ai".
		return host === OPENCODE_HOST || host.endsWith(`.${OPENCODE_HOST}`);
	} catch {
		return false;
	}
}

/**
 * Build the session attribution headers pi's normal path would send for this
 * model + session. Returns undefined when no header applies (non-opencode
 * provider, or no sessionId) — callers then leave the request untouched.
 */
export function getSessionAttributionHeaders(model: any, sessionId?: string): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model?.provider !== "opencode" &&
		model?.provider !== "opencode-go" &&
		!matchesOpencodeHost(model?.baseUrl)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

/** Merge session attribution headers into a complete() options bag (no-op if not applicable). */
function withSessionAttributionHeaders(model: any, options: any, sessionId?: string): any {
	const sessionHeaders = getSessionAttributionHeaders(model, sessionId);
	if (!sessionHeaders) return options;
	return { ...options, headers: { ...sessionHeaders, ...(options?.headers ?? {}) } };
}

/**
 * Extract concatenated reasoning/thinking text from an assistant message.
 * Used to recover JSON a reasoning model emitted in a thinking block while the
 * visible text block was prose.
 */
function extractThinkingText(response: any): string {
	const content = Array.isArray(response?.content) ? response.content : [];
	return content
		.filter((c: any) => c?.type === "thinking" && typeof c.thinking === "string")
		.map((c: any) => c.thinking)
		.join("\n");
}

/**
 * Parse a judge response into a FusionAnalysis. Prefers the visible text blocks
 * (pi's extractText) but also recovers JSON that a reasoning model emitted inside
 * a `thinking` block while the text block was prose.
 */
export function parseJudgeFromResponse(response: any): FusionAnalysis | null {
	const fromText = parseJudgeAnalysis(extractText(response));
	if (fromText) return fromText;
	const thinking = extractThinkingText(response);
	if (thinking) return parseJudgeAnalysis(thinking);
	return null;
}

// ─── Temperature fallback ────────────────────────────────
export async function tryCompleteWithTemperatureFallback(
	model: any,
	payload: any,
	options: any,
	ctx?: FusionRunContext,
): Promise<AssistantMessage> {
	const cache = temperatureCacheFor(ctx);
	const modelId = model?.id ?? String(model);
	const cachedPreference = cache.get(modelId);
	const requestedTemperature = options?.temperature;

	// Session attribution (upfront). pi-ai's complete() does NOT emit
	// `x-opencode-session` for opencode-go models: its compat.sendSessionAffinityHeaders
	// path only sends `session_id` / `x-client-request-id` / `x-session-affinity` (the
	// wrong header names), so the gateway rejects the request with 400 MissingSessionID.
	// pi's normal SDK wrapper injects the attribution headers itself; fusion calls
	// complete() directly, so it injects the same headers on the FIRST request — no
	// doomed headerless attempt. No-op for providers that don't need them and when
	// sessionId is undefined.
	const completeWithAttribution = async (opts: any): Promise<AssistantMessage> => {
		const attributedOpts = withSessionAttributionHeaders(
			model,
			opts,
			opts?.sessionId ?? ctx?.sessionId,
		);
		return complete(model, payload, attributedOpts);
	};

	if (cachedPreference === false) {
		return completeWithAttribution({ ...options, temperature: undefined });
	}

	try {
		const result = await completeWithAttribution(options);

		// Any error when temperature was set — retry once without it
		// (Some providers reject non-default temperatures, others wrap the error)
		if (requestedTemperature != null && result?.stopReason === "error") {
			debugLog("fusion-tool: retrying without temperature", { model: modelId, error: result.errorMessage });
			cache.set(modelId, false);
			return completeWithAttribution({ ...options, temperature: undefined });
		}

		cache.set(modelId, true);
		return result;
	} catch (err: any) {
		if (requestedTemperature != null) {
			debugLog("fusion-tool: retrying without temperature", { model: modelId, error: err?.message ?? String(err) });
			cache.set(modelId, false);
			return completeWithAttribution({ ...options, temperature: undefined });
		}
		throw err;
	}
}

// ─── Pre-flight temperature probe ──────────────────────
/**
 * Proactively test whether a model accepts temperature.
 * Cached so each model is probed at most once per session.
 * Probe is minimal: short prompt, few tokens, short timeout.
 */
export async function probeTemperatureSupport(
	model: any,
	temperature: number,
	registry: any,
	ctx?: FusionRunContext,
): Promise<boolean> {
	const cache = temperatureCacheFor(ctx);
	const modelId = model?.id ?? String(model);

	// Fast path: already probed this session
	if (cache.has(modelId)) {
		return cache.get(modelId)!;
	}

	try {
		const auth = await registry.getApiKeyAndHeaders(model);
		const result = await complete(model, {
			messages: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: Date.now() }],
		}, withSessionAttributionHeaders(model, {
			temperature,
			maxTokens: 10,
			timeoutMs: 10_000,
			apiKey: auth.apiKey,
			headers: auth.headers,
		}, ctx?.sessionId));

		if (result?.stopReason === "error") {
			cache.set(modelId, false);
			return false;
		}

		cache.set(modelId, true);
		return true;
	} catch {
		cache.set(modelId, false);
		return false;
	}
}

// ─── Panel Model Runner ────────────────────────

async function runPanelModel(
	model: any,
	systemPrompt: string,
	userPrompt: string,
	config: { maxTokens: number; temperature: number },
	registry: any,
	signal?: AbortSignal,
	onUpdate?: (update: {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	}) => void,
	sessionId?: string,
	ctx?: FusionRunContext,
): Promise<{ model: string; content?: string; reports?: string[]; error?: string }> {
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return { model: model.id, error: "No API key configured" };
	}

	const messages: any[] = [
		{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() },
	];
	const modelId = model.id;
	debugLog("fusion-tool: panel model start", { model: modelId });

	try {
		const response = await tryCompleteWithTemperatureFallback(model, {
			systemPrompt,
			messages,
		}, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			sessionId,
			reasoningEffort: model.reasoning ? getDefaultReasoningEffort(model) : undefined,
			timeoutMs: 30_000,
		}, ctx);

		// Handle error/aborted responses
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			const errMsg = (response as any).errorMessage || `Model stopped: ${response.stopReason}`;
			debugLog("fusion-tool: panel model stopped", { model: modelId, stopReason: response.stopReason, error: errMsg });
			return { model: modelId, error: errMsg };
		}

		// Extract text response (matches judge pattern)
		const text = extractText(response);
		if (!text) {
			debugLog("fusion-tool: panel model returned empty response", { model: modelId, contentTypes: response.content?.map((c: any) => c.type) });
			return { model: modelId, error: "Empty response from model" };
		}

		const reports = [text];

		onUpdate?.({
			content: [{ type: "text", text: `  ── Panel: ${modelId} ──\n  ✓ ${text}` }],
			details: { phase: "panel_reports", model: modelId, count: 1 },
		});

		debugLog("fusion-tool: panel model complete", { model: modelId, textLength: text.length, reports: 1 });
		return { model: modelId, content: text, reports };

	} catch (err: any) {
		debugLog("fusion-tool: panel model error", { model: modelId, error: err.message ?? String(err) });
		return { model: modelId, error: err.message ?? String(err) };
	}
}

// ─── FusionPipeline ───────────────────────────────────────
export class FusionPipeline {
	private ctx: FusionRunContext;

	constructor(
		private registry: any,
		private config: Required<FusionConfig>,
		ctx?: FusionRunContext,
	) {
		// Always own a per-instance context: two pipelines constructed without an
		// explicit ctx must never share session-attribution state (the old
		// module-global default `_defaultCtx` leaked one run's sessionId to another).
		this.ctx = ctx ?? new FusionRunContext();
	}

	/**
	 * Phase 1: Run panel models with concurrency limit of 2.
	 * Returns succeeded (models with content) and failed models.
	 */
	async panelPhase(
		panelModels: any[],
		systemPrompt: string,
		userPrompt: string,
		signal?: AbortSignal,
		onUpdate?: any,
		sessionId?: string,
	): Promise<{ succeeded: any[]; failed: any[] }> {
		// Capture the session id so subsequent phases (judge/probe) can attach the
		// same attribution headers without threading an extra parameter.
		if (sessionId) this.ctx.sessionId = sessionId;
		const panelResults = await mapWithConcurrencyLimit(panelModels, 2, async (model: any) => {
			onUpdate?.({
				content: [{ type: "text", text: `  ⏳ Panel: ${model.id}...` }],
				details: { phase: "panel_running", model: model.id },
			});
			const result = await runPanelModel(model, systemPrompt, userPrompt, {
				maxTokens: this.config.maxTokensPerPanel,
				temperature: this.config.temperature,
			}, this.registry, signal, onUpdate,
				sessionId,
				this.ctx,
			);
			const statusIcon = result.error ? "✗" : "✓";
			onUpdate?.({
				content: [{ type: "text", text: `  ${statusIcon} Panel: ${model.id}${result.error ? ` — ${result.error}` : ""}` }],
				details: { phase: "panel_complete", model: model.id, status: result.error ? "error" : "success" },
			});
			return result;
		});

		const succeeded = panelResults.filter((r: any) => r.content && !r.error);
		const failed = panelResults.filter((r: any) => r.error || !r.content);

		return { succeeded, failed };
	}

	/**
	 * Phase 2: Judge synthesizes panel responses into structured analysis.
	 * Retries up to 3 times on parse failures.
	 */
	async judgePhase(
		succeeded: any[],
		judgeModel: any,
		signal?: AbortSignal,
		onUpdate?: any,
	): Promise<{ analysis: FusionAnalysis | null; judgeError?: string; lastJudgeText: string }> {
		const judgeSystemPrompt = `You are a planning judge. Analyze the panel responses below and produce a structured JSON analysis.

Return valid JSON ONLY with these fields:
- "consensus": ["list of points all models agree on"]
- "contradictions": [{"topic": "...", "stances": [{"model": "...", "stance": "..."}]}]
- "unique_insights": [{"model": "...", "insight": "..."}]
- "blind_spots": ["things none of the models addressed"]
- "recommendations": ["synthesized best approach based on all responses"]`;

		const judgePrompt = "## Panel Responses\n\n" +
			succeeded.map((r: any) => `### ${r.model}\n${r.content}`).join("\n\n") +
			"\n\nReturn JSON analysis:";

		const auth = await this.registry.getApiKeyAndHeaders(judgeModel);
		if (!auth.ok || !auth.apiKey) {
			const judgeError = "No API key configured";
			debugLog("fusion-tool: judge model not authenticated", { model: judgeModel.id, error: judgeError });
			return { analysis: null, judgeError, lastJudgeText: "" };
		}

		const judgeMessages: any[] = [
			{ role: "user", content: [{ type: "text", text: judgePrompt }], timestamp: Date.now() },
		];

		let analysis: FusionAnalysis | null = null;
		let lastJudgeText = "";
		const maxAttempts = 3;

		let judgeError: string | undefined;
		let lastParseError = "";
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			onUpdate?.({
				content: [{ type: "text", text: `  ⚡ Judge (${judgeModel.id}) — attempt ${attempt}/3...` }],
				details: { phase: "judge_attempt", model: judgeModel.id, attempt, maxAttempts: 3 },
			});
			debugLog("fusion-tool: judge attempt", { model: judgeModel.id, attempt, maxAttempts });
			let judgeResponse;
			try {
				judgeResponse = await tryCompleteWithTemperatureFallback(judgeModel, {
					systemPrompt: judgeSystemPrompt,
					messages: judgeMessages,
				}, {
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: signal ?? undefined,
					maxTokens: this.config.maxTokensForJudge,
					temperature: 0.2,
					reasoningEffort: judgeModel.reasoning ? getDefaultReasoningEffort(judgeModel) : undefined,
					timeoutMs: 60_000,
				}, this.ctx);
			} catch (err: any) {
				judgeError = err.message ?? String(err);
				debugLog("fusion-tool: judge attempt failed", { model: judgeModel.id, attempt, error: judgeError });
				break;
			}

			lastJudgeText = extractText(judgeResponse);
			analysis = parseJudgeFromResponse(judgeResponse);

			if (analysis) {
				debugLog("fusion-tool: judge analysis parsed", { model: judgeModel.id, attempt });
				break;
			}

			const parseError = extractJsonObject(lastJudgeText)
				? "JSON was found but did not match the required schema"
				: "No valid JSON object found";
			lastParseError = parseError;
			debugLog("fusion-tool: judge parse failure", { model: judgeModel.id, attempt, error: parseError });

			if (attempt < maxAttempts) {
				// Change the request on retry: echo the rejected reply and issue a
				// stricter instruction (JSON first, no prose). Attempt 2's body must
				// differ from attempt 1's.
				judgeMessages.push({
					role: "assistant",
					content: [{ type: "text", text: lastJudgeText }],
					timestamp: Date.now(),
				});
				judgeMessages.push({
					role: "user",
					content: [{ type: "text", text: `Your previous reply was not valid JSON (${parseError}). Output the JSON object as the very FIRST characters of your reply — no prose before or after. Emit exactly one object with keys: consensus, contradictions, unique_insights, blind_spots, recommendations.` }],
					timestamp: Date.now(),
				});
			}
		}

		if (!analysis && !judgeError) {
			judgeError = `Judge failed to produce valid analysis after ${maxAttempts} attempts: ${lastParseError}`;
		}

		// Fail-soft: the judge responded (transport succeeded) but never produced
		// parseable JSON. Do NOT discard the panel result — return a degraded but
		// non-null analysis so the pipeline still surfaces panel content, and keep
		// the judge error recorded. If the judge call itself failed (no text), the
		// null analysis path is preserved so the caller falls back to panel output.
		if (!analysis && lastJudgeText.trim()) {
			debugLog("fusion-tool: judge fail-soft, preserving panel result", { model: judgeModel.id, error: judgeError });
			analysis = {
				consensus: [],
				contradictions: [],
				unique_insights: [],
				blind_spots: [],
				recommendations: [],
			};
		}

		return { analysis, judgeError, lastJudgeText };
	}

	/**
	 * Phase 3: Format the final result for the tool response.
	 */
	formatPhase(
		analysis: FusionAnalysis | null,
		succeeded: any[],
		failed: any[],
		panelModels: any[],
		judgeModel: any,
		judgeError?: string,
	): any {
		if (analysis) {
			debugLog("fusion-pipeline: final analysis shape", {
				consensusCount: analysis.consensus.length,
				contradictionsCount: analysis.contradictions.length,
				uniqueInsightsCount: analysis.unique_insights.length,
				blindSpotsCount: analysis.blind_spots.length,
				recommendationsCount: analysis.recommendations.length,
			});
			let formatted = formatFusionResult(analysis, succeeded, failed, panelModels, judgeModel);
			if (judgeError) {
				formatted += `\n\n*(Judge returned no structured analysis — ${judgeError})*`;
			}
			return {
				content: [{ type: "text" as const, text: formatted }],
				details: {
					status: "ok",
					analysis,
					panelModels: panelModels.map((m: any) => `${m.provider}/${m.id}`),
					judgeModel: `${judgeModel.provider}/${judgeModel.id}`,
					...(judgeError ? { judgeError } : {}),
				},
			} as any;
		}
		return formatPanelResults(succeeded, failed, judgeModel, judgeError) as any;
	}
}
