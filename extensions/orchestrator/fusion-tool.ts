import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FusionConfig, FusionAnalysis } from "./types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { debugLog } from "./debug.ts";
import { extractText, mapWithConcurrencyLimit } from "./fusion-utils.ts";
import { getDefaultReasoningEffort, sanitizeFusionConfig, loadFusionConfig, saveFusionConfig } from "./fusion-config.ts";
import { extractJsonObject, parseJudgeAnalysis } from "./fusion-judge.ts";
import { formatFusionResult, formatPanelResults } from "./fusion-format.ts";
import { resolveModels, resolveOneModel, autoDiversePanel } from "./fusion-models.ts";
export { getDefaultReasoningEffort, sanitizeFusionConfig, loadFusionConfig, saveFusionConfig } from "./fusion-config.ts";
export { extractJsonObject, parseJudgeAnalysis } from "./fusion-judge.ts";
export { formatFusionResult, formatPanelResults } from "./fusion-format.ts";
export { resolveModels, resolveOneModel, autoDiversePanel } from "./fusion-models.ts";

// ─── Per-model temperature preference cache ────────────────
// true  = model accepted the requested temperature
// false = model rejected temperature; omit it on subsequent calls
const temperaturePreferenceCache = new Map<string, boolean>();

export function _resetTemperatureCacheForTests(): void {
	temperaturePreferenceCache.clear();
}

export function _resetFusionRegistrationsForTests(): void {
	_fusionRegistrations.clear();
}

export async function tryCompleteWithTemperatureFallback(
	model: any,
	payload: any,
	options: any,
): Promise<AssistantMessage> {
	const modelId = model?.id ?? String(model);
	const cachedPreference = temperaturePreferenceCache.get(modelId);
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
			temperaturePreferenceCache.set(modelId, false);
			return complete(model, payload, { ...options, temperature: undefined });
		}

		temperaturePreferenceCache.set(modelId, true);
		return result;
	} catch (err: any) {
		if (requestedTemperature != null) {
			debugLog("fusion-tool: retrying without temperature", { model: modelId, error: err?.message ?? String(err) });
			temperaturePreferenceCache.set(modelId, false);
			return complete(model, payload, { ...options, temperature: undefined });
		}
		throw err;
	}
}

// ─── Fusion registration state, keyed by cwd ─────────────
const _fusionRegistrations = new Map<string, { registered: boolean; config: Required<FusionConfig> }>();

// ─── Report-Finding Tool (for panel models) ─────────────

