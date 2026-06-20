/**
 * Tests for SubagentToolGuard — tool call enforcement for subagent sessions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mock state — getter proxy lets us change _batchLoadSubagent at runtime
const mockState = { batchLoad: 0, planParsed: false };

vi.mock("./subagent-runner.ts", () => ({
	get _batchLoadSubagent() {
		return mockState.batchLoad;
	},
	isPlanParsed: () => mockState.planParsed,
}));

vi.mock("./bash-interceptor.ts", () => ({
	getBashToolReplacement: vi.fn(),
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
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Mock ScopeGuard — vi.fn() acts as constructor, mockImplementation replaces per-test
const ScopeGuardMock = vi.hoisted(() => vi.fn() as any);
ScopeGuardMock.mockImplementation(function (this: any, _cwd: string) {
	this.isScopeValid = () => false;
	this.isPathAllowed = () => ({ allowed: true });
	this.checkFileSize = () => ({ allowed: true });
	this.requestExpansion = () => null;
});
vi.mock("./scope-guard.ts", () => ({ ScopeGuard: ScopeGuardMock }));

beforeEach(() => {
	mockState.batchLoad = 0;
	mockState.planParsed = false;
	vi.clearAllMocks();
});

// ── planSteps enforcement ──

describe("handleSubagentToolCall", () => {
	describe("planSteps-first enforcement", () => {
		beforeEach(() => {
			mockState.batchLoad = 1;
			mockState.planParsed = false;
		});

		it("blocks non-planSteps calls when plan not parsed", () => {
			const result = handleSubagentToolCall({
				toolName: "read",
				input: { path: "file.ts" },
			});
			expect(result).toEqual({
				block: true,
				reason: "Call planSteps({ goal, steps }) first before using read.",
			});
		});

		it("blocks bash calls when plan not parsed", () => {
			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "ls" },
			});
			expect(result).toEqual({
				block: true,
				reason: "Call planSteps({ goal, steps }) first before using bash.",
			});
		});

		it("allows planSteps when plan not parsed", () => {
			const result = handleSubagentToolCall({
				toolName: "planSteps",
				input: { goal: "test", steps: ["step1"] },
			});
			expect(result).toBeUndefined();
		});
	});

	describe("scope enforcement (subagent context)", () => {
		beforeEach(() => {
			mockState.batchLoad = 1;
			mockState.planParsed = true;
		});

		it("passes through when scope is invalid (no scope file)", () => {
			ScopeGuardMock.mockImplementationOnce(function (this: any, _cwd: string) {
				this.isScopeValid = () => false;
			});

			const result = handleSubagentToolCall({
				toolName: "edit",
				input: { filePath: "src/file.ts" },
			});
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
			});
			expect(result).toEqual({
				block: true,
				reason: "Scope violation: secret.ts is outside the allowed scope",
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
			});
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
			});
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
			});
			expect(result).toEqual({
				block: true,
				reason: "Scope violation: bad.ts is outside the allowed scope",
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
			});
			// Should have tried to check paths extracted from the command
			expect(mockIsPathAllowed).toHaveBeenCalled();
		});
	});

	describe("bash command interception (orchestrator context)", () => {
		beforeEach(() => {
			mockState.batchLoad = 0;
		});

		it("passes through non-bash tools", () => {
			const result = handleSubagentToolCall({
				toolName: "read",
				input: { path: "file.ts" },
			});
			expect(result).toBeUndefined();
		});

		it("blocks bash when replacement exists", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue("read");
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "cat file.txt" },
			});
			expect(result).toEqual({
				block: true,
				reason: "Use read instead of bash (cat). Set override:true to force bash.",
			});
		});

		it("allows bash when no replacement", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue(null);
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "docker build ." },
			});
			expect(result).toBeUndefined();
		});

		it("allows bash when override is set", () => {
			vi.mocked(getBashToolReplacement).mockReturnValue(null);
			vi.mocked(isToolCallEventType).mockReturnValue(true);

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "cat file.txt", override: true },
			});
			expect(getBashToolReplacement).toHaveBeenCalledWith("cat file.txt", true);
		});

		it("handles non-typed bash event fallback", () => {
			vi.mocked(isToolCallEventType).mockReturnValue(false);
			vi.mocked(getBashToolReplacement).mockReturnValue("grep");

			const result = handleSubagentToolCall({
				toolName: "bash",
				input: { command: "grep -r foo ." },
			});
			expect(result).toEqual({
				block: true,
				reason: "Use grep instead of bash (grep). Set override:true to force bash.",
			});
		});
	});

	describe("fusion allow-list enforcement", () => {
		beforeEach(() => {
			mockState.batchLoad = 0;
		});

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
});
