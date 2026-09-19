/**
 * scope-enforcement.test.ts — acceptance tests for the deterministic
 * scope-enforcement guard, written against the REAL seam (real ScopeGuard,
 * real ScopeManager, real handleSubagentToolCall, real DelegatePipeline).
 *
 * These tests exist because the pre-existing guard tests MOCK ScopeGuard
 * entirely (isScopeValid / isPathAllowed are stubs), so they passed even while
 * the guard was silently inert. Every test below exercises the real file-based
 * scope contract, so reverting Fix 1 makes test A (and D) fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentState } from "./subagent-sessions.ts";

// ── Module mocks (spread-actual so index.ts keeps every real export) ──────────

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getAgentDir: vi.fn(),
		isToolCallEventType: vi.fn(() => true),
	};
});

const mockRunSubagent = vi.hoisted(() => vi.fn());
vi.mock("./subagent-runner.ts", () => ({
	runSubagent: mockRunSubagent,
	ERROR_MARKER: "[error]",
	ABORT_MARKER: "[aborted]",
	PROVIDER_RETRY_MAX_ATTEMPTS: 3,
	providerBackoffDelayMs: () => 0,
	SUBAGENT_ENV_KEY: "PI_ORCHESTRATOR_SUBAGENT",
}));

vi.mock("./plan-panel.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./plan-panel.ts")>();
	return {
		...actual,
		hasActivePlan: vi.fn(() => true),
		setupPlanPanel: vi.fn(),
		startDelegationStep: vi.fn(),
		finalizePlanStep: vi.fn(),
		errorPlanStep: vi.fn(),
		incrementDelegationCount: vi.fn(),
		decrementDelegationCount: vi.fn(),
		clearPlanIfComplete: vi.fn(),
		updatePlanStepDetail: vi.fn(),
		recordTimelineFrame: vi.fn(),
	};
});

vi.mock("./ask-resolver.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ask-resolver.ts")>();
	return { ...actual, createAskOrchestratorResolver: () => vi.fn(), resolve: () => "pass" };
});

vi.mock("./orchestrator-config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./orchestrator-config")>();
	return {
		...actual,
		getSessionMode: vi.fn(() => "parallel"),
		loadOrchestratorConfig: vi.fn(() => ({ delegation: { parallel: { maxConcurrent: 4, timeoutMs: 120000 } } })),
	};
});

vi.mock("./debug.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./debug.ts")>();
	return { ...actual, debugLog: vi.fn() };
});

vi.mock("./peek-overlay.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./peek-overlay.ts")>();
	return { ...actual, hidePeek: vi.fn(), clearViewerState: vi.fn() };
});

vi.mock("./spinner-state.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./spinner-state.ts")>();
	return { ...actual, currentFrame: vi.fn(() => "⠋") };
});

vi.mock("./subagent-diagnostics.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./subagent-diagnostics.ts")>();
	return {
		...actual,
		captureDiagnostic: vi.fn(() => null),
		isDiagnosticsEnabled: vi.fn(() => false),
		persistDiagnostic: vi.fn(),
		cleanupOldDiagnostics: vi.fn(),
	};
});

vi.mock("./orchestrator-theme.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./orchestrator-theme.ts")>();
	return { ...actual, statusIcon: vi.fn(() => "✓"), styledSymbol: vi.fn(() => "") };
});

// ── Imports AFTER mocks ───────────────────────────────────────────────────────
import orchestrator from "./index.ts";
import { handleSubagentToolCall } from "./subagent-tool-guard.ts";
import { ScopeManager } from "./scope-manager.ts";
import { ScopeGuard } from "./scope-guard.ts";
import { DelegatePipeline } from "./delegate-pipeline.ts";
import { subagentSessions } from "./subagent-sessions.ts";
import { debugLog } from "./debug.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let cwd: string;
let agentDir: string;

function coderState(): SubagentState {
	return { specialistName: "coder", planParsed: true, blockedCalls: [] };
}

function scopePath(): string {
	return join(cwd, ".pi", "scope.json");
}

function grantCoderScope(): void {
	// ScopeManager.writeScope() resolves RELATIVE paths against process.cwd()
	// (asserted by scope-manager.test.ts), but the guard resolves against the
	// delegation cwd. These are equal in production; in this harness cwd is a
	// temp dir, so pass absolute paths under `cwd` to mirror the production contract.
	new ScopeManager(cwd).writeScope({
		filesToModify: [join(cwd, "src/index.js")],
		filesToCreate: [],
		directories: [join(cwd, "src")],
		maxFiles: 10,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	cwd = mkdtempSync(join(tmpdir(), "scope-enf-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "scope-enf-agent-"));
	vi.mocked(getAgentDir).mockReturnValue(agentDir);
	delete process.env["PI_ORCHESTRATOR_SUBAGENT"];
	subagentSessions.clear();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — FAIL-CLOSED (real seam)
// ─────────────────────────────────────────────────────────────────────────────
describe("FIX 1 — fail-closed scope enforcement (real ScopeGuard)", () => {
	it("A) BLOCKS an edit when NO scope is established", () => {
		expect(existsSync(scopePath())).toBe(false);
		const res = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "lib/calc.js" } },
			true,
			{ cwd },
			coderState(),
		);
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("is outside the allowed scope");
	});

	it("A2) BLOCKS a write when NO scope is established", () => {
		const res = handleSubagentToolCall(
			{ toolName: "write", input: { path: "lib/calc.js", content: "x" } },
			true,
			{ cwd },
			coderState(),
		);
		expect(res?.block).toBe(true);
	});

	it("B) HAPPY PATH: an edit to lib/calc.js is BLOCKED and file content is UNCHANGED", () => {
		grantCoderScope();
		const calc = join(cwd, "lib", "calc.js");
		mkdirSync(join(cwd, "lib"), { recursive: true });
		writeFileSync(calc, "module.exports = 1;");

		const res = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "lib/calc.js", edits: [{ oldText: "1", newText: "2" }] } },
			true,
			{ cwd },
			coderState(),
		);
		expect(res?.block).toBe(true);
		expect(readFileSync(calc, "utf-8")).toBe("module.exports = 1;");
	});

	it("C) IN-SCOPE ALLOWED: an edit to src/index.js is ALLOWED (no false positives)", () => {
		grantCoderScope();
		const res = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "src/index.js", edits: [{ oldText: "a", newText: "b" }] } },
			true,
			{ cwd },
			coderState(),
		);
		expect(res).toBeUndefined();
	});

	it("F) READ TOOLS: read/grep with NO scope are NOT blocked (no over-blocking)", () => {
		expect(existsSync(scopePath())).toBe(false);
		expect(handleSubagentToolCall({ toolName: "read", input: { path: "anything.ts" } }, true, { cwd }, coderState())).toBeUndefined();
		expect(handleSubagentToolCall({ toolName: "grep", input: { pattern: "foo", path: "." } }, true, { cwd }, coderState())).toBeUndefined();
		expect(handleSubagentToolCall({ toolName: "find", input: { pattern: "**/*.ts" } }, true, { cwd }, coderState())).toBeUndefined();
	});

	it("sanity: the real ScopeGuard reports no scope and denies writes", () => {
		const guard = new ScopeGuard(cwd);
		expect(guard.isScopeValid()).toBe(false);
		expect(guard.isPathAllowed(join(cwd, "lib", "calc.js"), "write").allowed).toBe(false);
		expect(guard.isPathAllowed(join(cwd, "lib", "calc.js"), "read").allowed).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3 / FIX 2 — parallel mode enforces; scope survives to subagent runtime
// ─────────────────────────────────────────────────────────────────────────────
describe("FIX 3/FIX 2 — parallel delegation writes a scope the guard reads; scope lifetime", () => {
	it("D+E) parallel run: scope present during tools, out-of-scope blocked, in-scope allowed, gone after", async () => {
		const pipeline = new DelegatePipeline({ scopeManager: new ScopeManager(cwd) });

		let observed:
			| { scopePresent: boolean; outOfScopeBlocked: boolean; inScopeAllowed: boolean }
			| null = null;

		mockRunSubagent.mockImplementation(async () => {
			observed = {
				// FIX 3: parallel mode must have written the shared <cwd>/.pi/scope.json
				scopePresent: existsSync(scopePath()),
				// FIX 1 + FIX 3: the guard now reads it and blocks the out-of-scope edit
				outOfScopeBlocked: handleSubagentToolCall(
					{ toolName: "edit", input: { path: "lib/calc.js" } },
					true,
					{ cwd },
					coderState(),
				)?.block === true,
				inScopeAllowed:
					handleSubagentToolCall(
						{ toolName: "edit", input: { path: "src/index.js" } },
						true,
						{ cwd },
						coderState(),
					) === undefined,
			};
			return { output: "done", turns: 1, toolCallTrail: [] };
		});

		const ctx = { cwd, modelRegistry: {}, model: "test-model", ui: { setWidget: vi.fn(), setWorkingMessage: vi.fn(), setStatus: vi.fn() } } as any;
		await pipeline.run(
			{
				specialist: "coder",
				task: "edit lib/calc.js",
				scope: {
					filesToModify: [join(cwd, "src/index.js")],
					filesToCreate: [],
					directories: [join(cwd, "src")],
					maxFiles: 10,
					requiresApprovalBeyondScope: true,
					changeType: "multi-file",
					maxLinesPerFile: 400,
					gateMode: "strict",
				},
			},
			ctx,
			vi.fn(),
		);

		expect(observed).not.toBeNull();
		expect(observed!.scopePresent).toBe(true); // FIX 3
		expect(observed!.outOfScopeBlocked).toBe(true); // FIX 1 + FIX 3
		expect(observed!.inScopeAllowed).toBe(true); // no false positive
		// FIX 2 + delegation lifecycle: scope is gone only AFTER the delegation completes
		expect(existsSync(scopePath())).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 — the in-process child's before_agent_start must NOT clear parent scope
// ─────────────────────────────────────────────────────────────────────────────
function createMockPi() {
	const handlers: Record<string, any[]> = {};
	const pi = {
		registerTool: () => {},
		getAllTools: () => [],
		setActiveTools: () => {},
		on: (event: string, handler: any) => {
			handlers[event] = handlers[event] || [];
			handlers[event].push(handler);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		getActiveToolsHistory: () => [],
		async trigger(event: string, ...args: any[]) {
			const results: any[] = [];
			for (const h of handlers[event] || []) results.push(await h(...args));
			return results;
		},
	};
	return pi;
}

describe("FIX 2 — child agent-start does not clear the parent scope", () => {
	it("a before_agent_start for a subagent session leaves .pi/scope.json intact", async () => {
		const pi = createMockPi();
		orchestrator(pi as any);
		grantCoderScope();
		subagentSessions.set("child-session", coderState());

		await pi.trigger(
			"before_agent_start",
			{ systemPrompt: "", systemPromptOptions: {} },
			{ cwd, sessionManager: { getSessionId: () => "child-session" } },
		);

		expect(existsSync(scopePath())).toBe(true);
	});

	it("a before_agent_start for the orchestrator session still clears stale scope", async () => {
		const pi = createMockPi();
		orchestrator(pi as any);
		grantCoderScope();
		expect(existsSync(scopePath())).toBe(true);

		await pi.trigger(
			"before_agent_start",
			{ systemPrompt: "", systemPromptOptions: {} },
			{ cwd, sessionManager: { getSessionId: () => "orchestrator-session" } },
		);

		expect(existsSync(scopePath())).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4 — clearScope must not swallow unlink errors silently
// ─────────────────────────────────────────────────────────────────────────────
describe("FIX 4 — clearScope logs on unlink failure", () => {
	it("logs at debug level when the scope path cannot be unlinked", () => {
		// Make .pi/scope.json a DIRECTORY so existsSync() is true but unlinkSync throws.
		mkdirSync(scopePath(), { recursive: true });

		expect(() => new ScopeManager(cwd).clearScope()).not.toThrow();
		expect(debugLog).toHaveBeenCalledWith(
			expect.stringContaining("clearScope"),
			expect.stringContaining("scope.json"),
			expect.anything(),
		);
	});
});