const reportFindingTool = {
	name: "reportFinding",
	description: "Report each distinct finding, key insight, or recommendation during your analysis. You MUST call this tool once for every separate point you identify; do not group multiple findings into a single call.",
	parameters: Type.Object({
		finding: Type.String({ description: "The key finding, insight, or recommendation" }),
	}),
};

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
): Promise<{ model: string; content?: string; reports?: string[]; error?: string }> {
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return { model: model.id, error: "No API key configured" };
	}

	const messages: any[] = [
		{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() },
	];
	const reports: string[] = [];
	const assistantTextParts: string[] = [];
	const modelId = model.id;
	debugLog("fusion-tool: panel model start", { model: modelId });
	const maxLoops = 10;
	let loopCount = 0;

	while (true) {
		loopCount++;
		if (loopCount > maxLoops) {
			const currentText = assistantTextParts.join("\n");
			debugLog("fusion-tool: panel model exceeded max loops", { model: modelId, loops: loopCount, textLength: currentText.length });
			if (currentText || reports.length > 0) {
				return { model: modelId, content: currentText || reports.join("\n"), reports: [...reports, "Error: Max iterations exceeded"] };
			}
			return { model: modelId, error: "Max iterations exceeded" };
		}

		try {
			const response = await tryCompleteWithTemperatureFallback(model, {
				systemPrompt,
				messages,
				tools: [reportFindingTool],
			}, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal,
				maxTokens: config.maxTokens,
				temperature: config.temperature,
				sessionId,
				reasoningEffort: model.reasoning ? getDefaultReasoningEffort(model) : undefined,
				timeoutMs: 30_000,
			});

			// Handle error/aborted responses
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				const errMsg = (response as any).errorMessage || `Model stopped: ${response.stopReason}`;
				debugLog("fusion-tool: panel model stopped", { model: modelId, stopReason: response.stopReason, error: errMsg });
				return { model: modelId, error: errMsg };
			}

			// Preserve any assistant text present in this response
			const responseText = extractText(response);
			if (responseText) {
				assistantTextParts.push(responseText);
			}

			const toolCalls = response.content?.filter((c: any) => c.type === "toolCall") || [];

			if (toolCalls.length > 0) {
				// Push assistant response with tool_calls first (required by OpenAI/DeepSeek format)
				messages.push(response);

				for (const tc of toolCalls) {
					const toolCall = tc as any;
					if (toolCall.name === "reportFinding") {
						const finding = toolCall.arguments?.finding || "";
						reports.push(finding);
					}
					messages.push({
						role: "toolResult" as const,
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text" as const, text: "✓ Reported" }],
						isError: false,
						timestamp: Date.now(),
					} as any);
				}
				// Continue loop to get final text
				continue;
			}

			// No tool calls — use all collected assistant text
			const text = assistantTextParts.join("\n");
			if (!text) {
				debugLog("fusion-tool: panel model returned empty response", { model: modelId, contentTypes: response.content?.map((c: any) => c.type) });
				return { model: modelId, error: "Empty response from model" };
			}

			// Deterministic fallback: ensure every panelist contributes at least one finding
			if (reports.length === 0) {
				reports.push(text);
			}

			if (reports.length > 0) {
				const reportLines = reports.map(r => `  ✓ ${r}`).join("\n");
				onUpdate?.({
					content: [{ type: "text", text: `  ── Panel: ${modelId} ──\n${reportLines}` }],
					details: { phase: "panel_reports", model: modelId, count: reports.length },
				});
			}
			debugLog("fusion-tool: panel model complete", { model: modelId, textLength: text.length, reports: reports.length });
			return { model: modelId, content: text, reports };

		} catch (err: any) {
			debugLog("fusion-tool: panel model error", { model: modelId, error: err.message ?? String(err) });
			return { model: modelId, error: err.message ?? String(err) };
		}
	}
}

/**
 * Register the fusion tool. Called once during extension init.
 *
 * IMPORTANT: Does NOT call pi.getAllTools() or pi.unregisterTool().
 * Those APIs mutate the tool registry, which changes prompt serialization
 * order and destroys prefix cache reuse across turns.
 *
 * Always registers the tool (idempotent). Visibility is controlled
 * entirely by setActiveTools() in before_agent_start.
 */
