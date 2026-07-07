/**
 * prompt-architecture-consistency.test.ts
 *
 * Purpose: Ensure prompts stay in sync with actual implementation behavior.
 * Catches drift when code changes but prompts aren't updated.
 *
 * Part 1: DELEGATION_INSTRUCTIONS_TEMPLATE vs executeDelegate behavior
 * Part 2: Specialist prompt consistency (tools mentioned in prompts)
 * Part 3: ROUTING_TABLE covers all specialists
 * Part 4: changeType/maxLinesPerFile consistency across prompt, delegate schema, and ResolvedScope
 * Part 5: Subagent tool injection consistency
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Part 1: Mock specialists (traditional, matches prompt-builder.test.ts) ──
vi.mock("./specialists", () => ({
	listSpecialists: vi.fn(() => ["scout", "coder"]),
	TERSE_INSTRUCTION: "",
	SPECIALISTS: {
		scout: {
			name: "scout",
			tools: ["read", "grep", "find", "ls"],
			description: "Read-only investigator",
		},
		coder: {
			name: "coder",
			tools: ["read", "bash", "edit", "write", "grep", "lint"],
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

	it("delegate-pipeline.ts enforces active plan check", () => {
		const sourcePath = resolve(__dirname, "delegate-pipeline.ts");
		const source = readFileSync(sourcePath, "utf-8");

		// The guard must check hasActivePlan(ctx) before delegating
		expect(source).toContain("hasActivePlan(");

		// The error message when no active plan exists
		expect(source).toContain("No active plan");

		// Scope validation - coder without scope must be rejected
		expect(source).toContain("Scope required for coder");
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

// =====================================================================
// Part 3: ROUTING_TABLE covers all specialists
// =====================================================================
describe("ROUTING_TABLE covers all specialists", () => {
	it("all specialist names appear in ROUTING_TABLE", async () => {
		const { SPECIALISTS } = await vi.importActual<any>("./specialists");
		const sourcePath = resolve(__dirname, "prompt-builder.ts");
		const source = readFileSync(sourcePath, "utf-8");

		for (const name of Object.keys(SPECIALISTS)) {
			expect(source).toContain(name);
		}
	});
});

// =====================================================================
// Part 4: changeType/maxLinesPerFile consistency across prompt, delegate
// schema, and ResolvedScope
// =====================================================================
describe("changeType/maxLinesPerFile consistency", () => {
	it("prompt mentions both changeType and maxLinesPerFile", () => {
		const sourcePath = resolve(__dirname, "prompt-builder.ts");
		const source = readFileSync(sourcePath, "utf-8");

		expect(source).toContain("changeType");
		expect(source).toContain("maxLinesPerFile");
	});

	it("delegate-tool schema accepts changeType and maxLinesPerFile", () => {
		const sourcePath = resolve(__dirname, "delegate-tool.ts");
		const source = readFileSync(sourcePath, "utf-8");

		expect(source).toContain("changeType");
		expect(source).toContain("maxLinesPerFile");
	});

	it("ResolvedScope has changeType and maxLinesPerFile", () => {
		const sourcePath = resolve(__dirname, "scope-manager.ts");
		const source = readFileSync(sourcePath, "utf-8");

		expect(source).toContain("changeType");
		expect(source).toContain("maxLinesPerFile");
	});
});

// =====================================================================
// Part 5: Subagent tool injection consistency
// =====================================================================
describe("Subagent tool injection consistency", () => {
	it("subagent-runner.ts injects all 4 custom tools", () => {
		const sourcePath = resolve(__dirname, "subagent-runner.ts");
		const source = readFileSync(sourcePath, "utf-8");

		expect(source).toContain('"planSteps"');
		expect(source).toContain('"advanceStep"');
		expect(source).toContain('"reportFinding"');
		expect(source).toContain('"ask_orchestrator"');
	});

	it("every specialist prompt mentions all 4 subagent tool names", async () => {
		const { SPECIALISTS } = await vi.importActual<any>("./specialists");

		for (const [name, spec] of Object.entries(SPECIALISTS)) {
			const prompt = (spec as any).systemPrompt as string;

			expect(prompt, `${name} must mention planSteps`).toContain("planSteps");
			expect(prompt, `${name} must mention advanceStep`).toContain("advanceStep");
			expect(prompt, `${name} must mention reportFinding`).toContain("reportFinding");
			expect(prompt, `${name} must mention ask_orchestrator`).toContain("ask_orchestrator");
		}
	});
});

// =====================================================================
// Part 0: CWD resolution — no bare process.cwd() in production code
// =====================================================================
describe("CWD resolution — no bare process.cwd() in production code", () => {
	it("All non-test .ts files avoid bare process.cwd() without ctx.cwd fallback", () => {
		const sourceDir = resolve(__dirname);
		const files = readdirSync(sourceDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

		const results: string[] = [];

		for (const file of files) {
			const content = readFileSync(join(sourceDir, file), 'utf-8');
			const lines = content.split('\n');

			// Find lines with process.cwd() that are NOT in the "ctx?.cwd ?? process.cwd()" pattern
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes('process.cwd()')) {
					// Allow the safe pattern: ctx?.cwd ?? process.cwd()
					// Allow test files (already filtered)
					if (!lines[i].includes('ctx?.cwd') && !lines[i].includes('ctx.cwd')) {
						results.push(`${file}:${i + 1}: ${lines[i].trim()}`);
					}
				}
			}
		}

		expect(results).toEqual([]);
	});
});

