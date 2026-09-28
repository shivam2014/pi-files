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
import { homedir } from "node:os";

const SCOPE_DIR = "/work/root/repo";
const DELEGATION_CWD = "/work/root";

const ScopeGuardMock = vi.hoisted(() => vi.fn() as any);

vi.mock("./scope-guard.ts", () => ({ ScopeGuard: ScopeGuardMock }));
vi.mock("./bash-interceptor.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./bash-interceptor.ts")>()),
	getBashToolReplacement: vi.fn(() => ({ allowed: true })),
}));
// bash-classifier is intentionally NOT mocked: tests exercise the REAL
// isWriteCommand so write/read classification (e.g. sed -i) is verified end to end.
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
		isPathAllowed: vi.fn((p: string, op?: string) =>
			op === "read" || p === SCOPE_DIR || p.startsWith(SCOPE_DIR + "/")
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

describe("guard false-positive batch — tilde extraction, .c truncation, for-loop lists, wrapper size gate", () => {
	it("(tilde) expands `~/.pi/claim.sh` before scope resolution", () => {
		const { result, guard, state } = runBash("bash ~/.pi/claim.sh");
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${homedir()}/.pi/claim.sh`, "write");
		expect(guard.isPathAllowed).not.toHaveBeenCalledWith("/.pi/claim.sh", expect.anything());
		expect(state.blockedCalls[0]?.target).toBe("~/.pi/claim.sh");
		expect(result?.reason).toBe("Scope violation: ~/.pi/claim.sh is outside the allowed scope");
	});

	it("(truncation) resolves `.claimed-by` whole, not as `.c`", () => {
		const { result, guard, state } = runBash("touch /work/root/.claimed-by");
		expect(guard.isPathAllowed).toHaveBeenCalledWith("/work/root/.claimed-by", "write");
		expect(guard.isPathAllowed).not.toHaveBeenCalledWith("/work/root/.c", expect.anything());
		expect(result?.reason).toBe("Scope violation: /work/root/.claimed-by is outside the allowed scope");
		expect(state.blockedCalls[0]?.target).toBe("/work/root/.claimed-by");
	});

	it("(truncation) allows an in-scope `.claimed-by` with the full path checked", () => {
		const { result, guard } = runBash("touch /work/root/repo/.claimed-by");
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith("/work/root/repo/.claimed-by", "write");
	});

	it("(loop) treats `for … in` items as data, not scope-checked operands", () => {
		const { result, guard } = runBash(
			"for f in guard-hardening.test.ts; do shasum -a 256 /work/root/repo/$f; done",
		);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).not.toHaveBeenCalledWith("/work/root/guard-hardening.test.ts", "write");
	});

	it("(loop) still blocks an out-of-scope redirect inside the loop body", () => {
		const { result } = runBash(
			"for f in /work/root/repo/a.ts; do shasum -a 256 $f > /outside/out.txt; done",
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/out.txt is outside the allowed scope");
	});

	it("(wrapper) `perl -e '<script>' <in-scope file>` skips the size gate for script operands", () => {
		const { result, guard } = runBash(`perl -e 'alarm 90; exec @ARGV' -- ${SCOPE_DIR}/huge.ts`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/huge.ts`, "write");
		expect(guard.checkFileSize).not.toHaveBeenCalled();
	});

	it("(wrapper) still size-blocks a real write redirect target", () => {
		const { result } = runBash(`perl -e 'print 1' > ${SCOPE_DIR}/huge.ts`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe(`File too large: ${SCOPE_DIR}/huge.ts`);
	});

	it("(wrapper) still scope-blocks a genuine out-of-scope redirect", () => {
		const { result } = runBash("perl -e 'print 1' > /outside/x.ts");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it("(wrapper) still scope-checks script operands (scope gate not weakened)", () => {
		const { result } = runBash("perl -e 'unlink @ARGV' /outside/x.ts");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});
});

// ── Round 7: /dev/null redirect targets are never scope-checked ──
// Live probe (scoped coder, scope /tmp): `ls /tmp >/dev/null; echo exit=$?`
// blocked with "Scope violation: /dev/null is outside the allowed scope" while
// `2>/dev/null` passed. /dev/null is a bit bucket — fd-1 redirect targets
// equal to it must never reach the scope gate, in every redirect form
// (`>`, `>>`, `N>`, `&>`, `>&`). fd-duplication (`2>&1`) stays unaffected.

describe("round 7 — /dev/null redirect targets", () => {
	it("allows the verbatim probe `ls /tmp >/dev/null; echo exit=$?`", () => {
		const { result, guard } = runBash("ls /tmp >/dev/null; echo exit=$?");
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).not.toHaveBeenCalledWith("/dev/null", expect.anything());
	});

	it("allows `ls /tmp 2>/dev/null | head -1` (stderr suppression unchanged)", () => {
		const { result } = runBash("ls /tmp 2>/dev/null | head -1");
		expect(result?.block).toBeFalsy();
	});

	it("allows `ls /tmp &>/dev/null` (combined stdout+stderr form)", () => {
		const { result } = runBash("ls /tmp &>/dev/null");
		expect(result?.block).toBeFalsy();
	});

	it("allows `ls /tmp >&/dev/null` (>& form)", () => {
		const { result } = runBash("ls /tmp >&/dev/null");
		expect(result?.block).toBeFalsy();
	});

	it("allows `ls /tmp 1>/dev/null` (explicit fd-1 form)", () => {
		const { result } = runBash("ls /tmp 1>/dev/null");
		expect(result?.block).toBeFalsy();
	});

	it("allows `ls /tmp >>/dev/null` (append form)", () => {
		const { result } = runBash("ls /tmp >>/dev/null");
		expect(result?.block).toBeFalsy();
	});

	it("allows `echo x > /tmp/x` (real /tmp target stays allowed)", () => {
		const { result } = runBash("echo x > /tmp/x");
		expect(result?.block).toBeFalsy();
	});

	it("still blocks `echo x > /outside/y` (real out-of-scope target)", () => {
		const { result } = runBash("echo x > /outside/y");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/y is outside the allowed scope");
	});

	it("still blocks `echo x 1>/outside/y` (explicit fd-1 real target)", () => {
		const { result } = runBash("echo x 1>/outside/y");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/y is outside the allowed scope");
	});

	it("still blocks `echo x &>/outside/y` (combined form, real target)", () => {
		const { result } = runBash("echo x &>/outside/y");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/y is outside the allowed scope");
	});

	it("leaves fd-duplication `2>&1` unaffected", () => {
		const { result, guard } = runBash("ls /tmp 2>&1; echo done");
		expect(guard.isPathAllowed).not.toHaveBeenCalledWith("/dev/null", expect.anything());
		expect(result?.reason ?? "").not.toContain("/dev/null");
	});

	it("does not fabricate a `2>/…` path from attached fd-2 syntax", () => {
		const { result, guard } = runBash(`rm ${SCOPE_DIR}/stale.txt 2>/dev/null`);
		expect(result?.block).toBeFalsy();
		expect(
			guard.isPathAllowed.mock.calls.map((c: any[]) => String(c[0])).some((p: string) => p.includes("2>")),
		).toBe(false);
	});
});
