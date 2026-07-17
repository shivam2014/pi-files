import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { FusionConfig } from "./types.ts";
import { loadFusionConfig } from "./fusion-config.ts";
import { formatPanelResults } from "./fusion-format.ts";
import { resolveModels, resolveOneModel, autoDiversePanel } from "./fusion-models.ts";
import { FusionPipeline, FusionRunContext } from "./fusion-pipeline.ts";

// Re-exports for API surface (used by other modules and tests)
export { getDefaultReasoningEffort, sanitizeFusionConfig, loadFusionConfig, saveFusionConfig } from "./fusion-config.ts";
export { extractJsonObject, parseJudgeAnalysis } from "./fusion-judge.ts";
export { formatFusionResult, formatPanelResults } from "./fusion-format.ts";
export { resolveModels, resolveOneModel, autoDiversePanel } from "./fusion-models.ts";
export { FusionRunContext, FusionPipeline, tryCompleteWithTemperatureFallback, _resetTemperatureCacheForTests } from "./fusion-pipeline.ts";

// ─── Fusion registration state, keyed by cwd ─────────────
const _fusionRegistrations = new Map<string, { registered: boolean; config: Required<FusionConfig> }>();

export function _resetFusionRegistrationsForTests(): void {
	_fusionRegistrations.clear();
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
			"Output: Returns structured JSON analysis with consensus, contradictions, unique insights, blind spots, and synthesized recommendations; may include partial streaming updates during panel execution",
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
			const systemPrompt = `You are a planning advisor. Analyze the context below and provide your best plan or critique. Be specific, practical, and consider edge cases. Focus on correctness, tradeoffs, and potential blind spots.`;
			let userPrompt = params.context;
			if (params.draft_plan) {
				userPrompt += `\n\n## Draft Plan for Critique\n${params.draft_plan}`;
			}
			userPrompt += `\n\n## Task\n${params.task}\n\nProvide your analysis:`;

			onUpdate?.({
				content: [{ type: "text", text: `⚡ Fusion: panel (${panelModels.map((m: any) => m.id).join(", ")})` }],
				details: { phase: "panel" },
			});

			// Run pipeline
			const runCtx = new FusionRunContext();
			const pipeline = new FusionPipeline(registry, config, runCtx);

			const { succeeded, failed } = await pipeline.panelPhase(
				panelModels, systemPrompt, userPrompt,
				signal, onUpdate, ctx.sessionManager.getSessionId(),
			);

			// All panel models failed — early return
			if (succeeded.length === 0) {
				return formatPanelResults([], failed) as any;
			}

			// Judge phase
			const { analysis, judgeError } = await pipeline.judgePhase(succeeded, judgeModel, signal, onUpdate);

			if (analysis) {
				onUpdate?.({
					content: [{ type: "text", text: `  ✓ Analysis complete` }],
					details: { phase: "complete" },
				});
			}

			// Format and return
			return pipeline.formatPhase(analysis, succeeded, failed, panelModels, judgeModel, judgeError);
		},
	});

	_fusionRegistrations.set(cwd, { registered: true, config });
}
