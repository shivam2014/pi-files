/**
 * Tests for SubagentToolGuard — tool call enforcement for subagent sessions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./bash-interceptor.ts", () => ({
	getBashToolReplacement: vi.fn(),
}));

vi.mock("./bash-classifier.ts", () => ({
	isWriteCommand: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	isToolCallEventType: vi.fn(),
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, readFileSync: vi.fn() };
});

vi.mock("node:path", () => ({
	resolve: (...args: string[]) => args.join("/"),
	join: (...args: string[]) => args.join("/"),
}));

import { handleSubagentToolCall } from "./subagent-tool-guard";
import { getBashToolReplacement } from "./bash-interceptor";
import { isWriteCommand } from "./bash-classifier";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "./subagent-sessions";

// Mock ScopeGuard — vi.fn() acts as constructor, mockImplementation replaces per-test
const ScopeGuardMock = vi.hoisted(() => vi.fn() as any);
ScopeGuardMock.mockImplementation(function (this: any, _cwd: string) {
	this.isScopeValid = () => false;
	this.isPathAllowed = () => ({ allowed: true });
	this.checkFileSize = () => ({ allowed: true });
	this.requestExpansion = () => null;
});
vi.mock("./scope-guard.ts", () => ({ ScopeGuard: ScopeGuardMock }));

/** Helper: create a SubagentState for subagent-context tests */
function subagentCtx(planParsed = true): SubagentState {
	return { specialistName: "test-specialist", planParsed };
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ── planSteps enforcement ──

describe("handleSubagentToolCall", () => {
	describe("planSteps-first enforcement", () => {
		const state = () => subagentCtx(false);

		it("blocks non-planSteps calls when plan not parsed", () => {
			const result = handleSubagentToolCall({
				toolName: "read",
				input: { path: "file.ts" },
			}, true, undefined, state());
			expect(result).toEqual({
				block: true,
				reason: "Call planSteps({ goal, steps }) first before using read.",
			});
		});

		it("blocks bash calls when plan not parsed", () => {
			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "ls" },
			}, true, undefined, state());
			expect(result).toEqual({
				block: true,
				reason: "Call planSteps({ goal, steps }) first before using bash.",
			});
		});

		it("allows planSteps when plan not parsed", () => {
			const result = handleSubagentToolCall({
				toolName: "planSteps",
				input: { goal: "test", steps: ["step1"] },
			}, true, undefined, state());
			expect(result).toBeUndefined();
		});
	});

	describe("scope enforcement (subagent context)", () => {
		const state = () => subagentCtx(true);

		it("passes through when scope is invalid (no scope file)", () => {
			ScopeGuardMock.mockImplementationOnce(function (this: any, _cwd: string) {
				this.isScopeValid = () => false;
			});

			const result = handleSubagentToolCall({
				toolName: "edit",
				input: { filePath: "src/file.ts" },
			}, true, undefined, state());
			expect(result).toBeUndefined();
		});

		it("blocks when file path is outside scope", () => {
			ScopeGuardMock.mockImplementationOnce(function (this: any, _cwd: string) {
				this.isScopeValid = () => true;
				this.isPathAllowed = () => ({ allowed: false, reason: "File not in approved scope: secret.ts" });
				this.checkFileSize = () => ({ allowed: true });
				this.requestExpansion = () => null;
			});

			const result = handleSubagentToolCall({
				toolName: "edit",
				input: { filePath: "secret.ts" },
			}, true, undefined, state());
			expect(result).toEqual({
				block: true,
				reason: "Scope violation: secret.ts is outside the allowed scope",
				expansionRequest: null,
			});
		});

		it("blocks when file exceeds size limit", () => {
			ScopeGuardMock.mockImplementationOnce(function (this: any, _cwd: string) {
				this.isScopeValid = () => true;
				this.isPathAllowed = () => ({ allowed: true });
				this.checkFileSize = () => ({ allowed: false, reason: "File too large: 5000 lines" });
			});

			const result = handleSubagentToolCall({
				toolName: "write",
				input: { path: "big-file.ts" },
			}, true, undefined, state());
			expect(result).toEqual({
				block: true,
				reason: "File too large: 5000 lines",
			});
		});

		it("allows when file is in scope and within size limit", () => {
			ScopeGuardMock.mockImplementationOnce(function (this: any, _cwd: string) {
				this.isScopeValid = () => true;
				this.isPathAllowed = () => ({ allowed: true });
				this.checkFileSize = () => ({ allowed: true });
			});

			const result = handleSubagentToolCall({
				toolName: "edit",
				input: { filePath: "src/file.ts" },
			}, true, undefined, state());
			expect(result).toBeUndefined();
		});

		it("extracts paths from 'path' and 'file' input fields", () => {
			const mockIsPathAllowed = vi.fn()
				.mockReturnValueOnce({ allowed: true })
				.mockReturnValueOnce({ allowed: false, reason: "blocked" });
			ScopeGuardMock.mockImplementationOnce(function (this: any, _cwd: string) {
				this.isScopeValid = () => true;
				this.isPathAllowed = mockIsPathAllowed;
				this.checkFileSize = () => ({ allowed: true });
				this.requestExpansion = () => null;
			});

			const result = handleSubagentToolCall({
				toolName: "write",
				input: { path: "ok.ts", file: "bad.ts" },
			}, true, undefined, state());
			expect(result).toEqual({
				block: true,
				reason: "Scope violation: bad.ts is outside the allowed scope",
				expansionRequest: null,
			});
		});

		it("extracts file paths from bash commands", () => {
			const mockIsPathAllowed = vi.fn().mockReturnValue({ allowed: false, reason: "nope" });
			ScopeGuardMock.mockImplementationOnce(function (this: any, _cwd: string) {
				this.isScopeValid = () => true;
				this.isPathAllowed = mockIsPathAllowed;
				this.checkFileSize = () => ({ allowed: true });
				this.requestExpansion = () => null;
			});

			handleSubagentToolCall({
				toolName: "bash",
				input: { command: "cat src/auth.ts > backup.ts" },
			}, true, undefined, state());
			// Should have tried to check paths extracted from the command
			expect(mockIsPathAllowed).toHaveBeenCalled();
		});
	});

	describe("operation mapping", () => {
		const state = () => subagentCtx(true);

		// edit tool uses filePath in its input
		it("passes 'edit' operation for edit tool", () => {
			const mockIsPathAllowed = vi.fn().mockReturnValue({ allowed: true });
			ScopeGuardMock.mockImplementationOnce(function (this: any) {
				this.isScopeValid = () => true;
				this.isPathAllowed = mockIsPathAllowed;
				this.checkFileSize = () => ({ allowed: true });
				this.requestExpansion = () => null;
			});

			handleSubagentToolCall({
				toolName: "edit",
				input: { filePath: "src/file.ts" },
			}, true, undefined, state());
			expect(mockIsPathAllowed).toHaveBeenCalledWith(
				expect.stringContaining("src/file.ts"),
				"edit",
			);
		});

		// write tool uses path in its input
		it("passes 'write' operation for write tool", () => {
			const mockIsPathAllowed = vi.fn().mockReturnValue({ allowed: true });
			ScopeGuardMock.mockImplementationOnce(function (this: any) {
				this.isScopeValid = () => true;
				this.isPathAllowed = mockIsPathAllowed;
				this.checkFileSize = () => ({ allowed: true });
				this.requestExpansion = () => null;
			});

			handleSubagentToolCall({
				toolName: "write",
				input: { path: "src/file.ts" },
			}, true, undefined, state());
			expect(mockIsPathAllowed).toHaveBeenCalledWith(
				expect.stringContaining("src/file.ts"),
				"write",
			);
		});

		// read tool uses path in its input
		it("passes 'read' operation for read tool", () => {
			const mockIsPathAllowed = vi.fn().mockReturnValue({ allowed: true });
			ScopeGuardMock.mockImplementationOnce(function (this: any) {
				this.isScopeValid = () => true;
				this.isPathAllowed = mockIsPathAllowed;
				this.checkFileSize = () => ({ allowed: true });
				this.requestExpansion = () => null;
			});

			handleSubagentToolCall({
				toolName: "read",
				input: { path: "src/file.ts" },
			}, true, undefined, state());
			expect(mockIsPathAllowed).toHaveBeenCalledWith(
				expect.stringContaining("src/file.ts"),
				"read",
			);
		});
	});

	describe("bash command interception (orchestrator context)", () => {
		it("passes through non-bash tools", () => {
			const result = handleSubagentToolCall({
				toolName: "read",
				input: { path: "file.ts" },
			});
			expect(result).toBeUndefined();
		});

		it("blocks bash when replacement exists", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true, tool: "read" });
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "cat file.txt" },
			});
			expect(result).toEqual({
				block: true,
				reason: "Use read instead of bash (command: cat). Set override:true in tool input to force bash — e.g. bash({ command: 'your-cmd', override: true }).",
			});
		});

		it("allows bash when no replacement", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true });
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "docker build ." },
			});
			expect(result).toBeUndefined();
		});

		it("allows bash when override is set", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true });
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "cat file.txt", override: true },
			});
			expect(getBashToolReplacement).toHaveBeenCalledWith("cat file.txt", true);
		});

		it("handles non-typed bash event fallback", () => {
			vi.mocked(isToolCallEventType).mockReturnValue(false);
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true, tool: "grep" });

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "grep -r foo ." },
			});
			expect(result).toEqual({
				block: true,
				reason: "Use grep instead of bash (command: grep). Set override:true in tool input to force bash — e.g. bash({ command: 'your-cmd', override: true }).",
			});
		});
	});

	describe("bash command interception (subagent context)", () => {
		const state = () => subagentCtx(true);

		it("intercepts bash cat command and redirects to read in subagent context", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true, tool: "read" });
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "cat src/auth.ts" },
			}, true, undefined, state());
			expect(result).toEqual({
				block: true,
				reason: "Use read instead of bash (command: cat). Set override:true in tool input to force bash — e.g. bash({ command: 'your-cmd', override: true }).",
			});
		});

		it("allows bash with no replacement in subagent context", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true });
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "docker build ." },
			}, true, undefined, state());
			expect(result).toBeUndefined();
		});

		it("respects override:true in subagent context", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true });
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "cat file.txt", override: true },
			}, true, undefined, state());
			expect(getBashToolReplacement).toHaveBeenCalledWith("cat file.txt", true);
		});
	});

	describe("fusion allow-list enforcement", () => {
		it("blocks fusion when explicitly disabled", () => {
			const result = handleSubagentToolCall(
				{ toolName: "fusion", input: { prompt: "analyze" } },
				false,
			);
			expect(result).toEqual({
				block: true,
				reason: "Fusion is disabled. Enable it in .pi/fusion.json",
			});
		});

		it("allows fusion when enabled", () => {
			const result = handleSubagentToolCall(
				{ toolName: "fusion", input: { prompt: "analyze" } },
				true,
			);
			expect(result).toBeUndefined();
		});

		it("allows fusion with no second arg (default enabled)", () => {
			const result = handleSubagentToolCall({
				toolName: "fusion",
				input: { prompt: "analyze" },
			});
			expect(result).toBeUndefined();
		});
	});

	describe("readOnly bash blocking", () => {
		beforeEach(() => {
			vi.mocked(getBashToolReplacement).mockReturnValue({ allowed: true });
			vi.mocked(isToolCallEventType).mockReturnValue(true);
			vi.mocked(isWriteCommand).mockReturnValue(false);
		});

		it("blocks write-modifying bash when readOnly is true", () => {
			vi.mocked(isWriteCommand).mockReturnValue(true);
			const result = handleSubagentToolCall(
				{ toolName: "bash", input: { command: "rm file.txt" } },
				true,
				{ readOnly: true }
			);
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("Bash write command blocked"),
			});
		});

		it("allows read-only bash when readOnly is true", () => {
			const result = handleSubagentToolCall(
				{ toolName: "bash", input: { command: "curl localhost:19530" } },
				true,
				{ readOnly: true }
			);
			expect(result).toBeUndefined();
		});

		it("allows write-modifying bash when readOnly is false", () => {
			const result = handleSubagentToolCall(
				{ toolName: "bash", input: { command: "rm file.txt" } },
				true,
				{ readOnly: false }
			);
			expect(result).toBeUndefined();
		});

		it("allows bash when readOnly is undefined (default)", () => {
			const result = handleSubagentToolCall(
				{ toolName: "bash", input: { command: "rm file.txt" } },
				true,
				{}
			);
			expect(result).toBeUndefined();
		});
	});
});
