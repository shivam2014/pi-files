import { describe, it, expect } from "vitest";
import { extractText, getDefaultReasoningEffort } from "./fusion-tool";
import type { AssistantMessage } from "@earendil-works/pi-ai";

describe("extractText", () => {
	it("returns text from text-only response", () => {
		const response = {
			role: "assistant",
			content: [{ type: "text" as const, text: "hello world" }],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("hello world");
	});

	it("falls back to thinking when no text blocks", () => {
		const response = {
			role: "assistant",
			content: [{ type: "thinking" as const, thinking: "deep thought" }],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("deep thought");
	});

	it("falls back to thinking when text blocks are empty", () => {
		const response = {
			role: "assistant",
			content: [
				{ type: "text" as const, text: "" },
				{ type: "thinking" as const, thinking: "backup thought" },
			],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("backup thought");
	});

	it("joins mixed text and thinking, preferring text", () => {
		const response = {
			role: "assistant",
			content: [
				{ type: "text" as const, text: "first" },
				{ type: "thinking" as const, thinking: "ignored when text present" },
				{ type: "text" as const, text: "second" },
			],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("first\nsecond");
	});

	it("ignores toolCall blocks", () => {
		const response = {
			role: "assistant",
			content: [
				{ type: "text" as const, text: "analysis" },
				{ type: "toolCall" as const, id: "1", name: "reportFinding", arguments: { finding: "x" } },
			],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("analysis");
	});

	it("returns empty string for empty content array", () => {
		const response = {
			role: "assistant",
			content: [],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("");
	});
});

describe("getDefaultReasoningEffort", () => {
	it("prefers medium when present", () => {
		const model = {
			thinkingLevelMap: { low: "low", medium: "med", high: "high" },
		};
		expect(getDefaultReasoningEffort(model)).toBe("medium");
	});

	it("falls back to first non-null key", () => {
		const model = {
			thinkingLevelMap: { low: "low", high: "high" },
		};
		expect(getDefaultReasoningEffort(model)).toBe("low");
	});

	it("returns medium fallback for missing map", () => {
		expect(getDefaultReasoningEffort({})).toBe("medium");
		expect(getDefaultReasoningEffort({ thinkingLevelMap: null })).toBe("medium");
		expect(getDefaultReasoningEffort(undefined)).toBe("medium");
	});
});
