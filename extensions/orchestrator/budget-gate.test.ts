/**
 * budget-gate.test.ts
 *
 * PART A — programmatic exploration-budget gate (subagent-runner.ts).
 *   The budget is enforced IN CODE from counted tool calls / turns, so a
 *   subagent that crosses ESCALATION_MAX_* cannot mask the breach with a
 *   self-reported `recommend=none`. On a breach the delegate difficulty signal's
 *   `recommend` is FORCED to `investigate`.
 *
 * PART B — ask-resolver surfaces a worker escalation carrying
 *   `recommend: investigate|plan|review` to the orchestrator instead of
 *   silently buffering it.
 */
import { describe, it, expect, vi } from "vitest";
import {
	SubagentRunner,
	computeBudgetStatus,
	forceDifficultyRecommend,
	extractToolFilePath,
	BUDGET_WRAPUP_MESSAGE,
} from "./subagent-runner.ts";
import { DelegatePipeline, extractDifficultyFromOutput, formatResult, formatDifficultySignal, shouldDowngradeRecommend } from "./delegate-pipeline.ts";
import type { DelegationBudget } from "./types.ts";
import { createAskOrchestratorResolver, detectEscalationSignal, UNANSWERED_SENTINEL } from "./ask-resolver.ts";
import {
	ESCALATION_MAX_EXPLORATION_CALLS,
	ESCALATION_MAX_FILES_TOUCHED,
	ESCALATION_MAX_TURNS,
	resolveDelegationBudget,
} from "./specialists.ts";

// The real model runtime and theme modules do network/console I/O during setup —
// mock them so the runner reaches the subscribe step deterministically.
vi.mock("./orchestrator-theme.ts", () => ({
	getTheme: vi.fn(() => ({
		fg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
		bg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
	})),
	statusIcon: vi.fn(() => "*"),
	styledSymbol: vi.fn(() => "*"),
	formatDuration: vi.fn((ms: number) => `${ms}ms`),
	formatTokens: vi.fn((count: number) => `${count}`),
	partialStrikethrough: vi.fn((text: string) => text),
	initTheme: vi.fn(),
	SYMBOLS: { "token.input": "^", "token.output": "v", "token.cacheRead": "~" },
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		ModelRuntime: { create: vi.fn().mockResolvedValue({}) },
	};
});

// ── PART A.1: pure budget math ──────────────────────────────────────────────
describe("computeBudgetStatus (pure counted budget)", () => {
	it("under budget → not exceeded", () => {
		const s = computeBudgetStatus({ read: 2, grep: 1 }, 2, 3);
		expect(s.exceeded).toBe(false);
		expect(s.breachKind).toBe("none");
		expect(s.reason).toBe("");
		expect(s.explorationCalls).toBe(3);
	});

	it("exploration count crosses the budget → exceeded with reason", () => {
		const calls = ESCALATION_MAX_EXPLORATION_CALLS + 1;
		// Keep distinct files/turns under budget so ONLY the exploration count crosses.
		const s = computeBudgetStatus({ read: calls }, 1, 1);
		expect(s.exceeded).toBe(true);
		expect(s.breachKind).toBe("substantive");
		expect(s.reason).toContain(`exploration calls ${calls} > ${ESCALATION_MAX_EXPLORATION_CALLS}`);
	});

	it("exactly at every limit is NOT exceeded (strict >, matches 'MORE THAN')", () => {
		const s = computeBudgetStatus({ read: ESCALATION_MAX_EXPLORATION_CALLS }, ESCALATION_MAX_FILES_TOUCHED, ESCALATION_MAX_TURNS);
		expect(s.exceeded).toBe(false);
		expect(s.breachKind).toBe("none");
	});

	it("distinct-files budget crossed → exceeded", () => {
		const s = computeBudgetStatus({}, ESCALATION_MAX_FILES_TOUCHED + 1, 0);
		expect(s.exceeded).toBe(true);
		expect(s.breachKind).toBe("files-only");
		expect(s.reason).toContain("distinct files");
	});

	it("turns budget crossed → exceeded", () => {
		const s = computeBudgetStatus({}, 0, ESCALATION_MAX_TURNS + 1);
		expect(s.exceeded).toBe(true);
		expect(s.breachKind).toBe("turns-only");
		expect(s.reason).toContain("turns");
	});

	it("exploration tools are read+grep+find+ls (find/ls count; bash/edit are not exploration)", () => {
		// Reverted: find/ls contribute to the exploration cap — locating a file is
		// exploration just like reading it. bash/edit are not exploration tools.
		const s = computeBudgetStatus({ read: 3, grep: 1, find: 2, ls: 1, bash: 99, edit: 99 }, 0, 0);
		expect(s.explorationCalls).toBe(7); // read 3 + grep 1 + find 2 + ls 1
		expect(s.exceeded).toBe(false); // 7 is still under the exploration budget (10)
	});
});

