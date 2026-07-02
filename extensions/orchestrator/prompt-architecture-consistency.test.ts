/**
 * prompt-architecture-consistency.test.ts
 *
 * Purpose: Ensure prompts stay in sync with actual implementation behavior.
 * Catches drift when code changes but prompts aren't updated.
 *
 * Part 1: DELEGATION_INSTRUCTIONS_TEMPLATE vs executeDelegate behavior
 * Part 2: Specialist prompt consistency (tools mentioned in prompts)
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Part 1: Mock specialists (traditional, matches prompt-builder.test.ts) ──
vi.mock("./specialists", () => ({
	listSpecialists: vi.fn(() => ["scout", "coder"]),
	SPECIALISTS: {
		scout: {
			name: "scout",
			tools: ["read", "grep", "find", "ls"],
			description: "Read-only investigator",
		},
		coder: {
			name: "coder",
			tools: ["read", "bash", "edit", "write", "lint"],
			description: "Implementation specialist",
		},
	},
	getSpecialist: vi.fn((name) => ({ name, tools: [], systemPrompt: "" })),
}));

import { buildOrchestratorPrompt } from "./prompt-builder.ts";

// =====================================================================
// Part 1: DELEGATION_INSTRUCTIONS_TEMPLATE vs executeDelegate behavior
// =====================================================================
describe("DELEGATION_INSTRUCTIONS_TEMPLATE vs executeDelegate", () => {
	it("systemPrompt requires plan() before delegate()", () => {
		const { systemPrompt } = buildOrchestratorPrompt({
			basePrompt: "",
			skills: [],
			fusionEnabled: false,
		});

		// The prompt MUST tell the LLM to call plan() before delegate()
		expect(systemPrompt).toContain("MUST call plan() before delegate()");

		// The prompt must NOT suggest auto-creating plans (old wrong behavior)
		expect(systemPrompt).not.toContain("auto-create");
	});

	it("delegate-controller.ts enforces active plan check", () => {
		const sourcePath = resolve(__dirname, "delegate-controller.ts");
		const source = readFileSync(sourcePath, "utf-8");

		// The guard must check hasActivePlan() before delegating
		expect(source).toContain("hasActivePlan()");

		// The error message when no active plan exists
		expect(source).toContain("No active plan");

		// The comment guard — must remain to prevent auto-creation drift
		expect(source).toContain("don't auto-create");
	});
});

// =====================================================================
// Part 2: Specialist prompt consistency
// =====================================================================
describe("Specialist prompt consistency", () => {
	it("every specialist with edit/write tools mentions file modification in prompt", async () => {
		const { SPECIALISTS } = await vi.importActual<Record<string, any>>("./specialists");

		for (const [name, spec] of Object.entries(SPECIALISTS)) {
			const s = spec as { tools: string[]; systemPrompt: string };
			const tools: string[] = s.tools;
			const prompt: string = s.systemPrompt;

			if (tools.includes("edit") || tools.includes("write")) {
				// Writable specialists should mention editing/creating files
				expect(prompt).toMatch(/edit|write|create/i);
			} else {
				// Read-only specialists should explicitly say they NEVER write
				expect(prompt).toMatch(/NEVER (write|make changes|write or edit|write files)/i);
			}
		}
	});

	it("specialist prompts mention their unique tooling", async () => {
		const { SPECIALISTS } = await vi.importActual<Record<string, any>>("./specialists");

		// Tools considered distinctive enough to warrant explicit mention in prompts.
		// Note: git-read and gh are excluded because scout's prompt doesn't
		// name them individually (they're implied via Minimal Action examples).
		const DISTINCTIVE_TOOLS = new Set([
			"web_search",
			"fetch_content",
			"lint",
			"edit",
			"write",
		]);

		for (const [name, spec] of Object.entries(SPECIALISTS)) {
			const s = spec as { tools: string[]; systemPrompt: string };
			const tools: string[] = s.tools;
			const prompt: string = s.systemPrompt;
			const distinctive = tools.filter((t) => DISTINCTIVE_TOOLS.has(t));

			for (const tool of distinctive) {
				expect(prompt).toContain(tool);
			}
		}
	});

	it("grep tool is mentioned in prompts for specialists that have it", async () => {
		const { SPECIALISTS } = await vi.importActual<any>("./specialists");

		for (const [name, spec] of Object.entries(SPECIALISTS)) {
			const s = spec as { tools: string[]; systemPrompt: string };
			const tools: string[] = s.tools;
			const prompt: string = s.systemPrompt;

			if (tools.includes("grep")) {
				expect(prompt).toContain("grep");
			}
		}
	});
});
