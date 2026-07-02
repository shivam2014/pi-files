import { describe, it, expect } from "vitest";
import { extractJsonObject, parseJudgeAnalysis } from "./fusion-judge.ts";

describe("extractJsonObject", () => {
	it("extracts JSON from markdown fences", () => {
		const input = 'Some text\n```json\n{"key": "value"}\n```\nmore text';
		expect(extractJsonObject(input)).toBe('{"key": "value"}');
	});

	it("extracts JSON from plain text", () => {
		const input = '{"key": "value"}';
		expect(extractJsonObject(input)).toBe('{"key": "value"}');
	});

	it("returns null for empty input", () => {
		expect(extractJsonObject("")).toBeNull();
		expect(extractJsonObject(null as any)).toBeNull();
	});

	it("handles nested JSON objects", () => {
		const input = '{"outer": {"inner": [1, 2, 3]}}';
		expect(extractJsonObject(input)).toBe('{"outer": {"inner": [1, 2, 3]}}');
	});

	it("returns last JSON object when multiple", () => {
		const input = '{"first": 1} some text {"second": 2}';
		expect(extractJsonObject(input)).toBe('{"second": 2}');
	});

	it("handles JSON with string containing braces", () => {
		const input = '{"data": "hello {world}"}';
		expect(extractJsonObject(input)).toBe('{"data": "hello {world}"}');
	});

	it("returns null for text with no JSON object", () => {
		expect(extractJsonObject("just text [1, 2, 3]")).toBeNull();
	});
});

describe("parseJudgeAnalysis", () => {
	const validFull = {
		consensus: ["point 1", "point 2"],
		contradictions: [{ topic: "topic A", stances: [{ model: "model1", stance: "yes" }] }],
		unique_insights: [{ model: "model1", insight: "unique thought" }],
		blind_spots: ["spot 1"],
		recommendations: ["rec 1"],
	};

	it("parses valid fusion analysis JSON", () => {
		const input = JSON.stringify(validFull);
		const result = parseJudgeAnalysis(input);
		expect(result).toEqual(validFull);
	});

	it("returns null for invalid JSON", () => {
		expect(parseJudgeAnalysis("{not json}")).toBeNull();
	});

	it("returns null for missing required fields", () => {
		const input = JSON.stringify({ consensus: ["point 1"] });
		expect(parseJudgeAnalysis(input)).toBeNull();
	});

	it("returns null for wrong types", () => {
		const input = JSON.stringify({ ...validFull, consensus: "not an array" });
		expect(parseJudgeAnalysis(input)).toBeNull();
	});

	it("parses JSON inside markdown fences", () => {
		const input = "Here is my analysis:\n```json\n" + JSON.stringify(validFull) + "\n```";
		const result = parseJudgeAnalysis(input);
		expect(result).toEqual(validFull);
	});

	it("handles empty arrays", () => {
		const input = JSON.stringify({
			consensus: [],
			contradictions: [],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		});
		const result = parseJudgeAnalysis(input);
		expect(result).toEqual({
			consensus: [],
			contradictions: [],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		});
	});
});
