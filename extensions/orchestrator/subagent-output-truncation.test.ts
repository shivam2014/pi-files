/**
 * Tests for subagent output truncation behavior.
 */
import { describe, it, expect } from "vitest";
import { truncateSubagentOutput, OUTPUT_CAP } from "./subagent-runner.ts";

describe("truncateSubagentOutput", () => {
	it("preserves short output under cap unchanged", () => {
		const output = "short output here";
		expect(truncateSubagentOutput(output)).toBe(output);
	});

	it("truncates long output exceeding cap with marker", () => {
		const output = "x".repeat(OUTPUT_CAP + 1000);
		const result = truncateSubagentOutput(output);
		expect(result.length).toBeLessThanOrEqual(OUTPUT_CAP);
		expect(result).toContain("[output truncated at");
		expect(result).toContain("tail preserved]");
	});

	it("preserves ## Findings section at tail when output exceeds cap", () => {
		const findings = "## Findings\n- key finding here";
		const filler = "a".repeat(OUTPUT_CAP);
		const output = filler + "\n\n" + findings;
		const result = truncateSubagentOutput(output);
		expect(result).toContain("## Findings");
		expect(result).toContain("key finding here");
		expect(result.length).toBeLessThanOrEqual(OUTPUT_CAP);
	});

	it("preserves ## Audit section at tail when output exceeds cap", () => {
		const audit = "## Audit\n- stayed in scope";
		const filler = "b".repeat(OUTPUT_CAP);
		const output = filler + "\n\n" + audit;
		const result = truncateSubagentOutput(output);
		expect(result).toContain("## Audit");
		expect(result).toContain("stayed in scope");
		expect(result.length).toBeLessThanOrEqual(OUTPUT_CAP);
	});

	it("exports OUTPUT_CAP with value 80000", () => {
		expect(OUTPUT_CAP).toBe(80000);
	});
});
