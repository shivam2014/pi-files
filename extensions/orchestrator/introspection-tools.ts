/**
 * Introspection tools — list_skills and list_tools.
 *
 * Provides tools for discovering available skills and tools.
 * Follows the pattern from plan-tool.ts for tool registration.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Register the list_skills tool on the pi extension API.
 *
 * Scans ~/.pi/agent/skills/ for subdirectories, reads SKILL.md frontmatter,
 * and returns a formatted list of skill names and descriptions.
 */
export function registerListSkillsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "list_skills",
		label: "list_skills",
		description:
			"List all installed skills with names and descriptions. " +
			"Useful for discovering what skills are available.",
		parameters: Type.Object({}),
		promptGuidelines: [
			"List skills: list_skills() — returns all installed skills with their names and descriptions",
			"Use to discover available skills before delegating",
            "Output: Returns bulleted list of installed skills as '• name: description' text, or 'No skills found' if empty",
		],
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const agentDir = getAgentDir();
			const skillsDir = join(agentDir, "skills");

			let entries: string[] = [];
			try {
				entries = readdirSync(skillsDir, { withFileTypes: true })
					.filter((dirent) => dirent.isDirectory())
					.map((dirent) => dirent.name);
			} catch {
				return {
					content: [{ type: "text", text: "No skills directory found." }],
					details: {},
				};
			}

			const results: string[] = [];
			for (const dir of entries.sort()) {
				try {
					const skillPath = join(skillsDir, dir, "SKILL.md");
					if (!existsSync(skillPath)) continue;
					const content = readFileSync(skillPath, "utf-8");
					const { frontmatter } = parseFrontmatter(content);
					const name = (frontmatter.name as string) || dir;
					const description = (frontmatter.description as string) || "";
					const displayName = name || dir;
					const displayDesc = description || "(no description)";
					results.push(`\u2022 ${displayName}: ${displayDesc}`);
				} catch {
					continue; // skip unreadable entries
				}
			}

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No skills found." }],
					details: {},
				};
			}

			return {
				content: [{ type: "text", text: results.join("\n") }],
				details: { skills: results },
			};
		},
	});
}

/**
 * Register the list_tools tool on the pi extension API.
 *
 * Returns the set of currently available orchestration tools.
 */
export function registerListToolsTool(pi: ExtensionAPI, cwd: string): void {
	pi.registerTool({
		name: "list_tools",
		label: "list_tools",
		description:
			"List all available orchestration tools. " +
			"Returns the actively registered tool set.",
		parameters: Type.Object({}),
		promptGuidelines: [
			"List tools: list_tools() — returns all available orchestration tools with their parameters and descriptions",
			"Use to discover what tools are available",
            "Output: Returns 'Available tools (N):' header followed by bulleted tool names, or '(none)' if empty",
		],
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const activeTools = pi.getActiveTools() as string[] || [];
			const details = activeTools.length > 0 
				? activeTools.map(t => `  - ${t}`).join('\n')
				: '  (none)';
			return {
				content: [{ type: "text" as const, text: `Available tools (${activeTools.length}):\n${details}` }],
				details: {},
			};
		},
	});
}
