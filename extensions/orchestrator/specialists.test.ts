import { describe, it, expect } from "vitest";
import { generateToolPrompt } from "/Users/shivam94/.pi/agent/extensions/orchestrator/specialists.ts";

describe("generateToolPrompt (exported)", () => {
	it("returns a string containing all provided tool names", () => {
		const result = generateToolPrompt(["read", "grep", "edit"]);
		expect(result).toContain("read");
		expect(result).toContain("grep");
		expect(result).toContain("edit");
	});

	it("formats tool list as comma-separated", () => {
		const result = generateToolPrompt(["read", "grep"]);
		expect(result).toContain("read, grep");
	});

	it("includes 'Your available tools' header", () => {
		const result = generateToolPrompt(["bash"]);
		expect(result).toContain("Your available tools");
	});

	it("mentions bash restriction when bash not in list", () => {
		const result = generateToolPrompt(["read", "grep"]);
		expect(result).toContain("You do NOT have bash");
	});

	it("handles single tool", () => {
		const result = generateToolPrompt(["read"]);
		expect(result).toContain("read");
	});

	it("handles empty array", () => {
		const result = generateToolPrompt([]);
		expect(result).toContain("Your available tools");
	});
});
