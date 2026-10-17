/**
 * Tests for subagent output truncation behavior.
 */
import { describe, it, expect, vi } from "vitest";
import { truncateSubagentOutput, OUTPUT_CAP } from "./subagent-runner.ts";
import { buildTruncationRecoveryNote, formatResult, type DelegationTruncation } from "./delegate-pipeline.ts";

// formatResult pulls themed icons/tokens — mock the theme module like the sibling suites do.
vi.mock("./orchestrator-theme.ts", () => ({
	getTheme: vi.fn(() => ({
		fg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
		bg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
	})),
	statusIcon: vi.fn(() => "*"),
	styledSymbol: vi.fn(() => "*"),
	formatDuration: vi.fn((ms: number) => `${ms}ms`),
	formatTokens: vi.fn((count: number) => `${count}`),
	partialStrikethrough: vi.fn((text: string) => text),
	initTheme: vi.fn(),
	SYMBOLS: { "token.input": "^", "token.output": "v", "token.cacheRead": "~" },
}));

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

// ── ITEM 3: truncation disclosure + recovery pointer ────────────────────────
describe("buildTruncationRecoveryNote (ITEM 3)", () => {
	it("returns '' when nothing was truncated (no noise)", () => {
		expect(buildTruncationRecoveryNote(undefined)).toBe("");
		expect(buildTruncationRecoveryNote({ truncated: false })).toBe("");
	});

	it("points at the flight-recorder transcript when truncation occurred", () => {
		const note = buildTruncationRecoveryNote({
			truncated: true,
			stages: ["output-cap"],
			flightRecorderPath: "/tmp/orchestrator-debug/delegation-x-coder.json",
		});
		expect(note).toBe("[truncation] Full transcript: /tmp/orchestrator-debug/delegation-x-coder.json");
	});

	it("names the stage(s) when no transcript path exists", () => {
		const note = buildTruncationRecoveryNote({ truncated: true, stages: ["tool-result"] });
		expect(note).toContain("[truncation]");
		expect(note).toContain("tool-result");
		expect(note).toContain("full transcript unavailable");
	});
});

describe("formatResult truncation disclosure (ITEM 3)", () => {
	const base = {
		output: "## Findings\n- summary: done",
		metrics: { readCalls: 1, grepCalls: 0, findCalls: 0, editCalls: 0, writeCalls: 0, bashCalls: 0, lsCalls: 0 } as any,
		elapsed: 1,
		turns: 1,
		toolCalls: 1,
		status: "ok" as const,
	};

	it("appears with the absolute flight-recorder path when truncation occurred", () => {
		const truncation: DelegationTruncation = {
			truncated: true,
			stages: ["tool-result", "output-cap"],
			flightRecorderPath: "/tmp/orchestrator-debug/delegation-1-coder.json",
		};
		const r = formatResult({ ...base, truncation });
		expect(r.formatted).toContain("[truncation] Full transcript: /tmp/orchestrator-debug/delegation-1-coder.json");
	});

	it("absent when truncation did not occur", () => {
		const r = formatResult({ ...base, truncation: { truncated: false } });
		expect(r.formatted).not.toContain("[truncation]");
		expect(formatResult({ ...base }).formatted).not.toContain("[truncation]");
	});
});
