import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadOrchestratorConfig, saveOrchestratorConfig } from "./orchestrator-config.ts";
import { showModelTUI } from "./model-tui.ts";

export function registerModelCommands(pi: ExtensionAPI): void {
	pi.registerCommand("orchestrator-models", {
		description: "Configure orchestrator settings — delegation mode and delegate models",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			// /orchestrator-models status or /orchestrator-models show
			if (trimmed === "status" || trimmed === "show") {
				await showModelStatus(ctx);
				return;
			}

			// /orchestrator-models reset or /orchestrator-models clear
			if (trimmed === "reset" || trimmed === "clear") {
				await resetModelConfig(ctx);
				return;
			}

			// /orchestrator-models set default <model-id>  or  /orchestrator-models set <specialist> <model-id>
			if (trimmed.startsWith("set ")) {
				await handleModelSet(trimmed.slice(4), ctx);
				return;
			}

			// Default: open interactive TUI (handles "open" as well)
			await showModelTUI(ctx);
		},
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Show current model config" },
				{ value: "set", label: "set", description: "Set model: /orchestrator-models set default <id> or /orchestrator-models set <specialist> <id>" },
				{ value: "reset", label: "reset", description: "Clear all model overrides" },
				{ value: "open", label: "open", description: "Open interactive model settings" },
			];
			return items.filter((i) => i.label.startsWith(prefix));
		},
	});
}

async function showModelStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadOrchestratorConfig();
	const lines = ["═══ Model Configuration ═══", ""];

	if (!config.models) {
		lines.push("No model overrides configured.");
		lines.push("All delegates inherit the orchestrator's model.");
	} else {
		lines.push(`Default delegate model: ${config.models.delegate ?? "(inherited)"}`);
		lines.push("");
		lines.push("Per-specialist overrides:");
		if (config.models.specialists && Object.keys(config.models.specialists).length > 0) {
			for (const [name, modelId] of Object.entries(config.models.specialists)) {
				lines.push(`  ${name}: ${modelId}`);
			}
		} else {
			lines.push("  (none)");
		}
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

async function resetModelConfig(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadOrchestratorConfig();
	config.models = undefined;
	saveOrchestratorConfig(config);
	ctx.ui.notify("Model overrides cleared. All delegates now inherit the orchestrator's model.", "info");
}

async function handleModelSet(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const config = loadOrchestratorConfig();

	// Parse: "default anthropic/claude-sonnet-4" or "scout anthropic/claude-haiku-3"
	const parts = args.split(/\s+/);
	if (parts.length < 2) {
		ctx.ui.notify("Usage: /orchestrator-models set default <model-id>  or  /orchestrator-models set <specialist> <model-id>", "error");
		return;
	}

	const target = parts[0];
	const modelId = parts[1];

	// Validate model ID format (provider/model)
	if (!modelId.includes("/")) {
		ctx.ui.notify("Invalid model ID format. Use: provider/model-id (e.g., anthropic/claude-sonnet-4)", "error");
		return;
	}

	if (!config.models) {
		config.models = {};
	}

	if (target === "default") {
		config.models.delegate = modelId;
		ctx.ui.notify(`Default delegate model set to: ${modelId}`, "info");
	} else {
		// Per-specialist override
		if (!config.models.specialists) {
			config.models.specialists = {};
		}
		config.models.specialists[target] = modelId;
		ctx.ui.notify(`Model for ${target} set to: ${modelId}`, "info");
	}

	saveOrchestratorConfig(config);
}
