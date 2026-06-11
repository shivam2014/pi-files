/**
 * Slash commands for the orchestrator extension.
 * Extracted from orchestrator.ts during refactoring.
 *
 * Commands:
 * - /orchestrate <task> — manual orchestration trigger
 * - /specialists — list available specialists
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SPECIALISTS, listSpecialists } from "./specialists.ts";

/**
 * Register slash commands on the pi extension API.
 */
export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("orchestrate", {
		description: "Run an orchestrated task with multiple specialists",
		handler: async (args, ctx) => {
			if (!args || args.trim().length === 0) {
				ctx.ui.notify("Usage: /orchestrate <task description>", "warning");
				return;
			}

			const task = args.trim();
			ctx.ui.notify(`Starting orchestrated task: ${task}`, "info");
			pi.sendUserMessage(task, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("specialists", {
		description: "List available specialists and their capabilities",
		handler: async (_args, ctx) => {
			const lines = Object.entries(SPECIALISTS).map(([key, spec]) => {
				return `${key}: ${spec.tools.join(", ")}`;
			});
			ctx.ui.notify(`Specialists:\n${lines.join("\n")}`, "info");
		},
	});
}
