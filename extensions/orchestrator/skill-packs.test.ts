import { describe, it, expect } from "vitest";
import {
	SKILL_PACKS,
	composePacks,
	suggestPacks,
	listPacks,
	isPack,
	type SkillPackName,
} from "./skill-packs";

describe("SKILL_PACKS registry", () => {
	it("exposes the expected pack names", () => {
		expect(listPacks()).toEqual(
			expect.arrayContaining([
				"clarification",
				"minimalAction",
				"tdd",
				"diagnosis",
				"reviewTwoAxis",
				"prototype",
				"implementCadence",
				"researcherHygiene",
				"agentBrief",
				"domainModeling",
				"handoff",
				"qaIssue",
				"glossaryTerms",
			]),
		);
	});

	it("every pack is a non-empty string under the word budget", () => {
		for (const [name, text] of Object.entries(SKILL_PACKS)) {
			expect(typeof text, `${name} must be string`).toBe("string");
			expect(text.trim().length, `${name} must be non-empty`).toBeGreaterThan(0);
			const words = text.trim().split(/\s+/).length;
			expect(words, `${name} exceeds word budget (got ${words})`).toBeLessThanOrEqual(160);
		}
	});
});

describe("composePacks", () => {
	it("returns base prompt unchanged when packs is undefined", () => {
		expect(composePacks("BASE", undefined)).toBe("BASE");
	});

	it("returns base prompt unchanged when packs is empty", () => {
		expect(composePacks("BASE", [])).toBe("BASE");
	});

	it("appends a single pack with separators", () => {
		const out = composePacks("BASE", ["clarification"]);
		expect(out).toBe(`BASE\n\n${SKILL_PACKS.clarification}`);
	});

	it("appends multiple packs in declared order", () => {
		const out = composePacks("BASE", ["minimalAction", "clarification"]);
		expect(out).toBe(`BASE\n\n${SKILL_PACKS.minimalAction}\n\n${SKILL_PACKS.clarification}`);
	});

	it("dedupes repeated pack names", () => {
		const out = composePacks("BASE", ["tdd", "tdd", "tdd"]);
		expect(out).toBe(`BASE\n\n${SKILL_PACKS.tdd}`);
	});

	it("ignores unknown pack names (fail soft)", () => {
		const out = composePacks("BASE", ["nonsense", "clarification", "alsoFake"]);
		expect(out).toBe(`BASE\n\n${SKILL_PACKS.clarification}`);
	});

	it("returns base unchanged when all names are unknown", () => {
		expect(composePacks("BASE", ["nope", "alsoNope"])).toBe("BASE");
	});

	it("preserves declaration order, not alphabetical", () => {
		const reversed = composePacks("BASE", ["clarification", "minimalAction"]);
		expect(reversed).toBe(`BASE\n\n${SKILL_PACKS.clarification}\n\n${SKILL_PACKS.minimalAction}`);
	});

	it("substitutes glossaryTerms {{TERMS}} placeholder", () => {
		const out = composePacks("BASE", ["glossaryTerms"], {
			glossaryTerms: "- ScopeGuard: thin enforcement adapter\n- DelegateController: per-delegation lifecycle",
		});
		expect(out).toContain("ScopeGuard: thin enforcement adapter");
		expect(out).toContain("DelegateController: per-delegation lifecycle");
		expect(out).not.toContain("{{TERMS}}");
	});

	it("leaves {{TERMS}} in place when no replacement given", () => {
		const out = composePacks("BASE", ["glossaryTerms"]);
		expect(out).toContain("{{TERMS}}");
	});
});

describe("suggestPacks", () => {
	it("returns empty for a task with no trigger keywords", () => {
		expect(suggestPacks("read the auth middleware")).toEqual([]);
	});

	it("suggests diagnosis for bug work", () => {
		expect(suggestPacks("investigate the login crash bug")).toContain("diagnosis");
		expect(suggestPacks("fix the flaky test race condition")).toContain("diagnosis");
		expect(suggestPacks("debug the deadlock in the worker")).toContain("diagnosis");
	});

	it("suggests tdd for test-bearing work", () => {
		expect(suggestPacks("write unit tests for the parser")).toContain("tdd");
		expect(suggestPacks("do TDD on the new endpoint")).toContain("tdd");
	});

	it("suggests reviewTwoAxis for review work", () => {
		expect(suggestPacks("review this diff")).toContain("reviewTwoAxis");
		expect(suggestPacks("critique the pull request")).toContain("reviewTwoAxis");
	});

	it("suggests prototype for throwaway work", () => {
		expect(suggestPacks("build a prototype of the state model")).toContain("prototype");
		expect(suggestPacks("spike the integration POC")).toContain("prototype");
	});

	it("suggests qaIssue for issue filing", () => {
		expect(suggestPacks("file an issue for the regression")).toContain("qaIssue");
		expect(suggestPacks("gh issue create for the bug")).toContain("qaIssue");
	});

	it("suggests handoff for handoff doc work", () => {
		expect(suggestPacks("write a handoff for the next session")).toContain("handoff");
	});

	it("suggests agentBrief for spec authoring", () => {
		expect(suggestPacks("write a spec for the new module")).toContain("agentBrief");
	});

	it("never returns mutually-exclusive tdd + prototype together", () => {
		// "build a prototype with tests" triggers both — prototype wins, tdd dropped.
		const s = suggestPacks("build a prototype with tests");
		expect(s).not.toContain("tdd");
		expect(s).toContain("prototype");
	});

	it("caps suggestions at 3", () => {
		// Craft a task hitting many triggers.
		const s = suggestPacks("review the prototype diff and file an issue");
		expect(s.length).toBeLessThanOrEqual(3);
	});
});

describe("isPack / listPacks", () => {
	it("isPack narrows known names", () => {
		expect(isPack("tdd")).toBe(true);
		expect(isPack("clarification")).toBe(true);
		expect(isPack("bogus")).toBe(false);
		// type-level usage
		const x: SkillPackName = "tdd";
		expect(isPack(x)).toBe(true);
	});

	it("listPacks returns all keys", () => {
		const names = listPacks();
		expect(names.length).toBe(Object.keys(SKILL_PACKS).length);
	});
});
