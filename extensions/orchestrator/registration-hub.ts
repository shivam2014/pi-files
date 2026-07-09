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

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBashToolReplacement } from "./bash-interceptor.ts";

import { registerDelegateTool } from "./delegate-tool.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { registerCommands } from "./commands.ts";
import { registerFusionCommands } from "./fusion-commands.ts";
import { registerFusionTool } from "./fusion-tool.ts";
import { registerListSkillsTool, registerListToolsTool } from "./introspection-tools.ts";

/**
 * Register a `glob` tool alias that delegates to the built-in `find` tool.
 * Subagents (especially scout) attempt to call `glob` but only `find` exists.
 */
function registerGlobAlias(pi: ExtensionAPI): void {
	const findTool = (pi as any).getTool?.("find");
	if (!findTool) return; // find not available — skip alias

	pi.registerTool({
		name: "glob",
		label: "Glob",
		description: "Find files matching a glob pattern. Alias for the find tool.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern to match files" }),
			path: Type.Optional(Type.String({ description: "Directory to search in (optional)" })),
		}),
		async execute(_toolCallId: string, args: { pattern: string; path?: string }) {
			return findTool.execute(_toolCallId, args);
		},
	});
}

/**
 * Register all orchestrator tools and commands.
 * Called once during extension initialization.
 * Includes fusion — visibility controlled by setActiveTools, not registration.
 */
async function runBashCommand(command: string, cwd?: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
	const { execSync } = await import("node:child_process");
	try {
		const output = execSync(command, { encoding: "utf-8", timeout: 120000, cwd });
		return { content: [{ type: "text", text: output }], details: {} };
	} catch (e: any) {
		return { content: [{ type: "text", text: e.stderr || e.message }], details: { isError: true } };
	}
}

function registerBashWrapper(pi: ExtensionAPI, cwd: string): void {
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: "Run a shell command. Pass override:true to bypass destructive operation interception.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			override: Type.Optional(Type.Boolean({ description: "Bypass destructive operation interception" })),
		}),
		async execute(_toolCallId: string, args: { command: string; override?: boolean }): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
			if (args.override) return runBashCommand(args.command, cwd);
			const replacement = getBashToolReplacement(args.command, args.override);
			if (!replacement.allowed) {
				return { content: [{ type: "text", text: `Blocked: ${replacement.reason}` }], details: { isError: true } };
			}
			if (replacement.tool) {
				return { content: [{ type: "text", text: `Intercepted: use ${replacement.tool} tool instead. Set override:true to bypass.` }], details: {} };
			}
			return runBashCommand(args.command, cwd);
		},
	});
}

export function registerAllTools(pi: ExtensionAPI, cwd: string): void {
	registerBashWrapper(pi, cwd);
	registerDelegateTool(pi);
	registerPlanTool(pi);
	registerFusionTool(pi, cwd);
	registerListSkillsTool(pi);
	registerListToolsTool(pi, cwd);
	registerGlobAlias(pi);
	registerCommands(pi);
	registerFusionCommands(pi);
}
