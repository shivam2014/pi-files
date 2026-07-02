import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerListSkillsTool, registerListToolsTool } from "./introspection-tools";

// Mock fs module
vi.mock("node:fs", () => ({
	readdirSync: vi.fn(),
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

// Mock getAgentDir
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn(() => "/home/user/.pi/agent"),
}));

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
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "tdd" },
				{ isDirectory: () => true, name: "review" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockImplementation((path: string) => {
				if (path.includes("tdd")) {
					return "---\nname: tdd\ndescription: Test-driven development.\n---\n# TDD";
				}
				if (path.includes("review")) {
					return "---\nname: review\ndescription: Review code changes.\n---\n# Review";
				}
				return "";
			});

			const result = await tool.execute("call-1", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("• tdd: Test-driven development.");
			expect(result.content[0].text).toContain("• review: Review code changes.");
		});

		it("falls back to directory name when frontmatter has no name", async () => {
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "custom-skill" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockReturnValue(
				"---\ndescription: A custom skill.\n---\n# Content",
			);

			const result = await tool.execute("call-2", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("• custom-skill: A custom skill.");
		});

		it("shows fallback description when frontmatter has no description", async () => {
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "minimal" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockReturnValue("---\nname: minimal\n---\n# Content");

			const result = await tool.execute("call-3", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("• minimal: (no description)");
		});
	});

	describe("execute edge cases", () => {
		it("returns error when skills directory does not exist", async () => {
			const { readdirSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockImplementation(() => {
				throw new Error("ENOENT");
			});

			const result = await tool.execute("call-4", {}, undefined, () => {}, {});

			expect(result.content[0].text).toBe("No skills directory found.");
		});

		it("returns empty message when no skills directories found", async () => {
			const { readdirSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([]);

			const result = await tool.execute("call-5", {}, undefined, () => {}, {});

			expect(result.content[0].text).toBe("No skills found.");
		});

		it("handles SKILL.md read error gracefully", async () => {
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "broken" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockImplementation(() => {
				throw new Error("permission denied");
			});

			const result = await tool.execute("call-6", {}, undefined, () => {}, {});

			expect(result.content[0].text).toBe("No skills found.");
		});

		it("reads SKILL.md with correct path", async () => {
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "tdd" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockReturnValue("---\nname: tdd\ndescription: TDD\n---");

			await tool.execute("call-7", {}, undefined, () => {}, {});

			expect(readFileSync).toHaveBeenCalledWith(
				expect.stringContaining("/home/user/.pi/agent/skills/tdd/SKILL.md"),
				"utf-8",
			);
		});

		it("sorts skills alphabetically", async () => {
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "zeta" },
				{ isDirectory: () => true, name: "alpha" },
				{ isDirectory: () => true, name: "beta" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockImplementation((path: string) => {
				const name = path.split("/").slice(-2, -1)[0];
				return `---\nname: ${name}\ndescription: ${name} skill\n---`;
			});

			const result = await tool.execute("call-8", {}, undefined, () => {}, {});

			const lines = result.content[0].text.split("\n");
			expect(lines[0]).toContain("alpha");
			expect(lines[1]).toContain("beta");
			expect(lines[2]).toContain("zeta");
		});

		it("skips non-directory entries", async () => {
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "real-skill" },
				{ isDirectory: () => false, name: "file.txt" },
				{ isDirectory: () => false, name: "notes.md" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockReturnValue(
				"---\nname: real-skill\ndescription: A real skill\n---",
			);

			const result = await tool.execute("call-9", {}, undefined, () => {}, {});

			expect(result.content[0].text).toContain("real-skill");
			expect(result.content[0].text).not.toContain("file.txt");
			expect(result.content[0].text).not.toContain("notes.md");
		});

		it("returns details with skills array", async () => {
			const { readdirSync, existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(readdirSync).mockReturnValue([
				{ isDirectory: () => true, name: "tdd" },
			]);
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockReturnValue(
				"---\nname: tdd\ndescription: TDD skill\n---",
			);

			const result = await tool.execute("call-10", {}, undefined, () => {}, {});

			expect(result.details.skills).toBeInstanceOf(Array);
			expect(result.details.skills.length).toBe(1);
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