describe("extractToolFilePath (best-effort path extraction)", () => {
	it("reads args.path / args.file for read/edit/write", () => {
		expect(extractToolFilePath("read", { path: "/a/b.ts" })).toBe("/a/b.ts");
		expect(extractToolFilePath("edit", { file: "c/d.ts" })).toBe("c/d.ts");
	});
	it("reads args.dir / args.directory for ls/find", () => {
		expect(extractToolFilePath("ls", { dir: "/src" })).toBe("/src");
		expect(extractToolFilePath("find", { directory: "/app" })).toBe("/app");
	});
	it("returns undefined when no reliable path is present", () => {
		expect(extractToolFilePath("grep", { pattern: "foo" })).toBeUndefined();
		expect(extractToolFilePath("bash", { command: "ls" })).toBeUndefined();
		expect(extractToolFilePath("read", null)).toBeUndefined();
	});
});

// ── PART A.3a: forced difficulty override (pure) ────────────────────────────
describe("forceDifficultyRecommend (programmatic recommend override)", () => {
	it("overrides an existing recommend:none → investigate, preserving other fields", () => {
		const out = `## Findings\n- summary: explored broadly\n\n## Difficulty\n- exploration: high\n- uncertainty: low\n- verification: pass\n- iteration: low\n- recommend: none\n`;
		const forced = forceDifficultyRecommend(out, "investigate");
		const d = extractDifficultyFromOutput(forced)!;
		expect(d.recommend).toBe("investigate");
		expect(d.exploration).toBe("high");
		expect(d.verification).toBe("pass");
	});

	it("appends a difficulty block when the model omitted one", () => {
		const out = "## Findings\n- summary: done\n";
		const forced = forceDifficultyRecommend(out, "investigate");
		expect(forced).toContain("## Difficulty");
		expect(extractDifficultyFromOutput(forced)!.recommend).toBe("investigate");
	});

	it("the forced signal reaches the orchestrator-facing [Difficulty: ...] line", () => {
		const out = `## Findings\n- summary: done\n\n## Difficulty\n- exploration: high\n- uncertainty: low\n- verification: pass\n- iteration: low\n- recommend: none\n`;
		const forced = forceDifficultyRecommend(out, "investigate");
		const r = formatResult({
			output: forced,
			metrics: { readCalls: 7, grepCalls: 0, findCalls: 0, editCalls: 0, writeCalls: 0, bashCalls: 0, lsCalls: 0 } as any,
			elapsed: 1, turns: 7, toolCalls: 7, status: "ok",
		});
		expect(r.formatted).toContain("recommend=investigate");
	});

	it("BUDGET_WRAPUP_MESSAGE tells the subagent to stop exploring and report honestly", () => {
		expect(BUDGET_WRAPUP_MESSAGE).toMatch(/exceeded your exploration budget/i);
		expect(BUDGET_WRAPUP_MESSAGE).toMatch(/## Difficulty/);
		expect(BUDGET_WRAPUP_MESSAGE).toMatch(/honest/i);
		// FIX: the nudge must NOT prescribe `recommend: investigate` — that value
		// would self-justify the budget gate's forcing rule (circular escalation).
		expect(BUDGET_WRAPUP_MESSAGE).not.toMatch(/recommend: investigate/);
	});
});

// ── PART A: end-to-end runner behavior ──────────────────────────────────────
type SubscribeCb = (event: any) => void;

function createRunner(specialistName = "budget-specialist", budget?: DelegationBudget) {
	const ref = { subscribeCb: null as SubscribeCb | null };
	// Captured session options — lets a test invoke the planSteps/advanceStep custom
	// tools directly (probe-mirror e2e: plan parsed mid-run, final step auto-closed).
	const captured = { sessionOptions: null as any };
	let resolvePrompt: () => void = () => {};
	let rejectPrompt: (e: Error) => void = () => {};
	let promptCalls = 0;
	const mockSession = {
		sessionId: `test-${specialistName}`,
		messages: [] as any[],
		subscribe: vi.fn((cb: SubscribeCb) => {
			ref.subscribeCb = cb;
			return () => {};
		}),
		abort: vi.fn(() => rejectPrompt(new Error("AbortError"))),
		prompt: vi.fn(() => {
			promptCalls++;
			if (promptCalls === 1) {
				return new Promise<void>((res, rej) => {
					resolvePrompt = res;
					rejectPrompt = rej;
				});
			}
			// Budget wrap-up / stall nudges resolve immediately.
			return Promise.resolve();
		}),
		dispose: vi.fn(),
	};
	const mockModel = { contextWindow: 200_000 };
	const mockModelRegistry = {
		find: vi.fn(() => mockModel),
		getAvailable: vi.fn(() => [mockModel]),
		getAll: vi.fn(() => [mockModel]),
	} as any;
	const runner = new SubagentRunner({
		cwd: "/tmp",
		modelRegistry: mockModelRegistry,
		agentDir: "/Users/shivam94/.pi/agent",
		agentSessionFactory: async (opts: any) => {
			captured.sessionOptions = opts;
			return { session: mockSession };
		},
	} as any);
	const specialist = { name: specialistName, tools: ["read", "grep", "find", "ls", "bash", "edit"], systemPrompt: "p" } as any;
	const resultPromise = runner.run("task", specialist, undefined, undefined, undefined, undefined, undefined, undefined, budget);
	return { ref, captured, resolvePrompt: () => resolvePrompt(), resultPromise };
}

const toolStart = (toolName: string, id: string, args: any = {}) => ({ type: "tool_execution_start", toolName, toolCallId: id, args });
const toolEnd = (toolName: string, id: string) => ({ type: "tool_execution_end", toolName, toolCallId: id, result: "ok", isError: false });
const textDelta = (text: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
const assistantEnd = (stopReason: string, text: string) => ({
	type: "message_end",
	message: { role: "assistant", stopReason, content: [{ type: "text", text }], usage: { input: 10, output: 5, totalTokens: 15 } },
});

describe("PART A — runner forces recommend=investigate on a counted budget breach", () => {
	it("(a) exploration-count breach with a CLEAN difficulty → banner shown, recommend NOT rewritten", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("budget-over");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		// Same path each time so ONLY the exploration count crosses (files stays 1), and
		// stay under 2× the cap so this is a plain (non-gross) substantive breach.
		for (let i = 0; i < ESCALATION_MAX_EXPLORATION_CALLS + 1; i++) {
			ref.subscribeCb!(toolStart("read", `r${i}`, { path: `/tmp/one-file.ts` }));
			ref.subscribeCb!(toolEnd("read", `r${i}`));
		}

		const report = `## Findings\n- summary: explored a lot then answered\n\n## Difficulty\n- exploration: low\n- uncertainty: low\n- verification: pass\n- iteration: low\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(report));
		ref.subscribeCb!(assistantEnd("end_turn", report));

		resolvePrompt();
		const result = await resultPromise;

		// Code-detected breach flag still latches.
		expect(result.budgetExceeded).toBe(true);
		expect(result.budgetBreachKind).toBe("substantive");
		expect(result.budgetReason).toContain("exploration calls");

		// The observation banner MUST still surface to the orchestrator...
		expect(result.output).toContain("⚠ [Budget Gate]");
		expect(result.output).toContain("budget breach");

		// ...but a read-heavy run with a CLEAN, uncorroborated difficulty keeps its own
		// `recommend` — the gate no longer rewrites it (no false positive).
		const d = extractDifficultyFromOutput(result.output);
		expect(d).not.toBeNull();
		expect(d!.recommend).toBe("none");
		expect(result.output).not.toContain("forcing recommend=investigate");

		// So the orchestrator-facing line does NOT carry a forced investigate.
		const r = formatResult({
			output: result.output,
			metrics: result.metrics as any,
			elapsed: 1, turns: result.turns, toolCalls: 7, status: "ok",
		});
		expect(r.formatted).not.toContain("recommend=investigate");
	});

	it("(a-gross) a GROSS exploration breach (2× the limit) with a CLEAN difficulty is exempted — the gross breach is still reported, the worker's recommend stands", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("budget-gross");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		// 2× the exploration cap IS a gross breach, but a clean difficulty
		// (verification=pass + uncertainty=low) means the worker's own recommend
		// stands — the gate must NOT force.
		for (let i = 0; i < ESCALATION_MAX_EXPLORATION_CALLS * 2; i++) {
			ref.subscribeCb!(toolStart("read", `g${i}`, { path: `/tmp/one-file.ts` }));
			ref.subscribeCb!(toolEnd("read", `g${i}`));
		}

		const report = `## Findings\n- summary: blew the budget\n\n## Difficulty\n- exploration: low\n- uncertainty: low\n- verification: pass\n- iteration: low\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(report));
		ref.subscribeCb!(assistantEnd("end_turn", report));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBe(true);
		expect(result.budgetBreachKind).toBe("substantive");
		expect(result.output).toContain("⚠ [Budget Gate]");
		expect(result.output).toContain("gross breach");
		expect(result.output).not.toContain("forcing recommend=investigate");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("none");
	});

	it("(b) under-budget run keeps the model's own difficulty signal unchanged", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("budget-under");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		for (let i = 0; i < 2; i++) {
			ref.subscribeCb!(toolStart("read", `r${i}`, { path: `/tmp/g${i}.ts` }));
			ref.subscribeCb!(toolEnd("read", `r${i}`));
		}

		const report = `## Findings\n- summary: small targeted change\n\n## Difficulty\n- exploration: low\n- uncertainty: low\n- verification: pass\n- iteration: low\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(report));
		ref.subscribeCb!(assistantEnd("end_turn", report));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBeUndefined();
		expect(result.output).not.toContain("recommend: investigate");
		const d = extractDifficultyFromOutput(result.output)!;
		expect(d.recommend).toBe("none");
	});
});

// ── PART B: ask-resolver surfaces worker escalation ─────────────────────────
describe("detectEscalationSignal (pure)", () => {
	it("detects explicit `recommend: investigate|plan|review`", () => {
		expect(detectEscalationSignal("please recommend: investigate now")).toBe("investigate");
		expect(detectEscalationSignal("recommend=plan")).toBe("plan");
		expect(detectEscalationSignal("RECOMMEND: review")).toBe("review");
	});
	it("detects imperative 'Requesting investigation' phrasing", () => {
		expect(detectEscalationSignal("I've hit my budget. Requesting investigation.")).toBe("investigate");
		expect(detectEscalationSignal("Requesting a scout")).toBe("investigate");
	});
	it("returns null for an ordinary clarification question (no false positive)", () => {
		expect(detectEscalationSignal("What is the deploy process?")).toBeNull();
		expect(detectEscalationSignal("")).toBeNull();
	});
});

describe("PART B — createAskOrchestratorResolver surfaces escalation", () => {
	it("(c) a recommend:investigate escalation is surfaced AND tagged in the buffer (not silently buffered)", async () => {
		const buffer: string[] = [];
		const resolver = createAskOrchestratorResolver({ cwd: "/tmp", sessionManager: { getEntries: () => [] } }, buffer);

		const answer = await resolver(
			"I've hit my exploration budget (6 calls, 5 files, 12 turns) without converging. Requesting investigation.",
			"recommend: investigate",
		);

		expect(answer).toContain("WORKER ESCALATION");
		expect(answer).toContain("recommend: investigate");
		expect(answer).toMatch(/escalate the ladder/i);
		expect(buffer).toHaveLength(1);
		expect(buffer[0]).toContain("[escalation: recommend=investigate]");
	});

	it("an ordinary question keeps the exact neutral fallback and raw buffer entry (no regression)", async () => {
		const buffer: string[] = [];
		const resolver = createAskOrchestratorResolver({ cwd: "/tmp", sessionManager: { getEntries: () => [] } }, buffer);

		const answer = await resolver("What is the meaning of life?");
		expect(answer).toBe(UNANSWERED_SENTINEL);
		expect(buffer).toEqual(["What is the meaning of life?"]);
	});
});

// ── ITEM 4: delegate()-time budget override + clean-completion semantics ────
describe("resolveDelegationBudget (ITEM 4) — profile scales caps, numeric override wins", () => {
	it("omitted budget resolves to the current defaults exactly", () => {
		expect(resolveDelegationBudget(undefined, "coder")).toEqual({
			maxExplorationCalls: ESCALATION_MAX_EXPLORATION_CALLS,
			maxFiles: ESCALATION_MAX_FILES_TOUCHED,
			maxTurns: ESCALATION_MAX_TURNS,
		});
		expect(resolveDelegationBudget({ profile: "standard" }, "scout")).toEqual({
			maxExplorationCalls: 10,
			maxFiles: 12, // scout's own files cap, NOT the generic 5
			maxTurns: 12,
		});
	});

	it("audit profile scales every cap 3× (exploration 30; scout/researcher files 36; turns 36)", () => {
		expect(resolveDelegationBudget({ profile: "audit" }, "scout")).toEqual({
			maxExplorationCalls: 30,
			maxFiles: 36,
			maxTurns: 36,
		});
		expect(resolveDelegationBudget({ profile: "audit" }, "researcher")).toEqual({
			maxExplorationCalls: 30,
			maxFiles: 36,
			maxTurns: 36,
		});
		// Non-read-heavy specialists scale their own (default) 5-file cap.
		expect(resolveDelegationBudget({ profile: "audit" }, "coder").maxFiles).toBe(15);
	});

	it("explicit numeric overrides win over the profile (per axis)", () => {
		const resolved = resolveDelegationBudget({ profile: "audit", maxTurns: 99, maxExplorationCalls: 7 }, "scout");
		expect(resolved.maxExplorationCalls).toBe(7);
		expect(resolved.maxTurns).toBe(99);
		expect(resolved.maxFiles).toBe(36); // untouched axis still scales
		expect(resolveDelegationBudget({ maxFiles: 3 }, "coder")).toEqual({ maxExplorationCalls: 10, maxFiles: 3, maxTurns: 12 });
	});

	it("computeBudgetStatus honours the scaled audit caps", () => {
		const auditCaps = resolveDelegationBudget({ profile: "audit" }, "scout");
		// 20 exploration calls: over the default 10, under the audit 30.
		expect(computeBudgetStatus({ read: 20 }, 1, 1).exceeded).toBe(true);
		expect(computeBudgetStatus({ read: 20 }, 1, 1, auditCaps.maxFiles, auditCaps).exceeded).toBe(false);
		// 31 > 30 → breached with the SCALED number in the reason.
		const over = computeBudgetStatus({ read: 31 }, 1, 1, auditCaps.maxFiles, auditCaps);
		expect(over.exceeded).toBe(true);
		expect(over.reason).toContain("exploration calls 31 > 30");
	});
});

describe("ITEM 4 — clean complete + breach reports informationally; non-clean still forces", () => {
	it("(c) clean complete stop + corroborating breach → recommend NOT forced, note shows the numbers", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("clean-complete-break");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		// 11 exploration calls (substantive, non-gross) with recommend=investigate in the
		// report — without the clean-completion carve-out this WOULD be forced.
		for (let i = 0; i < ESCALATION_MAX_EXPLORATION_CALLS + 1; i++) {
			ref.subscribeCb!(toolStart("read", `c${i}`, { path: "/tmp/one-file.ts" }));
			ref.subscribeCb!(toolEnd("read", `c${i}`));
		}
		const report = `## Findings\n- summary: broad audit delivered\n\n## Difficulty\n- exploration: high\n- uncertainty: medium\n- verification: pass\n- iteration: medium\n- recommend: investigate\n`;
		ref.subscribeCb!(textDelta(report));
		// Clean stop: "stop" + deliverable markers + all steps complete → cleanCompleteStop.
		ref.subscribeCb!(assistantEnd("stop", report));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBe(true);
		expect(result.budgetBreachKind).toBe("substantive");
		// Banner keeps the breach numbers visible, labelled informational.
		expect(result.output).toContain("⚠ [Budget Gate]");
		expect(result.output).toContain(`exploration calls ${ESCALATION_MAX_EXPLORATION_CALLS + 1} > ${ESCALATION_MAX_EXPLORATION_CALLS}`);
		expect(result.output).toContain("informational: run completed; budget note only");
		// NOT forced on a cleanly-completed run.
		expect(result.output).not.toContain("forcing recommend=investigate");
		expect(result.calibration?.budgetGate?.forced).toBe(false);
	});

	it("(c) the structured clean-completion note is emitted through onUpdate even before formatting", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("clean-complete-note");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		for (let i = 0; i < ESCALATION_MAX_EXPLORATION_CALLS + 1; i++) {
			ref.subscribeCb!(toolStart("read", `n${i}`, { path: "/tmp/one-file.ts" }));
			ref.subscribeCb!(toolEnd("read", `n${i}`));
		}
		const report = `## Findings\n- summary: done\n\n## Difficulty\n- exploration: medium\n- uncertainty: low\n- verification: pass\n- iteration: low\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(report));
		ref.subscribeCb!(assistantEnd("stop", report));
		resolvePrompt();
		const result = await resultPromise;

		// Breach numbers remain visible and the difficulty stays the worker's own.
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("none");
		expect(result.output).toContain("budget breach");
	});

	it("(d) NON-clean completion with a corroborating breach still forces recommend=investigate", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("nonclean-break");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		for (let i = 0; i < ESCALATION_MAX_EXPLORATION_CALLS + 1; i++) {
			ref.subscribeCb!(toolStart("read", `u${i}`, { path: "/tmp/one-file.ts" }));
			ref.subscribeCb!(toolEnd("read", `u${i}`));
		}
		const report = `## Findings\n- summary: explored and stopped\n\n## Difficulty\n- exploration: high\n- uncertainty: high\n- verification: fail\n- iteration: medium\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(report));
		// Non-clean: end_turn (not a declared clean stop).
		ref.subscribeCb!(assistantEnd("end_turn", report));
		resolvePrompt();
		const result = await resultPromise;

		expect(result.output).toContain("forcing recommend=investigate");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("investigate");
		expect(result.calibration?.budgetGate?.forced).toBe(true);
	});

	it("(a/e2e) audit profile threads into the gate: 20 calls breach default but not audit", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("audit-e2e", { profile: "audit" });
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		for (let i = 0; i < 20; i++) {
			ref.subscribeCb!(toolStart("read", `a${i}`, { path: "/tmp/one-file.ts" }));
			ref.subscribeCb!(toolEnd("read", `a${i}`));
		}
		const report = `## Findings\n- summary: broad audit\n\n## Difficulty\n- exploration: high\n- uncertainty: low\n- verification: pass\n- iteration: medium\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(report));
		ref.subscribeCb!(assistantEnd("end_turn", report));
		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBeUndefined();
		expect(result.output).not.toContain("[Budget Gate]");
	});

	// DEFECT 2 live-probe mirror: delegation-2026-10-17T17-45-01-631Z-scout.json —
	// explicit budget {exploration 2}, scout completed cleanly (stopReason "stop",
	// status "completed") but the final plan step was auto-completed at teardown and
	// the delivered banner was "forcing recommend=investigate" over ANNOTATED
	// difficulty values. Both defects fired together; this test pins the suppression
	// against BOTH the teardown ordering and the annotated prose.
	it("(probe mirror) gross breach on a clean stop whose final plan step auto-closes at teardown → informational banner, recommend NOT rewritten", { timeout: 20_000 }, async () => {
		const { ref, captured, resolvePrompt, resultPromise } = createRunner("probe-mirror", { maxExplorationCalls: 2, maxTurns: 20 });
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });
		await vi.waitFor(() => expect(captured.sessionOptions).not.toBeNull(), { timeout: 10_000 });
		const byName = (n: string) => (captured.sessionOptions.customTools as any[]).find(t => t.name === n);

		// 3-step plan; the worker advances steps 1-2, does step 3's work and reports —
		// but never calls advanceStep for the last step (teardown auto-closes it).
		await byName("planSteps").execute("p1", { goal: "g", steps: ["one", "two", "three"] });
		await byName("advanceStep").execute("a1", {});
		await byName("advanceStep").execute("a2", {});

		// 8 exploration calls on ONE path → 8 > 2 and 8 ≥ 2×2: substantive AND gross.
		for (let i = 0; i < 8; i++) {
			ref.subscribeCb!(toolStart("read", `p${i}`, { path: "/tmp/one-file.ts" }));
			ref.subscribeCb!(toolEnd("read", `p${i}`));
		}

		// The probe's ANNOTATED difficulty prose — the shape that defeated the strict
		// equality checks in shouldForceRecommend.
		const report = [
			"## Completed",
			"Delivered the audit.",
			"",
			"## Findings",
			"- summary: done",
			"",
			"## Difficulty",
			"- exploration: low — trivial",
			"- uncertainty: low — task fully specified",
			"- verification: pass — each count asserted",
			"- iteration: low — one pass",
			"- recommend: none — task complete",
		].join("\n");
		ref.subscribeCb!(textDelta(report));
		ref.subscribeCb!(assistantEnd("stop", report));
		resolvePrompt();
		const result = await resultPromise;

		expect(result.stopReason).toBe("stop");
		expect(result.status).toBe("completed");
		expect(result.budgetExceeded).toBe(true);
		expect(result.budgetBreachKind).toBe("substantive");
		// The ordering that made the mid-run stepsIncomplete snapshot stale: the final
		// plan step's completion (autoCompleted) is a teardown artifact.
		const planSteps: any[] = result.planSteps ?? [];
		const finalStep = planSteps[planSteps.length - 1];
		expect(finalStep).toMatchObject({ completed: true, autoCompleted: true });
		expect(planSteps.filter((s: any) => s.autoCompleted)).toHaveLength(1);

		// Informational banner; the worker's own (annotated) recommend is NOT rewritten.
		expect(result.output).toContain("informational: run completed; budget note only");
		expect(result.output).toContain("gross breach");
		expect(result.output).not.toContain("forcing recommend=investigate");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("none — task complete");
		expect(result.calibration?.budgetGate?.forced).toBe(false);
	});
});

// ── ITEM 5: completed-run escalation-signal downgrade ───────────────────────
describe("ITEM 5 — recommend=investigate on a completed run is downgraded to informational", () => {
	const difficultyOut = (verification: string) =>
		`## Findings\n- summary: done\n\n## Difficulty\n- exploration: low\n- uncertainty: low\n- verification: ${verification}\n- iteration: low\n- recommend: investigate\n`;
	const metrics = { readCalls: 1, grepCalls: 0, findCalls: 0, editCalls: 0, writeCalls: 0, bashCalls: 0, lsCalls: 0 } as any;

	it("formatDifficultySignal downgrades when the run completed successfully AND verification=pass", () => {
		const d = extractDifficultyFromOutput(difficultyOut("pass"))!;
		const line = formatDifficultySignal(d, { completedSuccessfully: true });
		expect(line).toContain("recommend: none (run completed successfully; raw signal was investigate — informational)");
		// Raw signal stays visible for the reader.
		expect(line).toContain("raw signal was investigate");
		expect(line).not.toContain("recommend=investigate");
	});

	it("keeps the raw signal when the run is incomplete or verification failed", () => {
		const passD = extractDifficultyFromOutput(difficultyOut("pass"))!;
		const failD = extractDifficultyFromOutput(difficultyOut("fail"))!;
		// Not a completed run → untouched.
		expect(formatDifficultySignal(passD)).toContain("recommend=investigate");
		expect(formatDifficultySignal(passD, { completedSuccessfully: false })).toContain("recommend=investigate");
		// Completed but verification=fail → the signal stays actionable.
		expect(formatDifficultySignal(failD, { completedSuccessfully: true })).toContain("recommend=investigate");
	});

	it("formatResult downgrade is opt-in (completedSuccessfully) and never touches gate-forced signals", () => {
		const output = difficultyOut("pass");
		const base = { output, metrics, elapsed: 1, turns: 1, toolCalls: 1, status: "ok" as const };
		// Default (legacy callers): unchanged.
		expect(formatResult(base).formatted).toContain("recommend=investigate");
		// Completed successful run: downgraded.
		const done = formatResult({ ...base, completedSuccessfully: true });
		expect(done.formatted).toContain("recommend: none (run completed successfully");
		expect(done.formatted).not.toContain("recommend=investigate");
		// Gate-forced investigate is the gate's own verdict — never downgraded.
		const forced = formatResult({ ...base, completedSuccessfully: true, budgetGateForced: true });
		expect(forced.formatted).toContain("recommend=investigate");
	});

	it("shouldDowngradeRecommend is the single policy both output paths share", () => {
		const passD = extractDifficultyFromOutput(difficultyOut("pass"))!;
		const failD = extractDifficultyFromOutput(difficultyOut("fail"))!;
		// Downgrade only on: completed + verification=pass + recommend=investigate.
		expect(shouldDowngradeRecommend(passD, { completedSuccessfully: true })).toBe(true);
		expect(shouldDowngradeRecommend(passD, { completedSuccessfully: true, budgetGateForced: false })).toBe(true);
		// Gate-forced signal is preserved on EVERY path.
		expect(shouldDowngradeRecommend(passD, { completedSuccessfully: true, budgetGateForced: true })).toBe(false);
		// Incomplete run / failed verification / missing signal → untouched.
		expect(shouldDowngradeRecommend(passD, { completedSuccessfully: false })).toBe(false);
		expect(shouldDowngradeRecommend(passD)).toBe(false);
		expect(shouldDowngradeRecommend(failD, { completedSuccessfully: true })).toBe(false);
		expect(shouldDowngradeRecommend(null, { completedSuccessfully: true })).toBe(false);

		// DEFECT 1 (live probe): ANNOTATED values must still downgrade, and gate-forced
		// is still never downgraded — real workers write annotated prose constantly.
		const annotated = extractDifficultyFromOutput(
			`## Findings\n- summary: done\n\n## Difficulty\n- exploration: high — three modules\n- uncertainty: low — fully specified\n- verification: pass — verified end-to-end\n- iteration: low — one pass\n- recommend: investigate — spawn scout\n`,
		)!;
		// Display keeps the RAW value (rendered text is untouched by the normalizer).
		expect(annotated.recommend).toBe("investigate — spawn scout");
		expect(annotated.verification).toBe("pass — verified end-to-end");
		// Decision compares the normalized enum token.
		expect(shouldDowngradeRecommend(annotated, { completedSuccessfully: true })).toBe(true);
		expect(shouldDowngradeRecommend(annotated, { completedSuccessfully: true, budgetGateForced: false })).toBe(true);
		expect(shouldDowngradeRecommend(annotated, { completedSuccessfully: true, budgetGateForced: true })).toBe(false);
		expect(formatDifficultySignal(annotated, { completedSuccessfully: true })).toContain("recommend: none (run completed successfully");
		// Annotated verification=fail stays actionable (never downgraded).
		const annotatedFail = extractDifficultyFromOutput(
			`## Difficulty\n- verification: fail — tests red\n- recommend: investigate — spawn scout\n`,
		)!;
		expect(shouldDowngradeRecommend(annotatedFail, { completedSuccessfully: true })).toBe(false);

		// The renderer applies that same policy, so both call sites pass raw flags.
		expect(formatDifficultySignal(passD, { completedSuccessfully: true, budgetGateForced: false }))
			.toContain("recommend: none (run completed successfully");
		expect(formatDifficultySignal(passD, { completedSuccessfully: true, budgetGateForced: true }))
			.toContain("recommend=investigate");

		// Path parity: the live path's call shape and the test path's produced line must match.
		const livePathLine = formatDifficultySignal(passD, { completedSuccessfully: true, budgetGateForced: false });
		const viaFormatResult = formatResult({
			output: difficultyOut("pass"), metrics, elapsed: 1, turns: 1, toolCalls: 1, status: "ok" as const,
			completedSuccessfully: true, budgetGateForced: false,
		}).formatted;
		expect(viaFormatResult).toContain(livePathLine);
	});
});

