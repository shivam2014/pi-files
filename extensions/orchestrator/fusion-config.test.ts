import { describe, it, expect } from "vitest";
import { getDefaultReasoningEffort, sanitizeFusionConfig } from "./fusion-config.ts";

describe("getDefaultReasoningEffort", () => {
	it("returns medium for null model", () => {
		expect(getDefaultReasoningEffort(null)).toBe("medium");
	});

	it("returns medium when thinkingLevelMap has medium", () => {
		const model = { thinkingLevelMap: { low: 1, medium: 2, high: 3 } };
		expect(getDefaultReasoningEffort(model)).toBe("medium");
	});

	it("returns first available key when no medium", () => {
		const model = { thinkingLevelMap: { low: 1, high: 3 } };
		expect(getDefaultReasoningEffort(model)).toBe("low");
	});

	it("returns medium when thinkingLevelMap is missing", () => {
		const model = {};
		expect(getDefaultReasoningEffort(model)).toBe("medium");
	});

	it("returns medium when thinkingLevelMap is not an object", () => {
		const model = { thinkingLevelMap: "invalid" };
		expect(getDefaultReasoningEffort(model)).toBe("medium");
	});
});

describe("sanitizeFusionConfig", () => {
	const availableModels = ["provider1/gpt4", "provider2/claude", "provider3/llama"];

	it("filters out unavailable panel models", () => {
		const { config, removed } = sanitizeFusionConfig(
			{ panel: ["provider1/gpt4", "nonexistent/model"], judge: "provider2/claude" },
			availableModels,
		);
		expect(config.panel).toEqual(["provider1/gpt4"]);
		expect(removed).toEqual(["nonexistent/model"]);
	});

	it("removes unavailable judge model", () => {
		const { config, removed } = sanitizeFusionConfig(
			{ panel: ["provider1/gpt4"], judge: "nonexistent/judge" },
			availableModels,
		);
		expect(config.judge).toBe("");
		expect(removed).toContain("nonexistent/judge");
	});

	it("fills defaults for missing fields", () => {
		const { config } = sanitizeFusionConfig({}, availableModels);
		expect(config.enabled).toBe(true);
		expect(config.panel).toEqual([]);
		expect(config.judge).toBe("");
		expect(config.maxPanelModels).toBe(3);
		expect(config.temperature).toBe(0.3);
		expect(config.maxTokensPerPanel).toBe(2048);
		expect(config.maxTokensForJudge).toBe(4096);
	});

	it("preserves valid config as-is", () => {
		const input = {
			enabled: false,
			panel: ["provider1/gpt4", "provider2/claude"],
			judge: "provider3/llama",
			maxPanelModels: 5,
			temperature: 0.7,
			maxTokensPerPanel: 1024,
			maxTokensForJudge: 2048,
		};
		const { config, removed } = sanitizeFusionConfig(input, availableModels);
		expect(config).toMatchObject(input);
		expect(removed).toEqual([]);
	});
});
