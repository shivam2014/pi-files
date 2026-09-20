/**
 * Message-contract tests for the diagnostic notification wording.
 *
 * Bug (fixed): the diagnostic-notify block in delegate-pipeline hardcoded
 * "0 tool calls in N turn(s)" and prefixed EVERY kind with "failed" — so a
 * blocked_calls diagnostic on an otherwise healthy run (toolCalls: 8) was
 * reported as a failure with zero tool calls.
 */
import { describe, it, expect } from "vitest";
import { formatDiagnosticMessage } from "./delegate-pipeline.ts";
import { captureDiagnostic } from "./subagent-diagnostics.ts";
import type { SubagentDiagnostic } from "./types.ts";

const metrics = { readCalls: 1, grepCalls: 1, findCalls: 0, editCalls: 0, writeCalls: 0, bashCalls: 0, lsCalls: 0 };

function diag(overrides: Partial<SubagentDiagnostic> = {}): SubagentDiagnostic {
	return {
		schemaVersion: 1,
		sessionId: "sess-1",
		timestamp: "2026-01-01T00:00:00.000Z",
		specialist: "coder",
		task: "t",
		turns: 5,
		toolCalls: 8,
		elapsedMs: 100,
		crashed: false,
		outputPreview: "preview",
		metrics,
		kind: "blocked_calls",
		diagnosticId: "diag-1",
		...overrides,
	};
}

describe("formatDiagnosticMessage — kind-aware wording", () => {
	it("blocked_calls reports the REAL tool-call count and never says failed", () => {
		const msg = formatDiagnosticMessage(diag({ kind: "blocked_calls", toolCalls: 8, turns: 5 }));
		expect(msg).toContain("8 tool call(s)");
		expect(msg).toContain("5 turn(s)");
		expect(msg).not.toContain("failed");
		expect(msg).not.toContain("0 tool calls");
	});

	it("blocked_calls keeps the real count even when an error message is present", () => {
		const msg = formatDiagnosticMessage(diag({ kind: "blocked_calls", errorMessage: "blocked: write outside scope" }));
		expect(msg).toContain("8 tool call(s)");
		expect(msg).toContain("blocked: write outside scope");
		expect(msg).not.toContain("failed");
	});

	it("silent_failure keeps the 'failed' wording", () => {
		const msg = formatDiagnosticMessage(diag({ kind: "silent_failure", toolCalls: 0, turns: 3 }));
		expect(msg).toContain("failed");
		expect(msg).toContain("0 tool call(s)");
	});

	it("crash says crashed, not failed", () => {
		const msg = formatDiagnosticMessage(diag({ kind: "crash", toolCalls: 0, turns: 2 }));
		expect(msg).toContain("crashed");
		expect(msg).not.toContain("failed");
	});

	it("tool_errors is neutral and reports the real count", () => {
		const msg = formatDiagnosticMessage(diag({ kind: "tool_errors", toolCalls: 4, turns: 2 }));
		expect(msg).toContain("4 tool call(s)");
		expect(msg).not.toContain("failed");
	});

	it("respects maxLen (text-mode fallback cap)", () => {
		const capped = formatDiagnosticMessage(diag({ errorMessage: "x".repeat(500) }), 150);
		expect(capped.length).toBe(150);
	});

	it("no kind claims 'returned 0 tool calls' when a real count exists", () => {
		for (const kind of ["silent_failure", "crash", "tool_errors", "blocked_calls"] as const) {
			const msg = formatDiagnosticMessage(diag({ kind, toolCalls: 8 }));
			expect(msg).not.toContain("returned 0 tool calls");
			expect(msg).toContain("8 tool call(s)");
		}
	});
});

describe("formatDiagnosticMessage — wired to real captureDiagnostic output", () => {
	it("blocked_calls from a healthy 8-call trail carries the count, not 'failed'", () => {
		const captured = captureDiagnostic({
			output: "did work",
			turns: 5,
			toolCallTrail: Array.from({ length: 8 }, (_, i) => ({ tool: `bash_${i}` })),
			blockedCalls: [{ tool: "write", target: "outside.ts", reason: "scope", timestamp: Date.now() }],
			elapsedMs: 10,
			specialist: "coder",
			task: "t",
			sessionId: "s",
			metrics,
			agentDir: "/tmp",
		});
		expect(captured).not.toBeNull();
		expect(captured!.kind).toBe("blocked_calls");
		expect(captured!.toolCalls).toBe(8);
		const msg = formatDiagnosticMessage(captured!);
		expect(msg).toContain("8 tool call(s)");
		expect(msg).not.toContain("failed");
	});

	it("silent_failure from an empty 0-call trail still says failed", () => {
		const captured = captureDiagnostic({
			output: "x",
			turns: 2,
			toolCallTrail: [],
			elapsedMs: 10,
			specialist: "scout",
			task: "t",
			sessionId: "s",
			metrics,
			agentDir: "/tmp",
		});
		expect(captured).not.toBeNull();
		expect(captured!.kind).toBe("silent_failure");
		expect(formatDiagnosticMessage(captured!)).toContain("failed");
	});
});
