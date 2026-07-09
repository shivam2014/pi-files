import { describe, it, expect } from "vitest";
import { parsePanelAnalysis } from "./fusion-pipeline.ts";

describe("parsePanelAnalysis", () => {
	it("parses valid JSON with all fields", () => {
		const input = JSON.stringify({
			consensus: ["All models agree on scope"],
			contradictions: [{ topic: "Timeline", position: "Q3 vs Q4" }],
			unique_insights: ["Model A found edge case"],
			blind_spots: ["No one considered cost"],
			recommendations: ["Extend timeline"],
		});
		const result = parsePanelAnalysis(input);
		expect(result).toEqual({
			consensus: ["All models agree on scope"],
			contradictions: [{ topic: "Timeline", position: "Q3 vs Q4" }],
			unique_insights: ["Model A found edge case"],
			blind_spots: ["No one considered cost"],
			recommendations: ["Extend timeline"],
		});
	});

	it("fills missing fields with empty arrays", () => {
		const input = JSON.stringify({ consensus: ["point 1"] });
		const result = parsePanelAnalysis(input);
		expect(result).toEqual({
			consensus: ["point 1"],
			contradictions: [],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		});
	});

	it("returns null for invalid JSON", () => {
		expect(parsePanelAnalysis("not json at all")).toBeNull();
	});

	it("returns null when no JSON found in text", () => {
		expect(parsePanelAnalysis("Just plain text with no JSON anywhere")).toBeNull();
	});

	it("returns empty arrays for empty object", () => {
		const result = parsePanelAnalysis("{}");
		expect(result).toEqual({
			consensus: [],
			contradictions: [],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		});
	});

	it("returns empty arrays for non-object JSON (array)", () => {
		// Arrays pass typeof check; missing fields default to []
		const result = parsePanelAnalysis('[{"topic": "a"}]');
		expect(result).toEqual({
			consensus: [],
			contradictions: [],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		});
	});

	it("returns null for non-object JSON (string)", () => {
		expect(parsePanelAnalysis('"just a string"')).toBeNull();
	});

	it("returns empty arrays when fields are not arrays", () => {
		const input = JSON.stringify({
			consensus: "not an array",
			contradictions: 42,
			unique_insights: true,
			blind_spots: null,
			recommendations: { nested: "object" },
		});
		const result = parsePanelAnalysis(input);
		expect(result).toEqual({
			consensus: [],
			contradictions: [],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		});
	});

	it("parses JSON wrapped in markdown fences", () => {
		const payload = {
			consensus: ["agreed"],
			contradictions: [],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		};
		const input = "Here is my analysis:\n```json\n" + JSON.stringify(payload) + "\n```\nDone.";
		const result = parsePanelAnalysis(input);
		expect(result).toEqual(payload);
	});

	it("parses nested contradictions with topic and position", () => {
		const input = JSON.stringify({
			consensus: [],
			contradictions: [
				{ topic: "API design", position: "REST vs GraphQL" },
				{ topic: "Database", position: "SQL vs NoSQL" },
			],
			unique_insights: [],
			blind_spots: [],
			recommendations: [],
		});
		const result = parsePanelAnalysis(input);
		expect(result?.contradictions).toHaveLength(2);
		expect(result?.contradictions?.[0]).toEqual({ topic: "API design", position: "REST vs GraphQL" });
		expect(result?.contradictions?.[1]).toEqual({ topic: "Database", position: "SQL vs NoSQL" });
	});
});
