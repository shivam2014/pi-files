import { describe, it, expect } from "vitest";
import { generateToolDoc } from "/Users/shivam94/.pi/agent/extensions/orchestrator/specialists.ts";

describe("generateToolDoc (exported)", () => {
	it("returns a string containing all provided tool names", () => {
		const result = generateToolDoc(["read", "grep", "edit"]);
		expect(result).toContain("read");
		expect(result).toContain("grep");
		expect(result).toContain("edit");
	});

	it("formats tool list as bullet list with syntax", () => {
		const result = generateToolDoc(["read", "grep"]);
		expect(result).toContain("- `read({ path, offset?, limit? })`");
		expect(result).toContain("- `grep({ pattern, path?, glob?, ignoreCase? })`");
	});

	it("includes 'Your available tools' header", () => {
		const result = generateToolDoc(["bash"]);
		expect(result).toContain("Your available tools");
	});

	it("includes constraints when provided", () => {
		const result = generateToolDoc(["read", "grep"], "You do NOT have bash.");
		expect(result).toContain("You do NOT have bash.");
	});

	it("handles single tool", () => {
		const result = generateToolDoc(["read"]);
		expect(result).toContain("read");
	});

	it("handles empty array", () => {
		const result = generateToolDoc([]);
		expect(result).toContain("Your available tools");
	});
});
