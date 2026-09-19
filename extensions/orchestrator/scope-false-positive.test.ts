/**
 * scope-false-positive.test.ts — regression tests for the false positives the
 * now-fail-closed scope guard introduced (usability regressions fixed WITHOUT
 * re-opening the security hole).
 *
 *  A) RELATIVE PATH — a subagent's relative write resolves against the
 *     DELEGATION's cwd (D), not the process/orchestrator cwd.
 *  B) STALE SHARED FILE — an unrelated <cwd>/.pi/scope.json must never
 *     influence subagent enforcement.
 *  C) SECURITY REGRESSION GUARD — fail-closed / out-of-scope / cross-delegation
 *     stay closed (prove the fix did not weaken safety).
 *  D) NO OVER-CORRECTION — absolute in-scope paths still allowed.
 *
 * Exercises the REAL seam: real ScopeGuard, real ScopeManager, real
 * per-delegation scope files, real handleSubagentToolCall, real DelegatePipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SubagentState } from "./subagent-sessions.ts";

// ── Mocks (mirror scope-enforcement.test.ts so the REAL guard/pipeline run) ──
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

const mockGetSessionMode = vi.hoisted(() => vi.fn(() => "sequential"));
vi.mock("./orchestrator-config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./orchestrator-config")>();
	return {
		...actual,
		getSessionMode: mockGetSessionMode,
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
	return { ...actual, currentFrame: vi.fn(() => "x") };
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
	return { ...actual, statusIcon: vi.fn(() => "v"), styledSymbol: vi.fn(() => "") };
});

// ── Imports AFTER mocks ───────────────────────────────────────────────────────
import { handleSubagentToolCall } from "./subagent-tool-guard.ts";
import { createDelegationScope } from "./scope-manager.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let cwd: string;
let agentDir: string;

function scopeAllowing(...files: string[]): any {
	return {
		filesToModify: files,
		filesToCreate: [],
		directories: [],
		maxFiles: 10,
		requiresApprovalBeyondScope: true,
		changeType: "multi-file",
		maxLinesPerFile: 400,
		gateMode: "strict",
	};
}

/** A subagent state; `cwd` is the delegation's working directory. */
function state(over: Partial<SubagentState> = {}): SubagentState {
	return { specialistName: "coder", planParsed: true, blockedCalls: [], ...over };
}

