import type { ReadSkillParams } from "./types.ts";
import { Type } from "typebox";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Create the read_skill tool definition.
 *
 * Reads the SKILL.md file from ~/.pi/agent/skills/{name}/SKILL.md
 * with path-sandboxing to prevent directory traversal.
 *
 * Returns a tool definition object (not registered — caller registers it).
 */
export function createReadSkillTool() {
	return {
		name: "read_skill",
		label: "read_skill",
		description:
			"Read the contents of a skill file by name. " +
			"Skills are loaded from ~/.pi/agent/skills/{name}/SKILL.md. " +
			"Example skill names: tdd, implement, review, diagnosing-bugs, agents-md-writer, domain-modeling.",
		parameters: Type.Object({
			name: Type.String({
				description: "Name of the skill to read (e.g., 'tdd', 'implement', 'review')",
			}),
		}),
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

			const skillsDir = join(getAgentDir(), "skills");
			const skillPath = join(skillsDir, name, "SKILL.md");
			// Use realpathSync to resolve symlinks (security), fallback to resolve for non-existent paths
			const safeRealpath = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
			const resolvedPath = safeRealpath(skillPath);
			const resolvedSkillsDir = safeRealpath(skillsDir);

			// Sandbox check: ensure resolved path is under skills directory
			if (!resolvedPath.startsWith(resolvedSkillsDir + "/")) {
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

			if (!existsSync(resolvedPath)) {
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
				content = readFileSync(resolvedPath, "utf-8");
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