export function registerFusionTool(pi: ExtensionAPI, cwd: string): void {
	const config = loadFusionConfig(cwd);
	const existing = _fusionRegistrations.get(cwd);

	// Idempotent: skip if already registered for this cwd.
	if (existing?.registered) return;

	const parameters = Type.Object({
		context: Type.String({
			description: "Research findings, code analysis, or context for the panel to consider",
		}),
		task: Type.String({
			description: "What you want the panel to do (e.g., 'Create an execution plan', 'Critique my approach')",
		}),
		draft_plan: Type.Optional(Type.String({
			description: "Your preliminary plan for the panel to critique",
		})),
	});

	type FusionParams = Static<typeof parameters>;

	pi.registerTool({
		name: "fusion",
		label: "Fusion",
		description: "Multi-model analysis tool. Runs prompt against panel of models, then judge synthesizes into analysis. Call this for decisions.",
		parameters,

		promptSnippet: "Get multi-model advice by running a prompt against a panel of models, then a judge provides structured analysis",
		promptGuidelines: [
			"Get multi-model advice: fusion({ context: 'research findings', task: 'create execution plan', draft_plan: 'your draft' })",
			"Panel (2-3 models) critiques your plan, judge identifies contradictions",
			"Use before high-cost delegations (destructive ops, broad changes)",
			"Skip for simple tactical tasks",
		],

		async execute(toolCallId: string, params: FusionParams, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
			const config = loadFusionConfig(ctx.cwd);
			if (!config.enabled) {
				return {
					content: [{ type: "text" as const, text: "Fusion is disabled. Enable it in .pi/fusion.json" }],
					details: { status: "disabled" } as any,
				};
			}

			const registry = ctx.modelRegistry;
			if (!registry) {
				throw new Error("No model registry available");
			}

			// Resolve panel models
			let panelModels = resolveModels(registry, config.panel);
			if (panelModels.length === 0) {
				panelModels = autoDiversePanel(registry);
			}
			if (panelModels.length === 0 && ctx.model) {
				panelModels = [ctx.model];
			}
			if (panelModels.length === 0) {
				throw new Error("No models available for fusion panel. Configure models in .pi/fusion.json");
			}

			// Cap to maxPanelModels
			panelModels = panelModels.slice(0, config.maxPanelModels);

			// Resolve judge
			let judgeModel = resolveOneModel(registry, config.judge);
			if (!judgeModel) {
				judgeModel = panelModels[0];
			}

			// Build prompt
			const systemPrompt = `You are a planning advisor. Analyze the context below and provide your best plan or critique. Be specific, practical, and consider edge cases. Focus on correctness, tradeoffs, and potential blind spots.

IMPORTANT: For each distinct finding, insight, or recommendation you identify, you MUST call the reportFinding tool. Do not group multiple findings into one tool call. If you have no tool calls, your full analysis will be used as a single finding.`;
			let userPrompt = params.context;
			if (params.draft_plan) {
				userPrompt += `\n\n## Draft Plan for Critique\n${params.draft_plan}`;
			}
			userPrompt += `\n\n## Task\n${params.task}\n\nProvide your analysis:`;

			onUpdate?.({
				content: [{ type: "text", text: `⚡ Fusion: panel (${panelModels.map((m: any) => m.id).join(", ")})` }],
				details: { phase: "panel" },
			});

			// Run panel with concurrency limit of 2
			const panelResults = await mapWithConcurrencyLimit(panelModels, 2, async (model: any) => {
				onUpdate?.({
					content: [{ type: "text", text: `  ⏳ Panel: ${model.id}...` }],
					details: { phase: "panel_running", model: model.id },
				});
				const result = await runPanelModel(model, systemPrompt, userPrompt, {
					maxTokens: config.maxTokensPerPanel,
					temperature: config.temperature,
				}, registry, signal, onUpdate,
					ctx.sessionManager.getSessionId(),
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

			if (succeeded.length === 0) {
				debugLog("fusion-tool: all panel models failed", { count: panelResults.length, errors: failed.map((r: any) => ({ model: r.model, error: r.error })) });
				return formatPanelResults([], failed) as any;
			}

			// Judge
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

			const auth = await registry.getApiKeyAndHeaders(judgeModel);
			if (!auth.ok || !auth.apiKey) {
				const judgeError = "No API key configured";
				debugLog("fusion-tool: judge model not authenticated", { model: judgeModel.id, error: judgeError });
				return formatPanelResults(succeeded, failed, judgeModel, judgeError) as any;
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
						maxTokens: config.maxTokensForJudge,
						temperature: 0.2,
						reasoningEffort: judgeModel.reasoning ? getDefaultReasoningEffort(judgeModel) : undefined,
						timeoutMs: 60_000,
					});
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

			if (analysis) {
				debugLog("fusion-tool: final analysis shape", {
					consensusCount: analysis.consensus.length,
					contradictionsCount: analysis.contradictions.length,
					uniqueInsightsCount: analysis.unique_insights.length,
					blindSpotsCount: analysis.blind_spots.length,
					recommendationsCount: analysis.recommendations.length,
				});
				const formatted = formatFusionResult(analysis, succeeded, failed, panelModels, judgeModel);
				onUpdate?.({
					content: [{ type: "text", text: `  ✓ Analysis complete` }],
					details: { phase: "complete" },
				});
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

			judgeError = judgeError || `Judge failed to produce valid analysis after ${maxAttempts} attempts: ${lastParseError}`;
			debugLog("fusion-tool: judge failed after all attempts", { model: judgeModel.id, attempts: maxAttempts, error: judgeError, lastTextLength: lastJudgeText.length });
			return formatPanelResults(succeeded, failed, judgeModel, judgeError) as any;
		},
	});

	_fusionRegistrations.set(cwd, { registered: true, config });
}
