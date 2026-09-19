/**
 * scope-concurrency.test.ts — regression tests for the cross-delegation scope
 * permit (Defect 1) and the macOS /private/tmp false-positive (Defect 2).
 *
 * These exercise the REAL seam: real ScopeGuard, real ScopeManager, real
 * per-delegation scope files, real handleSubagentToolCall. Test A FAILS against
 * the old shared-<cwd>/.pi/scope.json behaviour and PASSES once the guard
 * resolves each subagent's OWN per-delegation file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join, resolve } from "node:path";
import type { SubagentState } from "./subagent-sessions.ts";

// ── Mocks (spread-actual so real exports survive) ─────────────────────────────
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getAgentDir: vi.fn(),
		isToolCallEventType: vi.fn(() => true),
		// The production run() evaluates `modelRuntime: await ModelRuntime.create()`
		// as part of the createSession arg list — stub it so the real runtime is never built.
		ModelRuntime: { create: vi.fn().mockResolvedValue({}) },
	};
});

vi.mock("./debug.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./debug.ts")>();
	return { ...actual, debugLog: vi.fn() };
});

// subagent-runner.ts pulls the theme renderer; stub it exactly as subagent-runner.test.ts does.
vi.mock("./orchestrator-theme.ts", () => ({
	getTheme: vi.fn(() => ({
		fg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
		bg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
	})),
	statusIcon: vi.fn((_status: string) => "*"),
	styledSymbol: vi.fn((_key: string) => "*"),
	formatDuration: vi.fn((ms: number) => `${ms}ms`),
	formatTokens: vi.fn((count: number) => `${count}`),
	partialStrikethrough: vi.fn((text: string) => text),
	initTheme: vi.fn(),
	SYMBOLS: { "token.input": "↑", "token.output": "↓", "token.cacheRead": "⇄" },
}));

// ── Imports AFTER mocks ───────────────────────────────────────────────────────
import { handleSubagentToolCall } from "./subagent-tool-guard.ts";
import { ScopeGuard } from "./scope-guard.ts";
import {
	ScopeManager,
	createDelegationScope,
	readDelegationScope,
	clearDelegationScope,
} from "./scope-manager.ts";
import { SubagentRunner } from "./subagent-runner.ts";
import { subagentSessions } from "./subagent-sessions.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let cwd: string;
let agentDir: string;

function sharedScopePath(): string {
	return join(cwd, ".pi", "scope.json");
}

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

function coderState(delegationId?: string): SubagentState {
	return { specialistName: "coder", planParsed: true, blockedCalls: [], delegationId };
}

beforeEach(() => {
	vi.clearAllMocks();
	cwd = mkdtempSync(join(tmpdir(), "scope-conc-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "scope-conc-agent-"));
	vi.mocked(getAgentDir).mockReturnValue(agentDir);
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// A) CROSS-DELEGATION PERMIT (Defect 1) — the decisive regression test
// ─────────────────────────────────────────────────────────────────────────────
describe("A) cross-delegation permit — a subagent must be validated against its OWN scope", () => {
	it("delegation A is BLOCKED from a path that only delegation B's scope allows", () => {
		// Delegation A may touch src/, delegation B may touch lib/ (they differ).
		const idA = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const idB = createDelegationScope(scopeAllowing(join(cwd, "lib", "calc.js")));

		// Simulate the proven race: the SHARED file currently holds delegation B's
		// scope (last writer wins). A guard that reads the shared file would treat
		// A's write to lib/calc.js as permitted.
		new ScopeManager(cwd).writeScope(scopeAllowing(join(cwd, "lib", "calc.js")), idB);
		expect(existsSync(sharedScopePath())).toBe(true);

		// Delegation A's subagent tries to write a path that is ONLY in B's scope.
		const resA = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "lib/calc.js", content: "x" } },
			true,
			{ cwd },
			coderState(idA),
		);
		expect(resA?.block).toBe(true);
		expect(resA?.reason).toContain("outside the allowed scope");

		// CONTROL: delegation B may write that same path (its own scope).
		const resB = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "lib/calc.js", content: "x" } },
			true,
			{ cwd },
			coderState(idB),
		);
		expect(resB).toBeUndefined();

		// CONTROL: delegation A may still write its OWN in-scope path.
		const resAOwn = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "src/index.js", content: "x" } },
			true,
			{ cwd },
			coderState(idA),
		);
		expect(resAOwn).toBeUndefined();
	});

	it("the real ScopeGuard resolves per-delegation (not shared) when given an id", () => {
		const idA = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		createDelegationScope(scopeAllowing(join(cwd, "lib", "calc.js")));
		new ScopeManager(cwd).writeScope(scopeAllowing(join(cwd, "lib", "calc.js")));

		const guardA = new ScopeGuard(cwd, idA);
		expect(guardA.isPathAllowed(join(cwd, "lib", "calc.js"), "write").allowed).toBe(false);
		expect(guardA.isPathAllowed(join(cwd, "src", "index.js"), "write").allowed).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// B) NO CROSS-DELEGATION INVALIDATION (the inverse false-positive over-block)
// ─────────────────────────────────────────────────────────────────────────────
describe("B) a finishing delegation must not invalidate a sibling's scope", () => {
	it("clearing one delegation's per-delegation scope leaves the sibling's intact", () => {
		const idA = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const idB = createDelegationScope(scopeAllowing(join(cwd, "lib", "calc.js")));

		// Delegation B finishes and clears its OWN per-delegation scope.
		clearDelegationScope(idB);

		// Delegation A's scope is untouched and still enforces A's grants.
		expect(readDelegationScope(idA)).not.toBeNull();
		const guardA = new ScopeGuard(cwd, idA);
		expect(guardA.isPathAllowed(join(cwd, "src", "index.js"), "write").allowed).toBe(true);
	});

	it("clearScope(id) is a no-op when a sibling overwrote the shared file", () => {
		const sm = new ScopeManager(cwd);
		sm.writeScope(scopeAllowing(join(cwd, "src", "index.js")), "delegation-A");
		sm.writeScope(scopeAllowing(join(cwd, "lib", "calc.js")), "delegation-B");

		// Delegation A finishes first — it must NOT delete B's file.
		sm.clearScope("delegation-A");
		expect(existsSync(sharedScopePath())).toBe(true);

		// The file still belongs to B (so B's in-scope writes stay allowed).
		const parsed = JSON.parse(readFileSync(sharedScopePath(), "utf-8"));
		expect(parsed.delegationId).toBe("delegation-B");

		// Delegation B finishes — now its own file is removed.
		sm.clearScope("delegation-B");
		expect(existsSync(sharedScopePath())).toBe(false);
	});

	it("a stale completion cannot re-block: guard for A still allows writes after sibling clear", () => {
		const idA = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const idB = createDelegationScope(scopeAllowing(join(cwd, "lib", "calc.js")));
		clearDelegationScope(idB);
		const res = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "src/index.js", content: "x" } },
			true,
			{ cwd },
			coderState(idA),
		);
		expect(res).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// C) ATOMIC WRITE — no torn reads
// ─────────────────────────────────────────────────────────────────────────────
describe("C) scope files are written atomically (temp file + rename)", () => {
	it("STRUCTURAL: scope-manager writes to a temp file then renameSync", () => {
		const src = readFileSync(resolve(__dirname, "scope-manager.ts"), "utf-8");
		expect(src).toContain("renameSync(tmpPath, filePath)");
		expect(src).toContain("function writeJsonAtomic(");
		// createDelegationScope must route through the atomic helper.
		expect(src).toContain("writeJsonAtomic(scopePath, scope)");
		expect(src).toContain("writeJsonAtomic(join(this.cwd, '.pi', 'scope.json'), contract)");
		// The whole writeScope() method must route through the atomic helper, never
		// a direct writeFileSync to the shared path.
		const start = src.indexOf("writeScope(manifest");
		const end = src.indexOf("readScope()", start);
		const writeScopeBody = src.slice(start, end === -1 ? src.length : end);
		expect(writeScopeBody).toContain("writeJsonAtomic(");
		expect(writeScopeBody).not.toContain("writeFileSync(");
	});

	it("BEHAVIOURAL: after a write the file is complete JSON and no .tmp file remains", () => {
		const id = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const filePath = join(agentDir, "scopes", `${id}.json`);
		expect(existsSync(filePath)).toBe(true);
		// Parses cleanly → never a partial file.
		expect(() => JSON.parse(readFileSync(filePath, "utf-8"))).not.toThrow();
		const leftovers = readdirSync(join(agentDir, "scopes")).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toHaveLength(0);
	});

	it("STRUCTURAL: the shared-file write is atomic too", () => {
		const src = readFileSync(resolve(__dirname, "scope-manager.ts"), "utf-8");
		const start = src.indexOf("writeScope(manifest");
		const end = src.indexOf("readScope()", start);
		const writeScopeBody = src.slice(start, end === -1 ? src.length : end);
		expect(writeScopeBody).toContain("writeJsonAtomic(");
		expect(writeScopeBody).not.toContain("writeFileSync(");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// D) macOS /private/tmp ALLOWED (Defect 2)
// ─────────────────────────────────────────────────────────────────────────────
describe("D) universal temp scratch paths are allowed (macOS /private/tmp)", () => {
	it("reports os.tmpdir() and allows the resolved macOS scratch form", () => {
		const td = os.tmpdir();
		// Actual value on this machine (macOS: /var/folders/<...>/T) — surfaced for
		// the report; the DEFECT-2 scratch path is /tmp -> /private/tmp.
		expect(typeof td).toBe("string");
		expect(td.length).toBeGreaterThan(0);

		// Guard with a real (per-delegation) scope that grants only src/.
		const id = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));
		const guard = new ScopeGuard(cwd, id);

		// Canonical scratch form (kept working).
		expect(guard.isPathAllowed("/tmp/scratch.txt", "write").allowed).toBe(true);
		// macOS resolved form — the false-positive this fixes.
		expect(guard.isPathAllowed("/private/tmp/scratch.txt", "write").allowed).toBe(true);
		// The resolved form of the scratch dir (realpath('/tmp') === '/private/tmp').
		try {
			const realTmp = realpathSync("/tmp");
			expect(guard.isPathAllowed(join(realTmp, "scratch.txt"), "write").allowed).toBe(true);
		} catch {
			/* /tmp missing on this platform — canonical form already covered */
		}

		// CONTROL: a genuinely out-of-scope non-temp path is still blocked.
		expect(guard.isPathAllowed("/etc/hosts", "write").allowed).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// E) REGRESSION — fail-closed still holds
