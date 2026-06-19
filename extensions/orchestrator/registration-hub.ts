/**
 * RegistrationHub — centralizes all register* calls for the orchestrator extension.
 *
 * Extracted from index.ts default export.
 * Provides a single function that registers all tools and commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDelegateTool } from "./delegate-tool.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { registerCommands } from "./commands.ts";
import { registerFusionCommands } from "./fusion-commands.ts";
import { registerFusionTool } from "./fusion-tool.ts";

/**
 * Register all orchestrator tools and commands.
 * Called once during extension initialization.
 */
export function registerAllTools(pi: ExtensionAPI, cwd: string): void {
	registerDelegateTool(pi);
	registerPlanTool(pi);
	registerCommands(pi);
	registerFusionCommands(pi);
	registerFusionTool(pi, cwd);
}
