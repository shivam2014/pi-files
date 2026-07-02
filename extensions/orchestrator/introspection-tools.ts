/**
 * Introspection tools — list_skills and list_tools.
 *
 * Provides tools for discovering available skills and tools.
 * Follows the pattern from plan-tool.ts for tool registration.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse frontmatter from a YAML block (content between --- markers).
 * Extracts name and description fields.
 */
function parseSkillFrontmatter(frontmatter: string): { name: string; description: string } {
	const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
	const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
	const name = nameMatch?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? "";
	const description = descMatch?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? "";
	return { name, description };
}

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
					const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
					const { name, description } = frontmatterMatch
						? parseSkillFrontmatter(frontmatterMatch[1])
						: { name: dir, description: "" };
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
