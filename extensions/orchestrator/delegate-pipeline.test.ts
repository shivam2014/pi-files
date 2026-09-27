/**
 * delegate-pipeline.test.ts — output hygiene on error/abort/stall paths.
 *
 * Regression: processDelegateResult() returned formatErrorAbort() with the RAW
 * subagent output, skipping sanitizeOutputForOrchestrator() — so error/stall
 * results kept raw JSON tool-result blocks even when a report survived the
 * failure. Reverting the fix makes the assertions below fail.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./orchestrator-theme.ts", () => ({
	getTheme: vi.fn(() => ({
		fg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
		bg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
	})),
	statusIcon: vi.fn((_status: string) => "*"),
	styledSymbol: vi.fn((_key: string) => "*"),
	formatDuration: vi.fn((ms: number) => `${ms}ms`),
	formatTokens: vi.fn((count: number) => `${count}`),
	initTheme: vi.fn(),
	SYMBOLS: {},
}));

import { DelegatePipeline } from "./delegate-pipeline.ts";

describe("processDelegateResult — error/stall paths run sanitizeOutputForOrchestrator", () => {
	const pipeline = new DelegatePipeline({ scopeManager: {} as any });

	const process = (
		output: string,
		isAborted: boolean,
		isError: boolean,
		stopReason?: string,
	) => (pipeline as any).processDelegateResult(
		output,
		{} as any,
		1000,
		[],
		3,
		isAborted,
		isError,
		"boom",
		stopReason,
		undefined,
	);

	const noisyOutput = [
		'{"name":"read","arguments":{"path":"/x.ts"}}',
		"[tool result]",
		'{"exitCode":1,"stdout":"raw json noise"}',
		"[/tool result]",
		"",
		"## Findings",
		"- summary: did work",
		"",
		"## Audit",
		"- problems: none",
	].join("\n");

	it("error path strips raw JSON tool blocks when a report survived", () => {
		const out = process(noisyOutput, false, true, "error");
		expect(out).toContain("## Findings");
		expect(out).toContain("summary: did work");
		expect(out).not.toContain('"exitCode"');
		expect(out).not.toContain('"name":"read"');
		expect(out).not.toContain("[tool result]");
	});

	it("stall path (error outcome) strips raw JSON tool blocks when a report survived", () => {
		const out = process(noisyOutput, false, true, "stalled_no_progress");
		expect(out).toContain("summary: did work");
		expect(out).not.toContain('"exitCode"');
	});

	it("abort path strips raw JSON tool blocks when a report survived", () => {
		const out = process(noisyOutput, true, false, "aborted");
		expect(out).toContain("summary: did work");
		expect(out).not.toContain('"exitCode"');
	});

	it("error path WITHOUT a report leaves diagnostic output as-is", () => {
		const noReport = ["raw line A", '{"exitCode":1}', "[tool result]", "raw line B"].join("\n");
		const out = process(noReport, false, true, "error");
		expect(out).toContain("raw line A");
		expect(out).toContain("raw line B");
		expect(out).toContain('{"exitCode":1}');
	});
});
