import { describe, it, expect, vi, beforeEach } from "vitest";
import { SPECIALISTS, getSpecialistSkills, listSpecialists } from "./specialists";

describe("specialist default skills (#42)", () => {
	it("scout has diagnosing-bugs as default skill", () => {
		expect(SPECIALISTS.scout.suggestedSkills).toContain("diagnosing-bugs");
	});

	it("coder has implement and tdd as default skills", () => {
		expect(SPECIALISTS.coder.suggestedSkills).toContain("implement");
		expect(SPECIALISTS.coder.suggestedSkills).toContain("tdd");
	});

	it("reviewer has code-review as default skill", () => {
		expect(SPECIALISTS.reviewer.suggestedSkills).toContain("code-review");
	});

	it("researcher has domain-modeling as default skill", () => {
		expect(SPECIALISTS.researcher.suggestedSkills).toContain("domain-modeling");
	});

	it("writer has agents-md-writer as default skill", () => {
		expect(SPECIALISTS.writer.suggestedSkills).toContain("agents-md-writer");
	});

	it("all specialists have suggestedSkills array", () => {
		for (const name of listSpecialists()) {
			expect(Array.isArray(SPECIALISTS[name].suggestedSkills)).toBe(true);
			expect(SPECIALISTS[name].suggestedSkills!.length).toBeGreaterThan(0);
		}
	});
});

describe("getSpecialistSkills (#42)", () => {
	it("returns merge of defaults and override when override provided", () => {
		const result = getSpecialistSkills("coder", ["code-review"]);
		expect(result).toEqual(["implement", "tdd", "code-review"]);
	});

	it("returns defaults when no override given", () => {
		const result = getSpecialistSkills("coder");
		expect(result).toContain("implement");
		expect(result).toContain("tdd");
	});

	it("returns empty array for unknown specialist with no override", () => {
		const result = getSpecialistSkills("nonexistent");
		expect(result).toEqual([]);
	});

	it("returns override for unknown specialist when override provided", () => {
		const result = getSpecialistSkills("nonexistent", ["tdd"]);
		expect(result).toEqual(["tdd"]);
	});

	it("empty override array returns defaults unchanged", () => {
		const result = getSpecialistSkills("coder", []);
		expect(result).toEqual(["implement", "tdd"]);
	});
});
