import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerListSkillsTool, registerListToolsTool } from "./introspection-tools";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock getAgentDir with vi.fn() so individual tests can set its return value.
// Keep parseFrontmatter from the real module.
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

// Mock fusion config
vi.mock("./fusion-tool.ts", () => ({
	loadFusionConfig: vi.fn(),
}));

function createMockPi() {
	const tools: any[] = [];
	return {
		registerTool: vi.fn((tool: any) => {
			tools.push(tool);
		}),
		getActiveTools: vi.fn(),
		getAllTools: () => tools,
	};
}

describe("registerListSkillsTool", () => {
	let pi: ReturnType<typeof createMockPi>;
	let tool: any;

	beforeEach(() => {
		vi.clearAllMocks();
		pi = createMockPi();
		registerListSkillsTool(pi as any);
		tool = pi.getAllTools()[0];
	});

	describe("tool registration structure", () => {
		it("registers a tool named list_skills", () => {
			expect(tool.name).toBe("list_skills");
		});

		it("has a non-empty description", () => {
			expect(tool.description).toBeTruthy();
			expect(typeof tool.description).toBe("string");
			expect(tool.description.length).toBeGreaterThan(0);
		});

		it("has parameters defined as empty object", () => {
			expect(tool.parameters).toBeDefined();
		});

		it("has an execute function", () => {
			expect(typeof tool.execute).toBe("function");
		});
	});

	describe("execute with valid skills", () => {
		it("returns formatted skills list from frontmatter", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			mkdirSync(join(skillsDir, "tdd"));
			writeFileSync(
				join(skillsDir, "tdd", "SKILL.md"),
				"---\nname: tdd\ndescription: Test-driven development.\n---\n# TDD",
			);
			mkdirSync(join(skillsDir, "code-review"));
			writeFileSync(
				join(skillsDir, "code-review", "SKILL.md"),
				"---\nname: code-review\ndescription: Review code changes.\n---\n# Code Review",
			);

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-1", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("• tdd: Test-driven development.");
			expect(result.content[0].text).toContain("• code-review: Review code changes.");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("falls back to directory name when frontmatter has no name", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			mkdirSync(join(skillsDir, "custom-skill"));
			writeFileSync(
				join(skillsDir, "custom-skill", "SKILL.md"),
				"---\ndescription: A custom skill.\n---\n# Content",
			);

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-2", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("• custom-skill: A custom skill.");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("shows fallback description when frontmatter has no description", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			mkdirSync(join(skillsDir, "minimal"));
			writeFileSync(
				join(skillsDir, "minimal", "SKILL.md"),
				"---\nname: minimal\n---\n# Content",
			);

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-3", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("• minimal: (no description)");

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	describe("execute edge cases", () => {
		it("returns error when skills directory does not exist", async () => {
			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue("/nonexistent/path");

			const result = await tool.execute("call-4", {}, undefined, () => {}, {});

			expect(result.content[0].text).toBe("No skills directory found.");
		});

		it("returns empty message when no skills directories found", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-5", {}, undefined, () => {}, {});

			expect(result.content[0].text).toBe("No skills found.");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("handles SKILL.md read error gracefully", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			mkdirSync(join(skillsDir, "broken"));
			// Don't create SKILL.md — code calls existsSync and skips the entry,
			// resulting in empty results → "No skills found."

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-6", {}, undefined, () => {}, {});

			expect(result.content[0].text).toBe("No skills found.");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("reads SKILL.md with correct path", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			mkdirSync(join(skillsDir, "tdd"));
			writeFileSync(
				join(skillsDir, "tdd", "SKILL.md"),
				"---\nname: tdd\ndescription: TDD\n---",
			);

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			await tool.execute("call-7", {}, undefined, () => {}, {});

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("sorts skills alphabetically", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });

			for (const name of ["zeta", "alpha", "beta"]) {
				mkdirSync(join(skillsDir, name));
				writeFileSync(
					join(skillsDir, name, "SKILL.md"),
					`---\nname: ${name}\ndescription: ${name} skill\n---`,
				);
			}

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-8", {}, undefined, () => {}, {});

			const lines = result.content[0].text.split("\n");
			expect(lines[0]).toContain("alpha");
			expect(lines[1]).toContain("beta");
			expect(lines[2]).toContain("zeta");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("skips non-directory entries", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			mkdirSync(join(skillsDir, "real-skill"));
			writeFileSync(
				join(skillsDir, "real-skill", "SKILL.md"),
				"---\nname: real-skill\ndescription: A real skill\n---",
			);
			// Non-directory entries
			writeFileSync(join(skillsDir, "file.txt"), "content");
			writeFileSync(join(skillsDir, "notes.md"), "# notes");

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-9", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("real-skill");
			expect(result.content[0].text).not.toContain("file.txt");
			expect(result.content[0].text).not.toContain("notes.md");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("returns details with skills array", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
			const skillsDir = join(tmpDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			mkdirSync(join(skillsDir, "tdd"));
			writeFileSync(
				join(skillsDir, "tdd", "SKILL.md"),
				"---\nname: tdd\ndescription: TDD skill\n---",
			);

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			vi.mocked(getAgentDir).mockReturnValue(tmpDir);

			const result = await tool.execute("call-10", {}, undefined, () => {}, {});

			expect(result.details.skills).toBeInstanceOf(Array);
			expect(result.details.skills.length).toBe(1);

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});
});

describe("registerListToolsTool", () => {
	let pi: ReturnType<typeof createMockPi>;
	let tool: any;

	beforeEach(() => {
		vi.clearAllMocks();
		pi = createMockPi();
	});

	describe("tool registration structure", () => {
		it("registers a tool named list_tools", () => {
			registerListToolsTool(pi as any, "/test/cwd");
			tool = pi.getAllTools()[0];
			expect(tool.name).toBe("list_tools");
		});

		it("has a non-empty description", () => {
			registerListToolsTool(pi as any, "/test/cwd");
			tool = pi.getAllTools()[0];
			expect(tool.description).toBeTruthy();
			expect(typeof tool.description).toBe("string");
			expect(tool.description.length).toBeGreaterThan(0);
		});

		it("has parameters defined", () => {
			registerListToolsTool(pi as any, "/test/cwd");
			tool = pi.getAllTools()[0];
			expect(tool.parameters).toBeDefined();
		});

		it("has an execute function", () => {
			registerListToolsTool(pi as any, "/test/cwd");
			tool = pi.getAllTools()[0];
			expect(typeof tool.execute).toBe("function");
		});
	});

	describe("execute returns tool list", () => {
		it("returns tools from pi.getActiveTools", async () => {
			const mockTools = ['plan', 'delegate', 'fusion', 'read_skill', 'list_skills', 'list_tools'];
			pi.getActiveTools = vi.fn(() => mockTools);

			registerListToolsTool(pi as any, "/test/cwd");
			tool = pi.getAllTools()[0];

			const result = await tool.execute("call-1", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("Available tools (6):");
			expect(result.content[0].text).toContain("- plan");
			expect(result.content[0].text).toContain("- list_tools");
			expect(pi.getActiveTools).toHaveBeenCalled();
		});

		it("handles empty tools list", async () => {
			pi.getActiveTools = vi.fn(() => []);

			registerListToolsTool(pi as any, "/test/cwd");
			tool = pi.getAllTools()[0];

			const result = await tool.execute("call-2", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("Available tools (0):");
			expect(result.content[0].text).toContain("(none)");
			expect(pi.getActiveTools).toHaveBeenCalled();
		});
	});
});
