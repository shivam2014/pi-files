/**
 * RegistrationHub — centralizes all register* calls for the orchestrator extension.
 *
 * Extracted from index.ts default export.
 * Provides a single function that registers all tools and commands.
 *
 * NOTE: Fusion tool registration is NOT done here — it's handled by the
 * before_agent_start event handler (index.ts:48) because registerFusionTool
 * calls pi.getAllTools() which is an action method that cannot run during
 * extension loading. The before_agent_start callback fires at agent-start
 * time when all APIs are available.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDelegateTool } from "./delegate-tool.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { registerCommands } from "./commands.ts";
import { registerFusionCommands } from "./fusion-commands.ts";

/**
 * Register all orchestrator tools and commands.
 * Called once during extension initialization.
 * Does NOT register the fusion tool — that is deferred to before_agent_start.
 */
export function registerAllTools(pi: ExtensionAPI, cwd: string): void {
	registerDelegateTool(pi);
	registerPlanTool(pi);
	registerCommands(pi);
	registerFusionCommands(pi);
}
