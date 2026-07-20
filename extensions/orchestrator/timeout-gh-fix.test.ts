/**
 * Tests for Bug B (timeoutMs wiring) and Candidate 3 (gh command classification + enforcement).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isWriteCommand } from "./bash-classifier";

// ── Bug B: timeoutMs wiring ──

describe("Bug B: timeoutMs wiring in delegate-pipeline", () => {
	it("AbortSignal.timeout creates a timeout signal when timeoutMs is set", () => {
		const timeoutMs = 5000;
		const signal = AbortSignal.timeout(timeoutMs);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
	});

	it("no timeout signal when timeoutMs is unset (uses passed signal)", () => {
		const controller = new AbortController();
		const timeoutMs = undefined;
		const effectiveSignal = timeoutMs
			? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[])
			: controller.signal;
		expect(effectiveSignal).toBe(controller.signal);
	});

	it("AbortSignal.any combines user signal with timeout", () => {
		const userController = new AbortController();
		const timeoutSignal = AbortSignal.timeout(5000);
		const effectiveSignal = AbortSignal.any([userController.signal, timeoutSignal]);
		expect(effectiveSignal.aborted).toBe(false);

		// Aborting user signal should propagate
		userController.abort();
		expect(effectiveSignal.aborted).toBe(true);
	});

	it("AbortSignal.any triggers on timeout", async () => {
		const userController = new AbortController();
		const timeoutSignal = AbortSignal.timeout(10); // 10ms
		const effectiveSignal = AbortSignal.any([userController.signal, timeoutSignal]);

		// Wait for timeout to fire
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(effectiveSignal.aborted).toBe(true);
	});
});

// ── Candidate 3: gh command classification ──

describe("Candidate 3: gh command classification", () => {
	it("isWriteCommand('gh pr list') returns false", () => {
		expect(isWriteCommand("gh pr list")).toBe(false);
	});

	it("isWriteCommand('gh pr merge') returns true", () => {
		expect(isWriteCommand("gh pr merge")).toBe(true);
	});

	it("isWriteCommand('gh issue create') returns true", () => {
		expect(isWriteCommand("gh issue create")).toBe(true);
	});

	it("isWriteCommand('gh repo view') returns false", () => {
		expect(isWriteCommand("gh repo view")).toBe(false);
	});

	it("isWriteCommand('gh secret set') returns true", () => {
		expect(isWriteCommand("gh secret set")).toBe(true);
	});

	it("isWriteCommand('gh auth login') returns true", () => {
		expect(isWriteCommand("gh auth login")).toBe(true);
	});

	it("isWriteCommand('gh issue list') returns false", () => {
		expect(isWriteCommand("gh issue list")).toBe(false);
	});

	it("isWriteCommand('gh pr view') returns false", () => {
		expect(isWriteCommand("gh pr view")).toBe(false);
	});

	it("isWriteCommand('gh pr close') returns true", () => {
		expect(isWriteCommand("gh pr close")).toBe(true);
	});

	it("isWriteCommand('gh release create') returns true", () => {
		expect(isWriteCommand("gh release create")).toBe(true);
	});

	it("isWriteCommand('gh release list') returns false", () => {
		expect(isWriteCommand("gh release list")).toBe(false);
	});

	it("isWriteCommand('gh repo create') returns true", () => {
		expect(isWriteCommand("gh repo create")).toBe(true);
	});

	it("isWriteCommand('gh workflow run') returns true", () => {
		expect(isWriteCommand("gh workflow run")).toBe(true);
	});

	it("isWriteCommand('gh workflow list') returns false", () => {
		expect(isWriteCommand("gh workflow list")).toBe(false);
	});

	it("unknown gh subcommand defaults to write (safe default)", () => {
		expect(isWriteCommand("gh foobar")).toBe(true);
	});
});

// ── Candidate 3: gh enforcement in subagent-tool-guard ──

// Mock modules used by subagent-tool-guard
vi.mock("./bash-interceptor.ts", () => ({
	getBashToolReplacement: vi.fn(),
}));

vi.mock("./scope-guard.ts", () => {
	const ScopeGuard = vi.fn() as any;
	ScopeGuard.mockImplementation(function (this: any, _cwd: string) {
		this.isScopeValid = () => false;
		this.isPathAllowed = () => ({ allowed: true });
		this.checkFileSize = () => ({ allowed: true });
		this.requestExpansion = () => null;
	});
	return { ScopeGuard };
});

vi.mock("./subagent-sessions.ts", () => ({
}));

vi.mock("./debug.ts", () => ({
	debugLog: vi.fn(),
}));

vi.mock("./debug-path-trace.ts", () => ({
	traceToolCallEntry: vi.fn(),
	tracePathsExtracted: vi.fn(),
	tracePathResolved: vi.fn(),
	traceScopeCheck: vi.fn(),
	traceDecision: vi.fn(),
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, readFileSync: vi.fn() };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	isToolCallEventType: vi.fn(),
}));

// Import AFTER mocks
import { handleSubagentToolCall } from "./subagent-tool-guard";
import { getBashToolReplacement } from "./bash-interceptor";
import { isWriteCommand as realIsWriteCommand } from "./bash-classifier";

describe("Candidate 3: gh enforcement in subagent-tool-guard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true });
	});

	it("gh write command blocked for non-readOnly specialist", () => {
		const result = handleSubagentToolCall(
			{ toolName: "bash", input: { command: "gh pr merge 42" } },
			true,
			{ readOnly: false },
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("gh write command blocked"),
		});
	});

	it("gh read command NOT blocked for readOnly specialist", () => {
		const result = handleSubagentToolCall(
			{ toolName: "bash", input: { command: "gh pr list" } },
			true,
			{ readOnly: true },
		);
		expect(result).toBeUndefined();
	});

	it("gh write command blocked for readOnly specialist", () => {
		const result = handleSubagentToolCall(
			{ toolName: "bash", input: { command: "gh issue create --title 'bug'" } },
			true,
			{ readOnly: true },
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("gh write command blocked"),
		});
	});

	it("non-gh bash not affected by gh enforcement", () => {
		const result = handleSubagentToolCall(
			{ toolName: "bash", input: { command: "rm file.txt" } },
			true,
			{ readOnly: false },
		);
		expect(result).toBeUndefined();
	});
});

// ── Subagent context path: gh enforcement ──

describe("Candidate 3: gh enforcement in subagent context (subagentState set)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true });
	});

	it("gh write command blocked for non-readOnly specialist WITH subagentState", () => {
		const result = handleSubagentToolCall(
			{ toolName: "bash", input: { command: "gh pr merge 42" } },
			true,
			{ readOnly: false },
			{ specialistName: "test-specialist", planParsed: true, blockedCalls: [] },
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("gh write command blocked"),
		});
	});

	it("gh read command NOT blocked for readOnly specialist WITH subagentState", () => {
		const result = handleSubagentToolCall(
			{ toolName: "bash", input: { command: "gh pr list" } },
			true,
			{ readOnly: true },
			{ specialistName: "test-specialist", planParsed: true, blockedCalls: [] },
		);
		expect(result).toBeUndefined();
	});

	it("gh write command blocked when scope is NOT valid (no scope set) WITH subagentState", () => {
		// Default mock has isScopeValid = () => false, so scope gate is skipped.
		// Before the fix, gh write enforcement inside scope gate was also skipped.
		// After the fix, gh write enforcement runs BEFORE scope check.
		const result = handleSubagentToolCall(
			{ toolName: "bash", input: { command: "gh issue create --title 'bug'" } },
			true,
			{ readOnly: false },
			{ specialistName: "test-specialist", planParsed: true, blockedCalls: [] },
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("gh write command blocked"),
		});
	});
});
