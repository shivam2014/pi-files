import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FusionConfig, FusionAnalysis } from "./types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { debugLog } from "./debug.ts";

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
		temperaturePreferenceCache.set(modelId, true);
		return result;
	} catch (err: any) {
		const msg = err?.message ?? String(err);
		if (requestedTemperature != null && msg.toLowerCase().includes("temperature")) {
			debugLog("fusion-tool: retrying without temperature", { model: modelId, error: msg });
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

// ─── Config ────────────────────────────────────────────────

export function getDefaultReasoningEffort(model: any): string {
	const map = model?.thinkingLevelMap;
	if (map && typeof map === "object") {
		if (map["medium"] != null) return "medium";
		for (const key of Object.keys(map)) {
			if (map[key] != null) return key;
		}
	}
	return "medium";
}

export function extractText(response: AssistantMessage): string {
	const textBlocks = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text);
	const text = textBlocks.join("\n");
	if (text) {
		return text;
	}
	return response.content
		.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
		.map((c) => c.thinking)
		.join("\n");
}

export function sanitizeFusionConfig(
	config: FusionConfig,
	availableModelIds: string[],
): { config: Required<FusionConfig>; removed: string[] } {
	const removed: string[] = [];

	const panel = (config.panel ?? []).filter((id) => {
		if (availableModelIds.includes(id)) return true;
		removed.push(id);
		return false;
	});

	let judge = config.judge ?? "";
	if (judge && !availableModelIds.includes(judge)) {
		removed.push(judge);
		judge = "";
	}

	const cleaned: Required<FusionConfig> = {
		enabled: config.enabled ?? true,
		panel,
		judge,
		maxPanelModels: config.maxPanelModels ?? 3,
		temperature: config.temperature ?? 0.3,
		maxTokensPerPanel: config.maxTokensPerPanel ?? 2048,
		maxTokensForJudge: config.maxTokensForJudge ?? 4096,
	};

	return { config: cleaned, removed };
}

export function loadFusionConfig(cwd: string, availableModelIds?: string[]): Required<FusionConfig> {
	const projectPath = join(cwd, ".pi", "fusion.json");
	const globalPath = join(getAgentDir(), "fusion.json");

	let config: FusionConfig = {};

	if (existsSync(globalPath)) {
		try {
			config = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch (err: any) {
			debugLog("fusion-tool: failed to load global fusion config", { globalPath, error: err.message ?? String(err) });
		}
	}
	if (existsSync(projectPath)) {
		try {
			const projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
			config = { ...config, ...projectConfig };
		} catch (err: any) {
			debugLog("fusion-tool: failed to load project fusion config", { projectPath, error: err.message ?? String(err) });
		}
	}

	const defaulted: Required<FusionConfig> = {
		enabled: config.enabled ?? true,
		panel: config.panel ?? [],
		judge: config.judge ?? "",
		maxPanelModels: config.maxPanelModels ?? 3,
		temperature: config.temperature ?? 0.3,
		maxTokensPerPanel: config.maxTokensPerPanel ?? 2048,
		maxTokensForJudge: config.maxTokensForJudge ?? 4096,
	};

	if (availableModelIds && availableModelIds.length > 0) {
		const { config: cleaned, removed } = sanitizeFusionConfig(defaulted, availableModelIds);
		if (removed.length > 0) {
			debugLog("fusion-tool: removed stale fusion models", { removed });
			saveFusionConfig(cwd, cleaned);
		}
		return cleaned;
	}

	return defaulted;
}

function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	return new Promise((resolve, reject) => {
		const results: R[] = new Array(items.length);
		let index = 0;
		let running = 0;
		let rejected = false;

		function next() {
			if (rejected) return;
			if (index >= items.length) {
				if (running === 0) resolve(results);
				return;
			}
			const current = index++;
			running++;
			fn(items[current])
				.then((result) => {
					results[current] = result;
					running--;
					next();
				})
				.catch((err) => {
					rejected = true;
					reject(err);
				});
		}

		for (let i = 0; i < Math.min(limit, items.length); i++) {
			next();
		}
	});
}

export function extractJsonObject(text: string): string | null {
	if (!text) return null;

	// Strip markdown fences
	const withoutFences = text
		.replace(/```(?:json)?\s*([\s\S]*?)```/g, (_, inner: string) => inner)
		.trim();

	const objects: string[] = [];
	let inString = false;
	let escape = false;
	let depth = 0;
	let start = -1;

	for (let i = 0; i < withoutFences.length; i++) {
		const char = withoutFences[i];

		if (escape) {
			escape = false;
			continue;
		}
		if (char === "\\") {
			escape = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;

		if (char === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (char === "}") {
			if (depth > 0) {
				depth--;
				if (depth === 0 && start !== -1) {
					objects.push(withoutFences.slice(start, i + 1));
					start = -1;
				}
			}
		}
	}

	return objects.length > 0 ? objects[objects.length - 1] : null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isContradictions(value: unknown): value is FusionAnalysis["contradictions"] {
	if (!Array.isArray(value)) return false;
	return value.every(
		(c) =>
			typeof c === "object" &&
			c !== null &&
			typeof (c as any).topic === "string" &&
			Array.isArray((c as any).stances) &&
			(c as any).stances.every(
				(s: unknown) =>
					typeof s === "object" &&
					s !== null &&
					typeof (s as any).model === "string" &&
					typeof (s as any).stance === "string",
			),
	);
}

function isUniqueInsights(value: unknown): value is FusionAnalysis["unique_insights"] {
	if (!Array.isArray(value)) return false;
	return value.every(
		(i) =>
			typeof i === "object" &&
			i !== null &&
			typeof (i as any).model === "string" &&
			typeof (i as any).insight === "string",
	);
}

export function parseJudgeAnalysis(text: string): FusionAnalysis | null {
	const jsonText = extractJsonObject(text);
	if (!jsonText) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const a = parsed as Record<string, unknown>;

	if (
		!isStringArray(a.consensus) ||
		!isContradictions(a.contradictions) ||
		!isUniqueInsights(a.unique_insights) ||
		!isStringArray(a.blind_spots) ||
		!isStringArray(a.recommendations)
	) {
		return null;
	}

	return {
		consensus: a.consensus,
		contradictions: a.contradictions,
		unique_insights: a.unique_insights,
		blind_spots: a.blind_spots,
		recommendations: a.recommendations,
	};
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
			if (currentText) {
				return { model: modelId, content: currentText, reports, error: "Max iterations exceeded" };
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
		description: "Multi-model analysis tool. Runs a prompt against a panel of models, then a judge synthesizes responses into structured analysis.",
		parameters,

		promptSnippet: "Get multi-model advice by running a prompt against a panel of models, then a judge provides structured analysis",
		promptGuidelines: [
			"Use fusion when you need multi-perspective analysis before making planning decisions",
			"Provide research findings as context, optionally include a draft plan for critique",
			"fusion returns structured analysis with consensus, contradictions, unique insights, and blind spots",
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
			const panelResults = await mapWithConcurrencyLimit(panelModels, 2, (model: any) =>
				runPanelModel(model, systemPrompt, userPrompt, {
					maxTokens: config.maxTokensPerPanel,
					temperature: config.temperature,
				}, registry, signal, onUpdate,
					ctx.sessionManager.getSessionId(),
				)
			);

			const succeeded = panelResults.filter((r: any) => r.content && !r.error);
			const failed = panelResults.filter((r: any) => r.error || !r.content);

			if (succeeded.length === 0) {
				debugLog("fusion-tool: all panel models failed", { count: panelResults.length, errors: failed.map((r: any) => ({ model: r.model, error: r.error })) });
				return formatPanelResults([], failed) as any;
			}

			onUpdate?.({
				content: [{ type: "text", text: `⚡ Fusion: judge (${judgeModel.id})...` }],
				details: { phase: "judge" },
			});

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

// ─── Helpers ────────────────────────────────────────────────


function resolveModels(registry: any, models: string[]): any[] {
	return models
		.map((id) => {
			const slashIdx = id.indexOf("/");
			if (slashIdx > 0) {
				return registry.find(id.slice(0, slashIdx), id.slice(slashIdx + 1));
			}
			return null;
		})
		.filter(Boolean);
}

function resolveOneModel(registry: any, modelId: string): any {
	if (!modelId) return null;
	const slashIdx = modelId.indexOf("/");
	if (slashIdx > 0) {
		return registry.find(modelId.slice(0, slashIdx), modelId.slice(slashIdx + 1));
	}
	return null;
}

function autoDiversePanel(registry: any): any[] {
	const available = registry.getAvailable();
	if (!available || available.length === 0) return [];

	const byProvider: Record<string, any[]> = {};
	for (const m of available) {
		const provider = m.provider || "unknown";
		if (!byProvider[provider]) byProvider[provider] = [];
		byProvider[provider].push(m);
	}

	const picked: any[] = [];
	const providers = Object.keys(byProvider).sort();
	for (let i = 0; i < 2; i++) {
		for (const provider of providers) {
			const models = byProvider[provider];
			if (models.length > i) {
				const model = models[i];
				if (!picked.find((p) => p.id === model.id && p.provider === model.provider)) {
					picked.push(model);
					if (picked.length >= 2) return picked;
				}
			}
		}
	}

	return picked.slice(0, 2);
}

function formatFusionResult(analysis: any, succeeded: any[], failed: any[], panelModels: any[], judgeModel: any): string {
	let text = "## Fusion Analysis\n\n";

	if (analysis?.consensus?.length > 0) {
		text += "### Consensus\n" + analysis.consensus.map((c: string) => `- ${c}`).join("\n") + "\n\n";
	}

	if (analysis?.contradictions?.length > 0) {
		text += "### Contradictions\n";
		for (const c of analysis.contradictions) {
			text += `- **${c.topic}**:\n`;
			for (const s of c.stances || []) {
				text += `  - ${s.model}: ${s.stance}\n`;
			}
		}
		text += "\n";
	}

	if (analysis?.unique_insights?.length > 0) {
		text += "### Unique Insights\n";
		for (const i of analysis.unique_insights) {
			text += `- **${i.model}**: ${i.insight}\n`;
		}
		text += "\n";
	}

	if (analysis?.blind_spots?.length > 0) {
		text += "### Blind Spots\n" + analysis.blind_spots.map((b: string) => `- ${b}`).join("\n") + "\n\n";
	}

	if (analysis?.recommendations?.length > 0) {
		text += "### Recommendations\n" + analysis.recommendations.map((r: string) => `- ${r}`).join("\n") + "\n\n";
	}

	text += "### Panel\n\n";
	for (const r of succeeded) {
		text += `**${r.model}**:\n`;
		if (r.reports?.length) {
			for (const report of r.reports) {
				text += `  ✓ ${report}\n`;
			}
		} else {
			// Fallback: show first line of content if no reports
			const firstLine = r.content?.split("\n")[0] || "(no analysis)";
			text += `  ${firstLine}\n`;
		}
		text += "\n";
	}
	if (failed.length > 0) {
		text += "\n### Failed\n" + failed.map((r: any) => `- **${r.model}**: ${r.error}`).join("\n") + "\n";
	}
	if (analysis) {
		text += "### Judge\n\n";
		text += `**${judgeModel.id}**:\n`;
		if (analysis.consensus?.length) {
			for (const item of analysis.consensus) {
				text += `  ✓ ${item}\n`;
			}
		}
		if (analysis.contradictions?.length) {
			for (const item of analysis.contradictions) {
				const topic = typeof item === "string" ? item : item.topic || "";
				text += `  ⚡ Contradiction: ${topic}\n`;
			}
		}
		if (analysis.blind_spots?.length) {
			for (const item of analysis.blind_spots) {
				text += `  ⚠ Blind spot: ${item}\n`;
			}
		}
		if (analysis.recommendations?.length) {
			for (const item of analysis.recommendations) {
				text += `  → ${item}\n`;
			}
		}
		text += "\n";
	}

	return text;
}

function formatPanelResults(
	succeeded: any[],
	failed: any[] = [],
	judgeModel?: any,
	judgeError?: string,
): { content: Array<{ type: "text"; text: string }>; details: { status: string; responses: any[]; errors: any[]; judgeError?: string } } {
	let text = "## Panel Responses\n\n";
	if (succeeded.length > 0) {
		text += succeeded.map((r: any) => `### ${r.model}\n${r.content}`).join("\n\n");
	} else {
		text += "*(No panel model succeeded)*";
	}

	const displayErrors = failed.slice();
	if (judgeModel && judgeError) {
		displayErrors.push({ model: judgeModel.id, error: judgeError });
	}

	if (displayErrors.length > 0) {
		text += "\n\n### Failed\n" + displayErrors.map((r: any) => `- **${r.model}**: ${r.error || "Unknown error (empty response)"}`).join("\n");
	}

	if (judgeModel && judgeError) {
		text += `\n\n*(No judge available — ${judgeModel.id} failed: ${judgeError})*`;
	} else if (!judgeModel) {
		text += "\n\n*(No judge available — judge model not configured or call failed)*";
	}

	return {
		content: [{ type: "text" as const, text }],
		details: { status: "no_judge", responses: succeeded, errors: displayErrors, judgeError },
	};
}

export function saveFusionConfig(cwd: string, config: Partial<FusionConfig>): void {
	const projectPath = join(cwd, ".pi", "fusion.json");
	const existing = loadFusionConfig(cwd);
	const merged = { ...existing, ...config };
	mkdirSync(dirname(projectPath), { recursive: true });
	writeFileSync(projectPath, JSON.stringify(merged, null, 2) + "\n");
}