// ─────────────────────────────────────────────────────────────────────────────
describe("E) fail-closed: a subagent with NO usable scope is blocked", () => {
	it("blocks a write when no scope exists at all", () => {
		expect(existsSync(sharedScopePath())).toBe(false);
		const res = handleSubagentToolCall(
			{ toolName: "write", input: { path: "lib/calc.js", content: "x" } },
			true,
			{ cwd },
			coderState(),
		);
		expect(res?.block).toBe(true);
	});

	it("blocks when a delegation id is present but its scope file is missing", () => {
		const res = handleSubagentToolCall(
			{ toolName: "edit", input: { path: "lib/calc.js", content: "x" } },
			true,
			{ cwd },
			coderState("missing-delegation-" + Date.now()),
		);
		expect(res?.block).toBe(true);
	});

	it("still allows reads regardless of scope state", () => {
		expect(
			handleSubagentToolCall({ toolName: "read", input: { path: "anything.ts" } }, true, { cwd }, coderState()),
		).toBeUndefined();
		expect(
			handleSubagentToolCall(
				{ toolName: "read", input: { path: "anything.ts" } },
				true,
				{ cwd },
				coderState("missing-delegation"),
			),
		).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// F) PRODUCTION BRIDGE — the runner must carry the pipeline's delegationId into
//    subagentSessions. This exercises the REAL writer (SubagentRunner.run), not a
//    hand-built SubagentState seam. It FAILS if the delegationId bridge is removed.
// ─────────────────────────────────────────────────────────────────────────────
describe("F) production bridge — SubagentRunner stores the per-delegation id on the session", () => {
	it("subagentSessions entry carries the SAME id createDelegationScope returned", { timeout: 30_000 }, async () => {
		// The pipeline produces the id via createDelegationScope; the runner must store
		// that exact id so the guard resolves THIS delegation's own scope file.
		const id = createDelegationScope(scopeAllowing(join(cwd, "src", "index.js")));

		const mockModel = { id: "test/delegate", contextWindow: 200_000 };
		const mockModelRegistry = {
			find: vi.fn(() => mockModel),
			getAvailable: vi.fn(() => [mockModel]),
			getAll: vi.fn(() => [mockModel]),
		} as any;

		const SESSION_ID = `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const mockSession = {
			sessionId: SESSION_ID,
			messages: [] as any[],
			subscribe: vi.fn(() => () => {}),
			abort: vi.fn(),
			prompt: vi.fn(async () => {}),
			dispose: vi.fn(),
		};

		const runner = new SubagentRunner({
			cwd,
			modelRegistry: mockModelRegistry,
			agentDir,
			agentSessionFactory: async () => ({ session: mockSession }),
			onUpdate: () => {},
		} as any);

		const specialist = { name: "coder" } as any;

		// Observe the REAL writer: SubagentRunner.run() populates subagentSessions with
		// `subagentSessions.set(sessionId, { specialistName, planParsed, blockedCalls, delegationId })`.
		// The runner deletes the entry in its `finally` (run() completes in ~10ms here),
		// so we capture the stored value at the moment of the production `set(...)` call.
		const setSpy = vi.spyOn(subagentSessions, "set");
		try {
			// run(task, specialist, scope?, skills?, parentCtx?, orchestratorCtx?, orchestratorUi?, delegationId?)
			await runner.run(
				"task", specialist,
				scopeAllowing(join(cwd, "src", "index.js")),
				undefined, undefined, undefined, undefined, id,
			);

			const stored = setSpy.mock.calls
				.filter((c) => c[0] === SESSION_ID)
				.map((c) => c[1] as SubagentState);
			expect(stored.length).toBeGreaterThan(0);

			// ── THE BRIDGE ASSERTION ──
			// Removing the delegationId from the runner's subagentSessions.set(...) makes
			// this undefined and the test fails — the assertion that catches the missing link.
			expect(stored[0].delegationId).toBe(id);
		} finally {
			setSpy.mockRestore();
			subagentSessions.delete(SESSION_ID);
		}
	});
});
