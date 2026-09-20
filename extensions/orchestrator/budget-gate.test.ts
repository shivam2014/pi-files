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
import { extractDifficultyFromOutput, formatResult } from "./delegate-pipeline.ts";
import { createAskOrchestratorResolver, detectEscalationSignal, UNANSWERED_SENTINEL } from "./ask-resolver.ts";
import {
	ESCALATION_MAX_EXPLORATION_CALLS,
	ESCALATION_MAX_FILES_TOUCHED,
	ESCALATION_MAX_TURNS,
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
		expect(s.breachKind).toBe("substantive");
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

function createRunner(specialistName = "budget-specialist") {
	const ref = { subscribeCb: null as SubscribeCb | null };
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
		agentSessionFactory: async () => ({ session: mockSession }),
	} as any);
	const specialist = { name: specialistName, tools: ["read", "grep", "find", "ls", "bash", "edit"], systemPrompt: "p" } as any;
	const resultPromise = runner.run("task", specialist);
	return { ref, resolvePrompt: () => resolvePrompt(), resultPromise };
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

	it("(a-gross) a GROSS exploration breach (2× the limit) forces even with a clean difficulty", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("budget-gross");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		// 2× the exploration cap is a gross breach — it forces regardless of self-report.
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
		expect(result.output).toContain("forcing recommend=investigate");
		expect(result.output).toContain("gross breach");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("investigate");
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
