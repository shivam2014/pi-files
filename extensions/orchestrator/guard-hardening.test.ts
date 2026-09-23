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
 *
 * Round 2 (live-verified false negatives):
 *   - git write ops with no extractable path feed the no-scope fail-closed gate (C-3)
 *   - env-prefixed write payloads (C-1)
 *   - command substitutions + interpreter script files (C-2)
 *   - cp/mv/install `-t` target-directory operands are write targets (C-4)
 *   - pipe-bridged xargs writes re-escalate prior read paths (C-5)
 *   - quoted extensionless targets, commit -am/-F positions, escaped `\;`,
 *     target-aware readOnly /tmp exemption (warnings a–d)
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

function runBash(command: string, opts: { readOnly?: boolean; planParsed?: boolean; noScope?: boolean } = {}) {
	const guard = installGuard();
	if (opts.noScope) guard.isScopeValid.mockReturnValue(false);
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

describe("C3 (round 2) — git write ops with no extractable path", () => {
	it("blocks `git add -A` with no scope (write op feeds the fail-closed gate)", () => {
		const { result } = runBash("git add -A", { noScope: true });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("no approved scope");
	});

	it("blocks `git reset --hard` with no scope", () => {
		const { result } = runBash("git reset --hard", { noScope: true });
		expect(result?.block).toBe(true);
	});

	it("blocks `git clean -fdx` with no scope", () => {
		const { result } = runBash("git clean -fdx", { noScope: true });
		expect(result?.block).toBe(true);
	});

	it("still allows `git add -A` when a scope is established", () => {
		const { result } = runBash("git add -A");
		expect(result?.block).toBeFalsy();
	});
});

describe("C1 (round 2) — env-prefixed write payloads", () => {
	it("blocks `env X=1 rm -f /outside/x.ts` for a scoped coder", () => {
		const { result } = runBash("env X=1 rm -f /outside/x.ts");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it("blocks env-prefixed writes for read-only specialists", () => {
		const { result } = runBash("env X=1 rm -f /outside/x.ts", { readOnly: true });
		expect(result?.block).toBe(true);
	});

	it("allows `env X=1 rm -f <in-scope>/x.ts`", () => {
		const { result } = runBash(`env X=1 rm -f ${SCOPE_DIR}/x.ts`);
		expect(result?.block).toBeFalsy();
	});
});

describe("C2 (round 2) — command substitution in quoted/unquoted text", () => {
	it('blocks `echo "$(rm -f /outside/x.ts)"`', () => {
		const { result } = runBash('echo "$(rm -f /outside/x.ts)"');
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it("blocks unquoted `echo $(rm -f /outside/x.ts)`", () => {
		const { result } = runBash("echo $(rm -f /outside/x.ts)");
		expect(result?.block).toBe(true);
	});

	it("blocks backtick substitution", () => {
		const { result } = runBash("echo `rm -f /outside/x.ts`");
		expect(result?.block).toBe(true);
	});

	it("blocks substitution for read-only specialists", () => {
		const { result } = runBash('echo "$(rm -f /outside/x.ts)"', { readOnly: true });
		expect(result?.block).toBe(true);
	});

	it("checks in-scope substitution targets as write paths", () => {
		const { result, guard } = runBash(`echo "$(rm -f ${SCOPE_DIR}/x.ts)"`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/x.ts`, "write");
	});
});

describe("C2 (round 2) — interpreter script files / inline code", () => {
	it("blocks `node /outside/script.js`", () => {
		const { result } = runBash("node /outside/script.js");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/script.js is outside the allowed scope");
	});

	it("blocks `node -p` inline code for read-only specialists", () => {
		const { result } = runBash('node -p "1+1"', { readOnly: true });
		expect(result?.block).toBe(true);
	});

	it("blocks `python3 /outside/script.py`", () => {
		const { result } = runBash("python3 /outside/script.py");
		expect(result?.block).toBe(true);
	});

	it("blocks stdin-heredoc interpreters for read-only specialists", () => {
		const { result } = runBash("python3 <<'EOF'", { readOnly: true });
		expect(result?.block).toBe(true);
	});

	it("blocks `awk -i inplace` on an out-of-scope file", () => {
		const { result } = runBash(`awk -i inplace '{$0="x"}' /outside/f.ts`);
		expect(result?.block).toBe(true);
	});

	it("keeps `node --version` and `node --test` read-class", () => {
		expect(runBash("node --version").result?.block).toBeFalsy();
		expect(runBash("node --test").result?.block).toBeFalsy();
	});
});

describe("C4 (round 2) — target-directory operand is a write target", () => {
	it("blocks `cp -t /outside <in-scope-src>`", () => {
		const { result } = runBash(`cp -t /outside ${SCOPE_DIR}/a.ts`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside is outside the allowed scope");
	});

	it("blocks `mv -t /outside <in-scope-src>`", () => {
		const { result } = runBash(`mv -t /outside ${SCOPE_DIR}/a.ts`);
		expect(result?.block).toBe(true);
	});

	it("blocks `install -t /outside <in-scope-src>`", () => {
		const { result } = runBash(`install -t /outside ${SCOPE_DIR}/a.ts`);
		expect(result?.block).toBe(true);
	});

	it("allows `cp -t <in-scope-dir> src.ts`", () => {
		const { result } = runBash(`cp -t ${SCOPE_DIR}/sub ${SCOPE_DIR}/a.ts`);
		expect(result?.block).toBeFalsy();
	});
});

describe("C5 (round 2) — pipe-bridged xargs write", () => {
	it("blocks `echo /outside/x.ts | xargs rm -f` (prior read path re-escalated)", () => {
		const { result } = runBash("echo /outside/x.ts | xargs rm -f");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x.ts is outside the allowed scope");
	});

	it("allows `echo <in-scope>/x.ts | xargs rm -f` and checks it as write", () => {
		const { result, guard } = runBash(`echo ${SCOPE_DIR}/x.ts | xargs rm -f`);
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith(`${SCOPE_DIR}/x.ts`, "write");
	});

	it("does not re-escalate across `;` (different pipeline)", () => {
		const { result } = runBash("echo /outside/x.ts ; xargs rm -f");
		expect(result?.block).toBeFalsy();
	});
});

describe("warnings (round 2) — quoted extensionless, commit flags, escaped separators, /tmp targets", () => {
	it('blocks `tee "/outside/secret"` (quoted extensionless target)', () => {
		const { result } = runBash('tee "/outside/secret"');
		expect(result?.block).toBe(true);
	});

	it('allows `git commit -am "fix /outside/x.ts"` (combined -am message position)', () => {
		expect(runBash('git commit -am "fix /outside/x.ts"').result?.block).toBeFalsy();
	});

	it('allows `git commit -F /outside/msg.txt` (message file position)', () => {
		expect(runBash("git commit -F /outside/msg.txt").result?.block).toBeFalsy();
	});

	it("still blocks `git commit /outside/x.ts` (positional path)", () => {
		const { result } = runBash("git commit /outside/x.ts");
		expect(result?.block).toBe(true);
	});

	it("does not split on escaped `\\;` (literal echo argument)", () => {
		expect(runBash("echo a \\; rm -f /outside/x.ts").result?.block).toBeFalsy();
	});

	it("blocks read-only `mv <in-scope-src> /tmp/x` (target-aware /tmp exemption)", () => {
		const { result } = runBash(`mv ${SCOPE_DIR}/src.ts /tmp/x`, { readOnly: true });
		expect(result?.block).toBe(true);
	});

	it("still allows read-only scratch writes (`cat f > /tmp/out.txt`, `tee /tmp/out.txt`)", () => {
		expect(runBash("cat f > /tmp/out.txt", { readOnly: true }).result?.block).toBeFalsy();
		expect(runBash("tee /tmp/out.txt", { readOnly: true }).result?.block).toBeFalsy();
	});

	it("blocks read-only copies whose TARGET is outside /tmp", () => {
		const { result } = runBash("cp /tmp/a /outside/b.ts", { readOnly: true });
		expect(result?.block).toBe(true);
	});
});

describe("round 3 — read-tool allowlist + redirect-target scope", () => {
	it("allows `shasum -a 256 <in-scope>` for a read-only specialist", () => {
		expect(runBash(`shasum -a 256 ${SCOPE_DIR}/src.ts`, { readOnly: true }).result?.block).toBeFalsy();
	});

	it("allows `diff -q a b` for a read-only specialist", () => {
		expect(runBash(`diff -q ${SCOPE_DIR}/a.ts ${SCOPE_DIR}/b.ts`, { readOnly: true }).result?.block).toBeFalsy();
	});

	it("allows `cmp a b` for a read-only specialist", () => {
		expect(runBash(`cmp ${SCOPE_DIR}/a.ts ${SCOPE_DIR}/b.ts`, { readOnly: true }).result?.block).toBeFalsy();
	});

	it("allows `tail -40 <log>` and `wc -l <f>` for a read-only specialist", () => {
		expect(runBash(`tail -40 ${SCOPE_DIR}/build.log`, { readOnly: true }).result?.block).toBeFalsy();
		expect(runBash(`wc -l ${SCOPE_DIR}/src.ts`, { readOnly: true }).result?.block).toBeFalsy();
	});

	it("classifies compounds deterministically: `stat | tail` allowed for readOnly", () => {
		expect(runBash(`stat ${SCOPE_DIR}/src.ts | tail -5`, { readOnly: true }).result?.block).toBeFalsy();
	});

	it("classifies compounds deterministically: `stat | sort -rn | head` allowed for readOnly", () => {
		expect(runBash(`stat ${SCOPE_DIR}/src.ts | sort -rn | head -3`, { readOnly: true }).result?.block).toBeFalsy();
	});

	it("classifies compounds deterministically: `ps aux | tail -3` allowed for readOnly", () => {
		expect(runBash("ps aux | tail -3", { readOnly: true }).result?.block).toBeFalsy();
	});

	it("allows readOnly `cat <out-of-scope> > /tmp/x` — redirect SOURCE keeps read-op", () => {
		const { result, guard } = runBash("cat /outside/secret.ts > /tmp/x", { readOnly: true });
		expect(result?.block).toBeFalsy();
		expect(guard.isPathAllowed).toHaveBeenCalledWith("/outside/secret.ts", "read");
	});

	it("blocks `cat <in-scope> > /outside/x` — redirect TARGET is the write op", () => {
		const { result } = runBash(`cat ${SCOPE_DIR}/src.ts > /outside/x`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x is outside the allowed scope");
	});

	it("blocks `echo x > /outside/y` (read verb, redirect target out of scope)", () => {
		const { result } = runBash("echo x > /outside/y");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/y is outside the allowed scope");
	});

	it("still blocks `tee /outside/x` (write by VERB — operands stay write-op)", () => {
		const { result } = runBash("tee /outside/x");
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x is outside the allowed scope");
	});

	it("still blocks read-only `mv <in-scope-src> /tmp/x` (verb write keeps write-op operands)", () => {
		expect(runBash(`mv ${SCOPE_DIR}/src.ts /tmp/x`, { readOnly: true }).result?.block).toBe(true);
	});

	it("keeps `bash -c …` write-class for read-only specialists (BY DESIGN)", () => {
		expect(runBash(`bash -c 'cat ${SCOPE_DIR}/src.ts'`, { readOnly: true }).result?.block).toBe(true);
	});

	it("exempts the attached redirect form `>>/tmp/x` from scope checks (cleaned target)", () => {
		const { result } = runBash(`cat ${SCOPE_DIR}/src.ts >>/tmp/x`, { readOnly: true });
		expect(result?.block).toBeFalsy();
	});

	it("blocks the attached redirect form `>>/outside/x` (cleaned target is scope-checked)", () => {
		const { result } = runBash(`cat ${SCOPE_DIR}/src.ts >>/outside/x`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Scope violation: /outside/x is outside the allowed scope");
	});
});
