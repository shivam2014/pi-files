import { describe, it, expect } from "vitest";
import { formatFusionResult, formatPanelResults } from "./fusion-format.ts";

describe("formatFusionResult", () => {
	const sampleAnalysis = {
		consensus: ["Use domain glossary terms", "Cache safety is cardinal"],
		contradictions: [
			{ topic: "Temperature cache scope", stances: [
				{ model: "minimax-m3", stance: "Keep in panel module" },
				{ model: "kimi-k2.7-2", stance: "Move to FusionRunContext" },
			]},
		],
		unique_insights: [
			{ model: "minimax-m3", insight: "Named intermediate types enable dataflow testing" },
		],
		blind_spots: ["Error taxonomy across modules"],
		recommendations: ["Add fusion-utils.ts", "Phase extraction"],
	};

	const sampleSucceeded = [
		{ model: "gpt4", reports: ["Use domain terms", "Fix cache"] },
		{ model: "claude", reports: ["Add tests"] },
	];

	const sampleJudge = { id: "judge-model" };

	it("renders consensus section", () => {
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, [], [], sampleJudge);
		expect(result).toContain("### Consensus");
		expect(result).toContain("Use domain glossary terms");
		expect(result).toContain("Cache safety is cardinal");
	});

	it("renders contradictions with stances", () => {
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, [], [], sampleJudge);
		expect(result).toContain("### Contradictions");
		expect(result).toContain("Temperature cache scope");
		expect(result).toContain("minimax-m3");
		expect(result).toContain("kimi-k2.7-2");
	});

	it("renders unique insights", () => {
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, [], [], sampleJudge);
		expect(result).toContain("### Unique Insights");
		expect(result).toContain("Named intermediate types enable dataflow testing");
	});

	it("renders blind spots", () => {
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, [], [], sampleJudge);
		expect(result).toContain("### Blind Spots");
		expect(result).toContain("Error taxonomy across modules");
	});

	it("renders recommendations", () => {
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, [], [], sampleJudge);
		expect(result).toContain("### Recommendations");
		expect(result).toContain("Add fusion-utils.ts");
	});

	it("renders panel section with reports", () => {
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, [], [], sampleJudge);
		expect(result).toContain("### Panel");
		expect(result).toContain("**gpt4**");
		expect(result).toContain("✓ Use domain terms");
		expect(result).toContain("**claude**");
	});

	it("renders failed section when failures present", () => {
		const failed = [{ model: "broken-model", error: "timeout" }];
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, failed, [], sampleJudge);
		expect(result).toContain("### Failed");
		expect(result).toContain("broken-model");
		expect(result).toContain("timeout");
	});

	it("renders judge section", () => {
		const result = formatFusionResult(sampleAnalysis, sampleSucceeded, [], [], sampleJudge);
		expect(result).toContain("### Judge");
		expect(result).toContain("**judge-model**");
	});

	it("handles empty analysis gracefully", () => {
		const result = formatFusionResult(null, [], [], [], sampleJudge);
		expect(result).toContain("## Fusion Analysis");
	});

	it("handles panel without reports (fallback to first line)", () => {
		const succeeded = [{ model: "test-model", content: "First line\nSecond line" }];
		const result = formatFusionResult(sampleAnalysis, succeeded, [], [], sampleJudge);
		expect(result).toContain("First line");
	});
});

describe("formatPanelResults", () => {
	it("formats succeeded responses", () => {
		const result = formatPanelResults(
			[{ model: "gpt4", content: "Analysis text" }],
			[],
		);
		expect(result.content[0].text).toContain("## Panel Responses");
		expect(result.content[0].text).toContain("### gpt4");
		expect(result.content[0].text).toContain("Analysis text");
	});

	it("shows no-succeeded message when empty", () => {
		const result = formatPanelResults([], []);
		expect(result.content[0].text).toContain("No panel model succeeded");
	});

	it("includes failed models", () => {
		const result = formatPanelResults(
			[],
			[{ model: "broken-model", error: "timeout" }],
		);
		expect(result.content[0].text).toContain("### Failed");
		expect(result.content[0].text).toContain("broken-model");
	});

	it("appends judge error when present", () => {
		const result = formatPanelResults(
			[],
			[{ model: "panel-fail", error: "crash" }],
			{ id: "judge-fail" },
			"judge error msg",
		);
		expect(result.content[0].text).toContain("judge-fail");
		expect(result.content[0].text).toContain("judge error msg");
	});

	it("shows no-judge message when judge model missing", () => {
		const result = formatPanelResults([], []);
		expect(result.content[0].text).toContain("No judge available");
	});
});
