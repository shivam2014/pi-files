/**
 * Guard-hardening regression tests (audit fixes C1–C5, W1, W2 + force-plan).
 *
 * Covers, against the REAL classifier/interceptor semantics:
 *   - escaped-quote tokenization (C2)
 *   - empty-quoted token flush leak (C3)
 *   - quoted-token path scanning (C4)
 *   - per-segment write classification (C1)
 *   - mid-chain `cd` / `git -C` base-dir folding (C5)
 *   - boolean-flag operand scanning (W1)
 *   - broadened extension allowlist / extensionless write paths (W2)
 *   - force-plan gate for read-only children (planSteps itself never gated)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const SCOPE_DIR = "/work/root/repo";
const DELEGATION_CWD = "/work/root";

const ScopeGuardMock = vi.hoisted(() => vi.fn() as any);

vi.mock("./scope-guard.ts", () => ({ ScopeGuard: ScopeGuardMock }));
vi.mock("./bash-interceptor.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./bash-interceptor.ts")>()),
	getBashToolReplacement: vi.fn(() => ({ allowed: true })),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({ isToolCallEventType: vi.fn(() => true) }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: vi.fn((path: string) => {
			if (String(path).endsWith("huge.ts")) {
				return Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
			}
			throw new Error("ENOENT");
		}),
	};
});

import { handleSubagentToolCall } from "./subagent-tool-guard";
import type { SubagentState } from "./subagent-sessions";

/** Install a ScopeGuard stub whose scope is exactly SCOPE_DIR (reads always allowed). */
function installGuard() {
	const guard = {
		isScopeValid: vi.fn(() => true),
		isPathAllowed: vi.fn((p: string, op?: string) =>
			op === "read" || p === SCOPE_DIR || p.startsWith(SCOPE_DIR + "/")
				? { allowed: true }
				: { allowed: false, reason: `File not in approved scope: ${p}` },
		),
		checkFileSize: vi.fn((p: string, content: string, op?: string) => {
			if (op === "read") return { allowed: true };
			const lines = typeof content === "string" && content.length > 0 ? content.split("\n").length : 0;
			return lines > 400 ? { allowed: false, reason: `File too large: ${p}` } : { allowed: true };
		}),
		requestExpansion: vi.fn(() => null),
	};
	ScopeGuardMock.mockImplementation(function (this: any) {
		return guard;
	});
	return guard;
}

function runBash(command: string, opts: { readOnly?: boolean; planParsed?: boolean } = {}) {
	const guard = installGuard();
	const state: SubagentState = {
		specialistName: opts.readOnly ? "reviewer" : "coder",
		planParsed: opts.planParsed !== false,
		cwd: DELEGATION_CWD,
		blockedCalls: [],
	};
	const result = handleSubagentToolCall(
		{ toolName: "bash", input: { command } },
		true,
		{ cwd: DELEGATION_CWD, readOnly: opts.readOnly === true },
		state,
	);
	return { result, guard, state };
}

beforeEach(() => {
	ScopeGuardMock.mockReset();
});

describe("C2/C3/C4 — quote, escape, and quoted-path handling", () => {
	it('blocks `echo \\" && rm -f /outside/x.ts` (escaped quote cannot fuse the chain)', () => {
		const { result } = runBash('echo \\" && rm -f /outside/x.ts');
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it("blocks `rm '' /outside/x.ts` (empty quoted token must not leak the quoted flag)", () => {
		const { result } = runBash("rm '' /outside/x.ts");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it('blocks `rm "/outside/x.ts"` (quoted paths are still scanned)', () => {
		const { result } = runBash('rm "/outside/x.ts"');
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it("blocks `tee '/outside/x.ts'` (quoted paths are still scanned)", () => {
		const { result } = runBash("tee '/outside/x.ts'");
		expect(result?.block).toBe(true);
	});
});

describe("C1 — per-segment write classification", () => {
	it("blocks `cd X && rm -f /outside/y`", () => {
		const { result } = runBash("cd X && rm -f /outside/y");
		expect(result?.block).toBe(true);
	});

	it("blocks `echo x && rm -f /outside/y` (second segment is write-classified)", () => {
		const { result } = runBash("echo x && rm -f /outside/y");
		expect(result?.block).toBe(true);
	});
});

describe("C5 — base-dir folding across the whole chain", () => {
	it("blocks `true && cd /outside && git add x.ts` (mid-chain cd rebases staging)", () => {
		const { result } = runBash("true && cd /outside && git add x.ts");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: x.ts is outside the allowed scope");
	});

	it("blocks `export A=1; cd /outside && git add x.ts`", () => {
		const { result } = runBash("export A=1; cd /outside && git add x.ts");
		expect(result?.block).toBe(true);
	});

	it("allows `cd <scope> && git add relative.ts` (in-scope rebase still works)", () => {
		const { result, guard } = runBash(`cd ${SCOPE_DIR} && git add relative.ts`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/relative.ts`, "write");
	});
});

describe("W1/W2 — flag operands and broadened path matching", () => {
	it("blocks `rm -f /outside/x.ts` (boolean -f must not swallow its operand)", () => {
		const { result } = runBash("rm -f /outside/x.ts");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it("blocks extensionless write target `tee /outside/secret` (W2)", () => {
		const { result } = runBash("tee /outside/secret");
		expect(result?.block).toBe(true);
	});

	it("size-blocks `sed -i` on an in-scope >400-line file (real classifier + write op)", () => {
		const { result, guard } = runBash(`sed -i 's/old/new/' ${SCOPE_DIR}/huge.ts`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("File too large");
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/huge.ts`, "write");
	});
});

describe("commit-message exemption (argument position, not quoting)", () => {
	it('allows `git commit -m "fix foo.ts"`', () => {
		const { result, guard } = runBash('git commit -m "fix foo.ts"');
		expect(result?.block).toBeFalsy();
		const checked = guard.isPathAllowed.mock.calls.map((c: any[]) => String(c[0]));
		expect(checked.some((p) => p.includes("foo.ts"))).toBe(false);
	});

	it('allows chained `git add <in-scope> && git commit -m "fix …"`', () => {
		const { result, guard } = runBash(`git add ${SCOPE_DIR}/a.ts && git commit -m "fix ${SCOPE_DIR}/index.ts"`);
		expect(result?.block).toBeFalsy();
		const checked = guard.isPathAllowed.mock.calls.map((c: any[]) => String(c[0]));
		expect(checked).toContain(`${SCOPE_DIR}/a.ts`);
		expect(checked.some((p) => p.includes("index.ts"))).toBe(false);
	});
});

describe("force-plan gate (all tools, planSteps exempt)", () => {
	it("gates a read-only child's first read call when no plan exists", () => {
		installGuard();
		const state: SubagentState = { specialistName: "reviewer", planParsed: false, cwd: DELEGATION_CWD, blockedCalls: [] };
		const result = handleSubagentToolCall({ toolName: "read", input: { path: "src/index.ts" } }, true, undefined, state);
		expect(result).toEqual({
			block: true,
			reason: "[guard] Framework plan gate: call planSteps({ goal, steps }) before using read. This notice is a framework prerequisite, not a plan step.",
		});
	});

	it("never gates planSteps itself (no deadlock)", () => {
		installGuard();
		const state: SubagentState = { specialistName: "reviewer", planParsed: false, cwd: DELEGATION_CWD, blockedCalls: [] };
		const result = handleSubagentToolCall({ toolName: "planSteps", input: { goal: "g", steps: ["s"] } }, true, undefined, state);
		expect(result).toBeUndefined();
	});
});
