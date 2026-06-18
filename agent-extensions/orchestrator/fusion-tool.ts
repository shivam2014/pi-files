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

// ─── Report-Finding Tool (for panel models) ─────────────

const reportFindingTool = {
	name: "reportFinding",
	description: "Report an important finding, key insight, or recommendation during your analysis. Call this for each noteworthy point you discover.",
	parameters: Type.Object({
		finding: Type.String({ description: "The key finding, insight, or recommendation" }),
	}),
};

// ─── Config ────────────────────────────────────────────────

export function loadFusionConfig(cwd: string): Required<FusionConfig> {
	const projectPath = join(cwd, ".pi", "fusion.json");
	const globalPath = join(getAgentDir(), "fusion.json");

	let config: FusionConfig = {};

	if (existsSync(globalPath)) {
		try {
			config = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch { /* ignore */ }
	}
	if (existsSync(projectPath)) {
		try {
			const projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
			config = { ...config, ...projectConfig };
		} catch { /* ignore */ }
	}

	return {
		enabled: config.enabled ?? true,
		panel: config.panel ?? [],
		judge: config.judge ?? "",
		maxPanelModels: config.maxPanelModels ?? 3,
		temperature: config.temperature ?? 0.3,
		maxTokensPerPanel: config.maxTokensPerPanel ?? 2048,
		maxTokensForJudge: config.maxTokensForJudge ?? 4096,
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
	const modelId = model.id;

	while (true) {
		try {
			const response = await complete(model, {
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
			});

			// Handle error/aborted responses
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				const errMsg = (response as any).errorMessage || `Model stopped: ${response.stopReason}`;
				return { model: modelId, error: errMsg };
			}

			const toolCalls = response.content?.filter((c: any) => c.type === "toolCall") || [];

			if (toolCalls.length > 0) {
				for (const tc of toolCalls) {
					const toolCall = tc as any;
					if (toolCall.name === "reportFinding") {
						const finding = toolCall.arguments?.finding || "";
						reports.push(finding);
						onUpdate?.({
							content: [{ type: "text", text: `  ── Panel: ${modelId} ──\n  ✓ Report: ${finding}` }],
							details: { phase: "panel_report", model: modelId, finding },
						});
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

			// No tool calls — extract text content
			const text = extractText(response);
			return { model: modelId, content: text, reports };

		} catch (err: any) {
			return { model: modelId, error: err.message ?? String(err) };
		}
	}
}

// ─── Tool Registration ─────────────────────────────────────

export function registerFusionTool(pi: ExtensionAPI, cwd: string): void {
	const config = loadFusionConfig(cwd);
	if (!config.enabled) return;

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
		description: "Multi-model deliberation tool. Runs a prompt against a panel of models, then a judge synthesizes their responses into structured analysis (consensus, contradictions, blind spots). Use when you need multi-model advice on complex planning decisions — typically after scout/researcher gather findings, before writing the final plan.",
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
			const systemPrompt = "You are a planning advisor. Analyze the context below and provide your best plan or critique. Be specific, practical, and consider edge cases. Focus on correctness, tradeoffs, and potential blind spots.";
			let userPrompt = params.context;
			if (params.draft_plan) {
				userPrompt += `\n\n## Draft Plan for Critique\n${params.draft_plan}`;
			}
			userPrompt += `\n\n## Task\n${params.task}\n\nProvide your analysis:`;

			onUpdate?.({
				content: [{ type: "text", text: `⚡ Fusion: panel (${panelModels.map((m: any) => m.id).join(", ")})...` }],
				details: { phase: "panel" },
			});

			// Run panel in parallel
			const panelResults = await Promise.all(panelModels.map((model: any) =>
				runPanelModel(model, systemPrompt, userPrompt, {
					maxTokens: config.maxTokensPerPanel,
					temperature: config.temperature,
				}, registry, signal, onUpdate,
					ctx.sessionManager.getSessionId(),
				)
			));

			const succeeded = panelResults.filter((r: any) => r.content);
			const failed = panelResults.filter((r: any) => r.error);

			if (succeeded.length === 0) {
				throw new Error(`Fusion failed: all ${panelResults.length} panel models returned errors.\n${failed.map((r: any) => `- ${r.model}: ${r.error}`).join("\n")}`);
			}

			if (succeeded.length === 1) {
				return {
					content: [{ type: "text" as const, text: succeeded[0].content }],
					details: { status: "single", model: succeeded[0].model },
				} as any;
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

			try {
				const auth = await registry.getApiKeyAndHeaders(judgeModel);
				if (!auth.ok || !auth.apiKey) {
					return formatPanelResults(succeeded) as any;
				}
				const judgeResponse = await complete(judgeModel, {
					systemPrompt: judgeSystemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: judgePrompt }], timestamp: Date.now() }],
				}, {
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: signal ?? undefined,
					maxTokens: config.maxTokensForJudge,
					temperature: 0.2,
				});

				const judgeText = extractText(judgeResponse);
				let analysis: any = null;
				try {
					const jsonMatch = judgeText.match(/\{[\s\S]*\}/);
					if (jsonMatch) {
						analysis = JSON.parse(jsonMatch[0]);
					}
				} catch { /* not valid JSON — use raw text */ }

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
			} catch {
				return formatPanelResults(succeeded) as any;
			}
		},
	});
}

// ─── Helpers ────────────────────────────────────────────────

function extractText(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

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

	text += "### Panel Reports\n\n";
	for (const r of succeeded) {
		text += `**${r.model}**:\n`;
		if (r.reports && r.reports.length > 0) {
			for (const report of r.reports) {
				text += `  ✓ ${report}\n`;
			}
		}
		text += "\n";
	}
	if (failed.length > 0) {
		text += "\n### Failed\n" + failed.map((r: any) => `- **${r.model}**: ${r.error}`).join("\n") + "\n";
	}
	text += `\n### Judge\n- **${judgeModel.provider}/${judgeModel.id}**\n`;

	return text;
}

function formatPanelResults(succeeded: any[]): { content: Array<{ type: "text"; text: string }>; details: { status: string; responses: any[] } } {
	const text = "## Panel Responses\n\n" +
		succeeded.map((r: any) => `### ${r.model}\n${r.content}`).join("\n\n") +
		"\n\n*(No judge available — judge model not configured or call failed)*";

	return {
		content: [{ type: "text" as const, text }],
		details: { status: "no_judge", responses: succeeded },
	};
}

export function saveFusionConfig(cwd: string, config: Partial<FusionConfig>): void {
	const projectPath = join(cwd, ".pi", "fusion.json");
	const existing = loadFusionConfig(cwd);
	const merged = { ...existing, ...config };
	mkdirSync(dirname(projectPath), { recursive: true });
	writeFileSync(projectPath, JSON.stringify(merged, null, 2) + "\n");
}