// ── ITEM 4: per-entry budgets on batch delegations ──────────────────────────
describe("batch entry budget (ITEM 4) — an entry's budget threads into that entry's delegation", () => {
	it("entry { profile: 'audit' } gets 3× caps; an entry without budget keeps the defaults", async () => {
		const pipeline = new DelegatePipeline({ scopeManager: {} as any });
		const seen: Array<{ specialist: string; budget?: DelegationBudget }> = [];
		// Spy on the shared per-entry run() so the assertion is about the plumbing
		// (runBatch → run), not about subagent execution.
		const runSpy = vi.spyOn(DelegatePipeline.prototype, "run").mockImplementation(async (params: any) => {
			seen.push({ specialist: params.specialist, budget: params.budget });
			return { content: [{ type: "text", text: "ok" }], details: {} } as any;
		});
		try {
			await pipeline.runBatch(
				[
					{ specialist: "scout", task: "broad audit", budget: { profile: "audit" } },
					{ specialist: "scout", task: "narrow look" },
				],
				{ cwd: "/tmp", config: { delegation: { parallel: { maxConcurrent: 2 } } } } as any,
				() => {},
			);
		} finally {
			runSpy.mockRestore();
		}

		// Every entry reaches its own run() call, carrying its own budget.
		expect(seen.map(s => s.specialist)).toEqual(["scout", "scout"]);
		expect(seen[0].budget).toEqual({ profile: "audit" });
		expect(seen[1].budget).toBeUndefined();

		// audit → 3× every cap (scout: exploration 10→30, files 12→36, turns 12→36).
		const defaults = resolveDelegationBudget(undefined, "scout");
		const audit = resolveDelegationBudget(seen[0].budget, "scout");
		expect(audit).toEqual({ maxExplorationCalls: 30, maxFiles: 36, maxTurns: 36 });
		expect(audit.maxExplorationCalls).toBe(3 * defaults.maxExplorationCalls);
		expect(audit.maxFiles).toBe(3 * defaults.maxFiles);
		expect(audit.maxTurns).toBe(3 * defaults.maxTurns);

		// Omission keeps the defaults exactly.
		expect(resolveDelegationBudget(seen[1].budget, "scout")).toEqual(defaults);
		expect(resolveDelegationBudget(seen[1].budget, "scout").maxExplorationCalls).toBe(ESCALATION_MAX_EXPLORATION_CALLS);
		expect(resolveDelegationBudget(seen[1].budget, "scout").maxTurns).toBe(ESCALATION_MAX_TURNS);
	});
});
