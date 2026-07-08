import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReadSkillTool } from "./read-skill-tool";

// Mock fs module
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	realpathSync: vi.fn((p: string) => p),
}));

// Mock getAgentDir
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn(() => "/home/user/.pi/agent"),
}));

function createMockPi() {
	const tools: any[] = [];
	return {
		registerTool: vi.fn((tool: any) => {
			tools.push(tool);
		}),
		getAllTools: () => tools,
	};
}

describe("createReadSkillTool", () => {
	let pi: ReturnType<typeof createMockPi>;
	let tool: any;

	beforeEach(() => {
		vi.clearAllMocks();
		pi = createMockPi();
		const definition = createReadSkillTool();
		pi.registerTool(definition);
		tool = pi.getAllTools()[0];
	});

	describe("tool registration structure", () => {
		it("registers a tool named read_skill", () => {
			expect(tool.name).toBe("read_skill");
		});

		it("has a non-empty description", () => {
			expect(tool.description).toBeTruthy();
			expect(typeof tool.description).toBe("string");
			expect(tool.description.length).toBeGreaterThan(0);
		});

		it("has parameters with a name field", () => {
			expect(tool.parameters).toBeDefined();
			expect(tool.parameters.properties?.name).toBeDefined();
		});

		it("has an execute function", () => {
			expect(typeof tool.execute).toBe("function");
		});
	});

	describe("execute with valid skill", () => {
		it("returns SKILL.md content for a valid skill name", async () => {
			const { existsSync, readFileSync } = await import("node:fs");
			// eslint-disable-next-line @typescript-eslint/no-extra-semi
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockReturnValue("# TDD Skill\n\nTest-driven development instructions.");

			const result = await tool.execute("call-1", { name: "tdd" }, undefined, () => {}, {});

			expect(result.content[0].text).toBe("# TDD Skill\n\nTest-driven development instructions.");
		});

		it("calls readFileSync with the correct path", async () => {
			const { existsSync, readFileSync } = await import("node:fs");
			(vi.mocked as any)(existsSync).mockReturnValue(true);
			(vi.mocked as any)(readFileSync).mockReturnValue("content");

			await tool.execute("call-2", { name: "implement" }, undefined, () => {}, {});

			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			expect(readFileSync).toHaveBeenCalledWith(
				expect.stringContaining("/home/user/.pi/agent/skills/implement/SKILL.md"),
				"utf-8",
			);
		});
	});

	describe("execute with unknown skill", () => {
		it("returns error message when skill does not exist", async () => {
			const { existsSync } = await import("node:fs");
			(vi.mocked as any)(existsSync).mockReturnValue(false);

			const result = await tool.execute("call-3", { name: "nonexistent" }, undefined, () => {}, {});

			expect(result.content[0].text).toContain("Error");
			expect(result.content[0].text).toContain("nonexistent");
		});
	});

	describe("path traversal protection", () => {
		it("blocks name with ..", async () => {
			const result = await tool.execute("call-4", { name: "../src/index.ts" }, undefined, () => {}, {});

			expect(result.content[0].text).toContain("Error");
			expect(result.content[0].text).toContain("blocked");
		});

		it("blocks name with forward slash", async () => {
			const result = await tool.execute("call-5", { name: "test/evil" }, undefined, () => {}, {});

			expect(result.content[0].text).toContain("Error");
			expect(result.content[0].text).toContain("blocked");
		});

		it("blocks name with backslash", async () => {
			const result = await tool.execute("call-6", { name: "test\\evil" }, undefined, () => {}, {});

			expect(result.content[0].text).toContain("Error");
			expect(result.content[0].text).toContain("blocked");
		});
	});
});
