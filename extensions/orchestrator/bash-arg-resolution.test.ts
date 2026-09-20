/**
 * #139 regression tests — bash token resolution in handleSubagentToolCall.
 *
 * Bug: relative/dotted bash tokens were resolved against the delegation cwd
 * even when `cd <dir> && …` / `git -C <dir>` changed the effective directory;
 * quoted commit messages were scanned for path tokens; and chained commands
 * (`git add a.ts && git commit -m "fix b.ts"`) leaked one segment's tokens
 * into another's scope check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const SCOPE_DIR = "/work/root/repo";
const DELEGATION_CWD = "/work/root";

const ScopeGuardMock = vi.hoisted(() => vi.fn() as any);

vi.mock("./scope-guard.ts", () => ({ ScopeGuard: ScopeGuardMock }));
vi.mock("./bash-interceptor.ts", () => ({ getBashToolReplacement: vi.fn(() => ({ allowed: true })) }));
vi.mock("./bash-classifier.ts", () => ({ isWriteCommand: vi.fn((cmd: string) => /\bsed\s+-i\b/.test(String(cmd))) }));
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

/** Install a ScopeGuard stub whose scope is exactly SCOPE_DIR. */
function installGuard() {
	const guard = {
		isScopeValid: vi.fn(() => true),
		isPathAllowed: vi.fn((p: string) =>
			p === SCOPE_DIR || p.startsWith(SCOPE_DIR + "/")
				? { allowed: true }
				: { allowed: false, reason: `File not in approved scope: ${p}` },
		),
		checkFileSize: vi.fn((p: string, content: string) => {
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

function runBash(command: string, cwd: string = DELEGATION_CWD) {
	const guard = installGuard();
	const state: SubagentState = { specialistName: "coder", planParsed: true, cwd, blockedCalls: [] };
	const result = handleSubagentToolCall(
		{ toolName: "bash", input: { command } },
		true,
		{ cwd },
		state,
	);
	return { result, guard, state };
}

beforeEach(() => {
	ScopeGuardMock.mockReset();
});

describe("#139 bash path-token resolution", () => {
	it("(a) resolves relative staging args against the cd target, not the delegation cwd", () => {
		const { result, guard } = runBash(`cd ${SCOPE_DIR} && git add relative.ts`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/relative.ts`, "write");
		expect(guard.isPathAllowed).not.toHaveBeenCalledWith(`${DELEGATION_CWD}/relative.ts`, "write");
	});

	it("(b) allows plain `git add foo.test.ts` when the delegation cwd is inside scope", () => {
		const { result, guard } = runBash("git add foo.test.ts", SCOPE_DIR);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/foo.test.ts`, "write");
	});

	it('(c) allows `cd X && git commit -m "fix foo.ts"` without scanning the message', () => {
		const { result, guard } = runBash(`cd ${SCOPE_DIR} && git commit -m "fix foo.ts"`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).not.toHaveBeenCalled();
	});

	it('(d) `git add a.ts && git commit -m "fix b.ts"` checks only a.ts', () => {
		const { result, guard } = runBash(`git add a.ts && git commit -m "fix b.ts"`, SCOPE_DIR);
		expect(result?.block).toBeFalsy();
		const checked = guard.isPathAllowed.mock.calls.map((c: any[]) => String(c[0]));
		expect(checked).toContain(`${SCOPE_DIR}/a.ts`);
		expect(checked.some((p: string) => p.includes("b.ts"))).toBe(false);
	});

	it("(e) allows `cd X && git add big-500-line.ts` — staging args are not size-checked", () => {
		const { result, guard } = runBash(`cd ${SCOPE_DIR} && git add big-500-line.ts`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/big-500-line.ts`, "write");
		expect(guard.checkFileSize).not.toHaveBeenCalled();
	});

	it("(f) still blocks a genuine out-of-scope staging path with the contract message", () => {
		const { result, state } = runBash("git add /work/elsewhere/secret.ts");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /work/elsewhere/secret.ts is outside the allowed scope");
		expect(state.blockedCalls).toHaveLength(1);
		expect(state.blockedCalls[0].target).toBe("/work/elsewhere/secret.ts");
	});

	it("(g) still size-blocks genuine bash writes: sed -i on an in-scope >400-line file", () => {
		const { result, guard } = runBash(`sed -i 's/old/new/' ${SCOPE_DIR}/huge.ts`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("File too large");
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/huge.ts`, "write");
		expect(guard.checkFileSize).toHaveBeenCalledWith(`${SCOPE_DIR}/huge.ts`, expect.any(String), "write");
	});

	it("(h) resolves args against the `git -C <dir>` target", () => {
		const { result, guard } = runBash(`git -C ${SCOPE_DIR} add x.ts`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/x.ts`, "write");
	});

	it('(i) exempts env-prefixed `VAR=1 git commit -m "fix foo.ts"`', () => {
		const { result, guard } = runBash(`VAR=1 git commit -m "fix foo.ts"`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).not.toHaveBeenCalled();
	});
});