function writeShared(delegationId: string, scope: any): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "scope.json"),
		JSON.stringify({ version: 1, schema: "scope-file-contract-v1", delegationId, scope }),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetSessionMode.mockReturnValue("sequential");
	cwd = mkdtempSync(join(tmpdir(), "scope-fp-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "scope-fp-agent-"));
	vi.mocked(getAgentDir).mockReturnValue(agentDir);
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// A) RELATIVE PATH resolves against the DELEGATION cwd (Defect A — the exact
//    live case: ocr-hero-src.txt resolved against the process cwd and blocked).
// ─────────────────────────────────────────────────────────────────────────────
describe("A) relative paths resolve against the DELEGATION cwd, not process.cwd()", () => {
	it("ALLOWS a relative in-scope write when process.cwd() is a different directory", () => {
		const D = mkdtempSync(join(tmpdir(), "scope-fp-deleg-"));
		try {
			// The delegation cwd must differ from the process cwd (the bug's premise).
			expect(resolve(D)).not.toBe(resolve(process.cwd()));

			// The delegation's own scope grants an absolute path under D.
			const id = createDelegationScope(scopeAllowing(join(D, "ocr-hero-src.txt")));

			// The tool_call ctx carries the process/orchestrator cwd (or none); the
			// DELEGATION cwd is threaded on the SubagentState by the runner.
			const res = handleSubagentToolCall(
				{ toolName: "write", input: { path: "ocr-hero-src.txt", content: "hello" } },
				true,
				{ cwd: process.cwd() },
				state({ delegationId: id, cwd: D }),
			);

			expect(res).toBeUndefined(); // ALLOWED — the false positive is gone
		} finally {
			rmSync(D, { recursive: true, force: true });
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// B) STALE SHARED FILE must never influence subagent enforcement (Defect B).
// ─────────────────────────────────────────────────────────────────────────────
describe("B) a stale/unrelated <cwd>/.pi/scope.json must not influence subagent enforcement", () => {
	it("(i) own-per-delegation scope wins — a stale shared file does NOT block an in-scope write", () => {
		const id = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		// Stale shared file: a DIFFERENT delegation, unrelated paths.
		writeShared("delegation-stale-b2618cb0", scopeAllowing(join(cwd, "orchestrator", "plan-panel.ts")));

		const res = handleSubagentToolCall(
			{ toolName: "edit", input: { path: join(cwd, "src", "index.js"), content: "x" } },
			true,
			{ cwd },
			state({ delegationId: id, cwd }),
		);
		expect(res).toBeUndefined(); // own scope governs → ALLOWED
	});

	it("(ii) no delegation id → the stale shared file is NOT consulted (fail-closed)", () => {
		// The stale file GRANTS this path. A guard that consulted it would permit
		// the write (the bug); a correct guard ignores it and fails closed.
		writeShared("delegation-stale-b2618cb0", scopeAllowing(join(cwd, "unrelated", "plan-panel.ts")));

		const res = handleSubagentToolCall(
			{ toolName: "write", input: { path: join(cwd, "unrelated", "plan-panel.ts"), content: "x" } },
			true,
			{ cwd },
			state(), // no delegation id
		);
		expect(res?.block).toBe(true);
	});

	it("(iii) SEQUENTIAL production path: a sibling overwriting the shared file does not block own scope", async () => {
		// Import late so the mocks above are in force.
		const { DelegatePipeline } = await import("./delegate-pipeline.ts");
		const { ScopeManager } = await import("./scope-manager.ts");
		const pipeline = new DelegatePipeline({ scopeManager: new ScopeManager(cwd) });

		const scope = scopeAllowing(join(cwd, "src", "index.js"));
		scope.directories = [join(cwd, "src")];

		let observed: any = "NOT RUN";
		mockRunSubagent.mockImplementation(async (...args: any[]) => {
			// args[10] === the delegationId the pipeline threads to the runner.
			const delegationId = args[10];
			// Simulate a concurrent sibling overwriting the SHARED file with its own,
			// unrelated scope between delegation start and the subagent's tool call.
			writeShared("delegation-sibling-xyz", scopeAllowing(join(cwd, "lib", "other.js")));
			observed = handleSubagentToolCall(
				{ toolName: "edit", input: { path: join(cwd, "src", "index.js"), content: "x" } },
				true,
				{ cwd },
				state({ delegationId, cwd }),
			);
			return { output: "done", turns: 1, toolCallTrail: [] };
		});

		const ctx = {
			cwd,
			modelRegistry: {},
			model: "test-model",
			ui: { setWidget: vi.fn(), setWorkingMessage: vi.fn(), setStatus: vi.fn() },
		} as any;
		await pipeline.run({ specialist: "coder", task: "edit src/index.js", scope }, ctx, vi.fn());

		expect(observed).toBeUndefined(); // in-scope write NOT blocked by the stale sibling file
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// C) SECURITY REGRESSION GUARD — the fix must not weaken safety.
// ─────────────────────────────────────────────────────────────────────────────
describe("C) security properties preserved", () => {
	it("no scope at all → subagent write is BLOCKED (fail-closed)", () => {
		expect(existsSync(join(cwd, ".pi", "scope.json"))).toBe(false);
		const res = handleSubagentToolCall(
			{ toolName: "write", input: { path: "lib/calc.js", content: "x" } },
			true,
			{ cwd },
			state(),
		);
		expect(res?.block).toBe(true);
	});

	it("a delegation writing outside ITS OWN scope is BLOCKED", () => {
		const id = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const res = handleSubagentToolCall(
			{ toolName: "edit", input: { path: join(cwd, "lib", "calc.js"), content: "x" } },
			true,
			{ cwd },
			state({ delegationId: id, cwd }),
		);
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("outside the allowed scope");
	});

	it("cross-delegation: A cannot write a path only B's scope grants", () => {
		const idA = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const idB = createDelegationScope(scopeAllowing(join(cwd, "lib", "calc.js")));

		const rA = handleSubagentToolCall(
			{ toolName: "edit", input: { path: join(cwd, "lib", "calc.js"), content: "x" } },
			true,
			{ cwd },
			state({ delegationId: idA, cwd }),
		);
		expect(rA?.block).toBe(true);

		// CONTROL: B (whose scope grants lib/calc.js) is allowed the same path.
		const rB = handleSubagentToolCall(
			{ toolName: "edit", input: { path: join(cwd, "lib", "calc.js"), content: "x" } },
			true,
			{ cwd },
			state({ delegationId: idB, cwd }),
		);
		expect(rB).toBeUndefined();
	});

	it("reads are never blocked", () => {
		expect(
			handleSubagentToolCall({ toolName: "read", input: { path: "anything.ts" } }, true, { cwd }, state()),
		).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// D) NO OVER-CORRECTION — absolute in-scope paths remain allowed.
// ─────────────────────────────────────────────────────────────────────────────
describe("D) absolute paths inside the delegation's scope remain allowed", () => {
	it("ALLOWS an absolute path inside the delegation's own scope", () => {
		const id = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const res = handleSubagentToolCall(
			{ toolName: "write", input: { path: join(cwd, "src", "index.js"), content: "x" } },
			true,
			{ cwd },
			state({ delegationId: id, cwd }),
		);
		expect(res).toBeUndefined();
	});

	it("ALLOWS an absolute path via a directory grant, relative to the delegation cwd", () => {
		const scope = scopeAllowing();
		scope.directories = ["src"];
		const id = createDelegationScope(scope);
		const res = handleSubagentToolCall(
			{ toolName: "write", input: { path: "src/new.js", content: "x" } },
			true,
			{ cwd },
			state({ delegationId: id, cwd }),
		);
		expect(res).toBeUndefined();
	});
});
