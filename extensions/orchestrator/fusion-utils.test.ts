import { describe, it, expect } from "vitest";
import { extractText, mapWithConcurrencyLimit } from "./fusion-utils.ts";

describe("extractText", () => {
	it("extracts text blocks from assistant message", () => {
		const msg = {
			content: [
				{ type: "text" as const, text: "Hello" },
				{ type: "text" as const, text: "World" },
			],
		} as any;
		expect(extractText(msg)).toBe("Hello\nWorld");
	});

	it("falls back to thinking blocks when no text", () => {
		const msg = {
			content: [
				{ type: "thinking" as const, thinking: "deep thought" },
			],
		} as any;
		expect(extractText(msg)).toBe("deep thought");
	});

	it("returns empty string for empty content", () => {
		const msg = { content: [] } as any;
		expect(extractText(msg)).toBe("");
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("processes all items with concurrency limit", async () => {
		const result = await mapWithConcurrencyLimit([1, 2, 3], 2, async (n) => n * 2);
		expect(result).toEqual([2, 4, 6]);
	});

	it("handles empty array", async () => {
		const result = await mapWithConcurrencyLimit([], 2, async (n) => n);
		expect(result).toEqual([]);
	});

	it("respects concurrency limit", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const result = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (n) => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((r) => setTimeout(r, 10));
			concurrent--;
			return n;
		});
		expect(result).toEqual([1, 2, 3, 4]);
		expect(maxConcurrent).toBeLessThanOrEqual(2);
	});

	it("rejects when any item fails", async () => {
		await expect(
			mapWithConcurrencyLimit([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error("fail");
				return n;
			}),
		).rejects.toThrow("fail");
	});
});
