import { describe, it, expect, vi, beforeEach } from "vitest";
import { SPECIALISTS, getSpecialistSkills, listSpecialists } from "./specialists";

describe("specialist default skills (#42)", () => {
	it("scout has diagnosing-bugs as default skill", () => {
		expect(SPECIALISTS.scout.skills).toContain("diagnosing-bugs");
	});

	it("coder has implement and tdd as default skills", () => {
		expect(SPECIALISTS.coder.skills).toContain("implement");
		expect(SPECIALISTS.coder.skills).toContain("tdd");
	});

	it("reviewer has review as default skill", () => {
		expect(SPECIALISTS.reviewer.skills).toContain("review");
	});

	it("researcher has domain-modeling as default skill", () => {
		expect(SPECIALISTS.researcher.skills).toContain("domain-modeling");
	});

	it("writer has agents-md-writer as default skill", () => {
		expect(SPECIALISTS.writer.skills).toContain("agents-md-writer");
	});

	it("all specialists have a skills array", () => {
		for (const name of listSpecialists()) {
			expect(Array.isArray(SPECIALISTS[name].skills)).toBe(true);
			expect(SPECIALISTS[name].skills!.length).toBeGreaterThan(0);
		}
	});
});

describe("getSpecialistSkills (#42)", () => {
	it("returns override when provided (replaces defaults)", () => {
		const result = getSpecialistSkills("coder", ["review"]);
		expect(result).toEqual(["review"]);
		expect(result).not.toContain("implement");
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

	it("empty override array replaces defaults (not appends)", () => {
		const result = getSpecialistSkills("coder", []);
		expect(result).toEqual([]);
	});
});
