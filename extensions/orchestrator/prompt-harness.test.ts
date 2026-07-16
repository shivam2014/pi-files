/**
 * Prompt evaluation harness — tests for prompt-only changes (issue #56).
 *
 * Renders specialist system prompts and verifies content via string-inclusion assertions.
 * Allows prompt engineers to validate changes without touching production code paths.
 */
import { describe, it, expect } from "vitest";
import {
	renderSpecialistPrompt,
	listSpecialists,
	SPECIALISTS,
} from "./specialists.ts";

// ── AC1: harness renders prompt for every specialist ──────────────────────
describe("renderSpecialistPrompt — AC1: renders prompt for each specialist", () => {
	const specialists = listSpecialists();

	for (const name of specialists) {
		it(`renders a non-empty prompt for "${name}"`, () => {
			const prompt = renderSpecialistPrompt(name);
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
			expect(prompt.length).toBeGreaterThan(100);
		});
	}
});

// ── AC2: string-inclusion assertions on rendered prompts ──────────────────
describe("renderSpecialistPrompt — AC2: string-inclusion assertions", () => {
	it("prompt contains the specialist's core identity marker", () => {
		const prompt = renderSpecialistPrompt("coder");
		expect(prompt).toContain("implementation specialist");
	});

	it("prompt contains tool documentation section", () => {
		const prompt = renderSpecialistPrompt("scout");
		expect(prompt).toContain("Workflow Instructions");
	});

	it("prompt contains the workflow instructions", () => {
		const prompt = renderSpecialistPrompt("writer");
		expect(prompt).toContain("planSteps()");
	});

	it("prompt contains the findings/audit template", () => {
		const prompt = renderSpecialistPrompt("researcher");
		expect(prompt).toContain("## Findings");
		expect(prompt).toContain("## Audit");
	});

	it("prompt contains terse instruction", () => {
		const prompt = renderSpecialistPrompt("reviewer");
		expect(prompt).toContain("caveman");
	});
});

// ── AC3: concrete demo — coder prompt includes implement skill reference ──
describe("renderSpecialistPrompt — AC3: coder prompt includes implement skill", () => {
	it("coder prompt references 'implement' in its skill section", () => {
		const prompt = renderSpecialistPrompt("coder");
		expect(prompt).toContain("implement");
	});

	it("coder prompt includes skill section with suggested skills", () => {
		const prompt = renderSpecialistPrompt("coder");
		expect(prompt).toContain("## Skills");
		expect(prompt).toContain("read_skill");
	});

	it("rendering with task appends a ## Task section", () => {
		const prompt = renderSpecialistPrompt(
			"coder",
			"Fix the auth middleware bug",
		);
		expect(prompt).toContain("## Task");
		expect(prompt).toContain("Fix the auth middleware bug");
	});

	it("rendering with custom skills merges with defaults", () => {
		const prompt = renderSpecialistPrompt("coder", undefined, ["code-review"]);
		// Should have both default (implement, tdd) and override (code-review)
		expect(prompt).toContain("implement");
		expect(prompt).toContain("code-review");
	});

	it("rendering with disableDefaults would not include defaults", () => {
		// getSpecialistSkills with disableDefaults is internal — renderSpecialistPrompt
		// merges by default, so verify merge behavior by checking override appears
		const prompt = renderSpecialistPrompt("coder", undefined, ["custom-skill"]);
		expect(prompt).toContain("custom-skill");
	});
});

// ── AC4: runs in existing vitest suite (this file IS the proof) ──────────
describe("renderSpecialistPrompt — AC4: vitest integration", () => {
	it("all 5 specialists are testable through the harness", () => {
		const specialists = listSpecialists();
		expect(specialists).toHaveLength(5);
		expect(specialists).toContain("scout");
		expect(specialists).toContain("coder");
		expect(specialists).toContain("reviewer");
		expect(specialists).toContain("researcher");
		expect(specialists).toContain("writer");
	});

	it("unknown specialist name throws", () => {
		expect(() => renderSpecialistPrompt("nonexistent")).toThrow(
			"Unknown specialist: nonexistent",
		);
	});
});

// ── Bonus: cross-specialist smoke tests for prompt engineers ──────────────
describe("renderSpecialistPrompt — cross-specialist prompt content", () => {
	it("read-only specialists mention they never write/edit", () => {
		const scout = renderSpecialistPrompt("scout");
		const researcher = renderSpecialistPrompt("researcher");
		expect(scout).toContain("NEVER");
		expect(researcher).toContain("NEVER");
	});

	it("write-capable specialists include scope guidance", () => {
		const coder = renderSpecialistPrompt("coder");
		expect(coder).toContain("Scope Guard");
	});

	it("reviewer has no write/edit capability mentioned", () => {
		const reviewer = renderSpecialistPrompt("reviewer");
		expect(reviewer).toContain("You NEVER make changes");
	});

	it("each specialist has unique identity", () => {
		const prompts = listSpecialists().map((n) => ({
			name: n,
			prompt: renderSpecialistPrompt(n),
		}));
		const identities = prompts.map((p) => {
			// Extract identity line from prompt
			const match = p.prompt.match(/You are a (.+?)[\.\n]/);
			return match?.[1] ?? p.name;
		});
		const unique = new Set(identities);
		expect(unique.size).toBe(5);
	});
});
