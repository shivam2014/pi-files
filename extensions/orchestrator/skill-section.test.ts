import { describe, it, expect } from "vitest";
import { buildSkillSection } from "./specialists";
import { listAvailableSkillNames } from "./skill-resolver";

/**
 * Tests for the compact subagent skill section (skill-index reduction).
 *
 * The old section was a 7-line condition table + one line per skill (~16k-char
 * XML index). The new form is a names-only roster that still gives full
 * discovery via the extension's own on-disk skill enumeration.
 */
describe("buildSkillSection — compact names roster", () => {
	it("returns empty string when no skills provided", () => {
		expect(buildSkillSection("coder", [])).toBe("");
		expect(buildSkillSection("coder", undefined as unknown as string[])).toBe("");
	});

	it("renders the section header and read_skill instruction", () => {
		const section = buildSkillSection("coder", ["implement", "tdd"]);
		expect(section).toContain("## Skills");
		expect(section).toContain('Load any skill with read_skill("<name>")');
	});

	it("lists the specialist pack by name", () => {
		const section = buildSkillSection("coder", ["implement", "tdd"]);
		expect(section).toContain("Your pack: implement, tdd");
	});

	it("enumerates the full on-disk roster (names-only, no descriptions)", () => {
		const section = buildSkillSection("coder", ["implement", "tdd"]);
		expect(section).toContain("All available:");

		const available = listAvailableSkillNames();
		expect(available.length).toBeGreaterThan(0);
		for (const name of available) {
			expect(section).toContain(name);
		}
		// `implement` and `tdd` are real on-disk skills, so the roster must include them.
		expect(available).toContain("implement");
		expect(available).toContain("tdd");
	});

	it("stays compact (names-only, well under the old ~16k index size)", () => {
		const section = buildSkillSection("coder", ["implement", "tdd"]);
		// Target ~1,100 chars. Assert a generous ceiling that still proves the
		// description-free, names-only reduction.
		expect(section.length).toBeLessThan(2000);
	});

	it("honours the merged pack (defaults + override)", () => {
		const section = buildSkillSection("coder", ["implement", "tdd", "code-review"]);
		expect(section).toContain("Your pack: implement, tdd, code-review");
	});
});

describe("listAvailableSkillNames", () => {
	it("returns a sorted, deduplicated array of skill names", () => {
		const names = listAvailableSkillNames();
		expect(Array.isArray(names)).toBe(true);
		expect(new Set(names).size).toBe(names.length);
		expect([...names].sort()).toEqual(names);
	});
});
