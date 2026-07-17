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
}

// Internal default context for backward-compat API (tests call without ctx)
const _defaultCtx = new FusionRunContext();

export function _resetTemperatureCacheForTests(ctx?: FusionRunContext): void {
	(ctx ?? _defaultCtx).temperaturePreferenceCache.clear();
}

// ─── Temperature fallback ────────────────────────────────
export async function tryCompleteWithTemperatureFallback(
	model: any,
	payload: any,
	options: any,
	ctx?: FusionRunContext,
): Promise<AssistantMessage> {
	const cache = (ctx ?? _defaultCtx).temperaturePreferenceCache;
	const modelId = model?.id ?? String(model);
	const cachedPreference = cache.get(modelId);
	const requestedTemperature = options?.temperature;

	if (cachedPreference === false) {
		return complete(model, payload, { ...options, temperature: undefined });
	}

	try {
		const result = await complete(model, payload, options);

		// Any error when temperature was set — retry once without it
		// (Some providers reject non-default temperatures, others wrap the error)
		if (requestedTemperature != null && result?.stopReason === "error") {
			debugLog("fusion-tool: retrying without temperature", { model: modelId, error: result.errorMessage });
			cache.set(modelId, false);
			return complete(model, payload, { ...options, temperature: undefined });
		}

		cache.set(modelId, true);
		return result;
	} catch (err: any) {
		if (requestedTemperature != null) {
			debugLog("fusion-tool: retrying without temperature", { model: modelId, error: err?.message ?? String(err) });
			cache.set(modelId, false);
			return complete(model, payload, { ...options, temperature: undefined });
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
	const cache = (ctx ?? _defaultCtx).temperaturePreferenceCache;
	const modelId = model?.id ?? String(model);

	// Fast path: already probed this session
	if (cache.has(modelId)) {
		return cache.get(modelId)!;
	}

	try {
		const auth = await registry.getApiKeyAndHeaders(model);
		const result = await complete(model, {
			messages: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: Date.now() }],
		}, {
			temperature,
			maxTokens: 10,
			timeoutMs: 10_000,
			apiKey: auth.apiKey,
			headers: auth.headers,
		});

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
	constructor(
		private registry: any,
		private config: Required<FusionConfig>,
		private ctx: FusionRunContext,
	) {}

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
			analysis = parseJudgeAnalysis(lastJudgeText);

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
				judgeMessages.push({
					role: "assistant",
					content: [{ type: "text", text: lastJudgeText }],
					timestamp: Date.now(),
				});
				judgeMessages.push({
					role: "user",
					content: [{ type: "text", text: `That response was invalid: ${parseError}. Return a single valid JSON object matching the required schema exactly.` }],
					timestamp: Date.now(),
				});
			}
		}

		judgeError = judgeError || (analysis ? undefined : `Judge failed to produce valid analysis after ${maxAttempts} attempts: ${lastParseError}`);
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
			const formatted = formatFusionResult(analysis, succeeded, failed, panelModels, judgeModel);
			return {
				content: [{ type: "text" as const, text: formatted }],
				details: {
					status: "ok",
					analysis,
					panelModels: panelModels.map((m: any) => `${m.provider}/${m.id}`),
					judgeModel: `${judgeModel.provider}/${judgeModel.id}`,
				},
			} as any;
		}
		return formatPanelResults(succeeded, failed, judgeModel, judgeError) as any;
	}
}
