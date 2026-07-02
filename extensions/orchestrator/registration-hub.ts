/**
 * RegistrationHub — centralizes all register* calls for the orchestrator extension.
 *
 * Extracted from index.ts default export.
 * Provides a single function that registers all tools and commands.
 *
 * ALL tools are registered here during extension init, including fusion.
 * Tool visibility (active/inactive) is controlled by setActiveTools() in
 * before_agent_start, NOT by register/unregister lifecycle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDelegateTool } from "./delegate-tool.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { registerCommands } from "./commands.ts";
import { registerFusionCommands } from "./fusion-commands.ts";
import { registerFusionTool } from "./fusion-tool.ts";
import { registerListSkillsTool, registerListToolsTool } from "./introspection-tools.ts";

/**
 * Register all orchestrator tools and commands.
 * Called once during extension initialization.
 * Includes fusion — visibility controlled by setActiveTools, not registration.
 */
export function registerAllTools(pi: ExtensionAPI, cwd: string): void {
	registerDelegateTool(pi);
	registerPlanTool(pi);
	registerFusionTool(pi, cwd);
	registerListSkillsTool(pi);
	registerListToolsTool(pi, cwd);
	registerCommands(pi);
	registerFusionCommands(pi);
}
