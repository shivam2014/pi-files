import type { ReadSkillParams } from "./types.ts";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { resolveSkillFilePath } from "./skill-resolver.ts";

/**
 * Create the read_skill tool definition.
 *
 * Reads the SKILL.md file for a named skill, probing <agentDir>/skills,
 * ~/.agents/skills, and npm-bundled <agentDir>/npm/node_modules/<pkg>/skills
 * (incl. scoped packages), with path-sandboxing to prevent directory traversal.
 *
 * Returns a tool definition object (not registered — caller registers it).
 */
export function createReadSkillTool() {
	return {
		name: "read_skill",
		label: "read_skill",
		description:
			"Read the contents of a skill file by name. " +
			"Skills are loaded from <agentDir>/skills, ~/.agents/skills, and npm-bundled <agentDir>/npm/node_modules/*/skills (incl. scoped packages). " +
			"Example skill names: tdd, implement, code-review, diagnosing-bugs, agents-md-writer, domain-modeling.",
		parameters: Type.Object({
			name: Type.String({
				description: "Name of the skill to read (e.g., 'tdd', 'implement', 'code-review')",
			}),
		}),
		promptGuidelines: [
			"Read skill file: read_skill({ name: 'tdd' }) — returns full SKILL.md contents for the named skill",
			"Use to load skill instructions before executing a task that references one",
			"Output: Returns full skill file content as text, or an error message if skill not found or path traversal blocked",
		],
		async execute(
			toolCallId: string,
			params: ReadSkillParams,
			signal: any,
			onUpdate: any,
			ctx: any,
		) {
			const { name } = params;

			// Block path traversal characters
			if (name.includes("..") || name.includes("/") || name.includes("\\")) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: Invalid skill name '${name}'. Path traversal is blocked.`,
						},
					],
					details: {},
				};
			}

			// Resolve across all skill roots (probe order is shared with list_skills
			// and resolveSkill). The name guard above already blocks traversal
			// characters (.., /, \), so join() inside the resolver stays under each root.
			const skillPath = resolveSkillFilePath(name);

			if (!skillPath) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: Skill '${name}' not found.`,
						},
					],
					details: {},
				};
			}

			let content: string;
			try {
				content = readFileSync(skillPath, "utf-8");
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: Failed to read skill '${name}': ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}
			return {
				content: [{ type: "text" as const, text: content }],
				details: {},
			};
		},
	};
}
