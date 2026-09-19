/**
 * budget-gate-reporting.test.ts
 *
 * Regression tests for the budget-gate reporting/calibration/no-op frictions:
 *   FIX 3(a) — the escalation banner names the axis/axes that ACTUALLY caused a
 *              forced escalation (the gross one), not a non-gross axis that latched first.
 *   FIX 3(b) — raised defaults (exploration 10, files 12, turns 20) and `find`/`ls`
 *              excluded from the exploration cap (they are orientation calls).
 *   FIX 3(c) — a turns-only breach (which forces nothing) prints NO banner.
 */
import { describe, it, expect, vi } from "vitest";
import {
	SubagentRunner,
	computeBudgetStatus,
	buildBudgetGateBanner,
	grossBreachAxisLabels,
	shouldShowBudgetBanner,
	shouldForceRecommend,
	isGrossBreach,
	EXPLORATION_TOOLS,
} from "./subagent-runner.ts";
import { extractDifficultyFromOutput } from "./delegate-pipeline.ts";
import {
	ESCALATION_MAX_EXPLORATION_CALLS,
	ESCALATION_MAX_FILES_TOUCHED,
	ESCALATION_MAX_TURNS,
} from "./specialists.ts";

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

// ── FIX 3(b): raised defaults + find/ls excluded from the exploration cap ────
describe("FIX 3(b) — budget calibration", () => {
	it("defaults are exploration=10, files=12, turns=20", () => {
		expect(ESCALATION_MAX_EXPLORATION_CALLS).toBe(10);
		expect(ESCALATION_MAX_FILES_TOUCHED).toBe(12);
		expect(ESCALATION_MAX_TURNS).toBe(20);
	});

	it("EXPLORATION_TOOLS is read+grep only (find/ls are orientation)", () => {
		expect([...EXPLORATION_TOOLS]).toEqual(["read", "grep"]);
	});

	it("find/ls counts do NOT contribute to the exploration total", () => {
		const s = computeBudgetStatus({ read: 3, grep: 1, find: 30, ls: 30 }, 0, 0);
		expect(s.explorationCalls).toBe(4);
		expect(s.exceeded).toBe(false);
	});

	it("3 orientation files (dir + git copy + assets) no longer breach the file cap", () => {
		const s = computeBudgetStatus({ read: 3 }, 3, 3);
		expect(s.exceeded).toBe(false);
	});
});

// ── FIX 3(a): the banner reports the gross forcing axis, not a latched one ──
describe("FIX 3(a) — banner reports the actual forcing axis", () => {
	it("gross exploration breach names exploration as the trigger and not files", () => {
		// explorationCalls 48 (gross), files 6 (< 12, not even breached), turns 13 (< 20).
		const status = computeBudgetStatus({ read: 48 }, 6, 13);
		expect(status.explorationCalls).toBe(48);
		expect(status.distinctFiles).toBe(6);
		expect(status.turns).toBe(13);
		expect(isGrossBreach(status)).toBe(true);

		const banner = buildBudgetGateBanner(status, { force: true, grossBreach: true });
		expect(banner).toContain("forcing recommend=investigate");
		expect(banner).toContain("gross breach");
		expect(banner).toContain("exploration calls 48");
		// files is neither breached nor named as the trigger.
		expect(banner).not.toContain("distinct files");
		expect(grossBreachAxisLabels(status)).toEqual(["exploration calls 48 ≥ 2× cap 10"]);
	});

	it("when exploration is gross and files is breached-but-not-gross, files is listed but not as the trigger", () => {
		// exploration 48 (gross), files 13 (breached, but < 24 so not gross).
		const status = computeBudgetStatus({ read: 48 }, 13, 1);
		const grossAxes = grossBreachAxisLabels(status);
		expect(grossAxes).toEqual(["exploration calls 48 ≥ 2× cap 10"]);
		expect(grossAxes.some(a => a.includes("distinct files"))).toBe(false);

		const banner = buildBudgetGateBanner(status, { force: true, grossBreach: true });
		// All breached axes are listed...
		expect(banner).toContain("exploration calls 48");
		expect(banner).toContain("distinct files 13");
		// ...but the gross (forcing) note names only exploration.
		const grossNote = banner.slice(banner.indexOf("gross breach"));
		expect(grossNote).toContain("exploration calls 48");
		expect(grossNote).not.toContain("distinct files");
	});

	it("a non-forced breach shows the observed banner without a forcing clause", () => {
		const status = computeBudgetStatus({ read: 41 }, 1, 1); // substantive but < 2×? 41 >= 20 -> gross
		// Force a non-gross, non-forced case explicitly:
		const nonGross = computeBudgetStatus({ read: 11 }, 1, 1); // 11 > 10, < 20
		expect(isGrossBreach(nonGross)).toBe(false);
		const banner = buildBudgetGateBanner(nonGross, { force: false, grossBreach: false });
		expect(banner).toContain("observed; recommend left unchanged");
		expect(banner).not.toContain("forcing recommend=investigate");
		// sanity: 41 IS gross
		expect(isGrossBreach(status)).toBe(true);
	});
});

// ── FIX 3(c): suppress the turns-only banner ────────────────────────────────
describe("FIX 3(c) — turns-only breaches do not print an escalation banner", () => {
	it("shouldShowBudgetBanner is false for turns-only, true otherwise", () => {
		expect(shouldShowBudgetBanner("turns-only")).toBe(false);
		expect(shouldShowBudgetBanner("substantive")).toBe(true);
		expect(shouldShowBudgetBanner("none")).toBe(true);
	});

	it("shouldForceRecommend does not force a clean turns-only breach", () => {
		expect(shouldForceRecommend("turns-only", { verification: "pass", uncertainty: "low" })).toBe(false);
	});
});

// ── End-to-end runner behaviour ─────────────────────────────────────────────
type SubscribeCb = (event: any) => void;

function createRunner(specialistName = "budget-specialist") {
	const ref = { subscribeCb: null as SubscribeCb | null };
	let resolvePrompt: () => void = () => {};
	let rejectPrompt: (e: Error) => void = () => {};
	let promptCalls = 0;
	const mockSession = {
		sessionId: `test-${specialistName}`,
		messages: [] as any[],
		subscribe: vi.fn((cb: SubscribeCb) => { ref.subscribeCb = cb; return () => {}; }),
		abort: vi.fn(() => rejectPrompt(new Error("AbortError"))),
		prompt: vi.fn((_msg?: string) => {
			promptCalls++;
			if (promptCalls === 1) {
				return new Promise<void>((res, rej) => { resolvePrompt = res; rejectPrompt = rej; });
			}
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
	return { ref, resolvePrompt: () => resolvePrompt(), resultPromise, mockSession };
}

const toolStart = (toolName: string, id: string, args: any = {}) => ({ type: "tool_execution_start", toolName, toolCallId: id, args });
const toolEnd = (toolName: string, id: string) => ({ type: "tool_execution_end", toolName, toolCallId: id, result: "ok", isError: false });
const textDelta = (text: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
const assistantEnd = (stopReason: string, text: string) => ({
	type: "message_end",
	message: { role: "assistant", stopReason, content: [{ type: "text", text }], usage: { input: 10, output: 5, totalTokens: 15 } },
});

describe("budget gate end-to-end", () => {
	it("turns-only breach prints NO escalation banner and leaves recommend unchanged", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("report-turns-clean");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		const text = `## Findings\n- summary: done\n\n## Difficulty\n- exploration: medium\n- uncertainty: low\n- verification: pass\n- iteration: high\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(text));
		for (let i = 0; i < ESCALATION_MAX_TURNS + 1; i++) ref.subscribeCb!(assistantEnd("end_turn", text));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBe(true);
		expect(result.budgetBreachKind).toBe("turns-only");
		// FIX 3(c): no banner noise from a no-op breach.
		expect(result.output).not.toContain("[Budget Gate]");
		expect(result.output).not.toContain("forcing recommend=investigate");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("none");
	});

	it("a gross exploration breach still forces recommend=investigate with a forcing banner", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("report-gross");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		// 2× the exploration cap, same path so files stays 1.
		for (let i = 0; i < ESCALATION_MAX_EXPLORATION_CALLS * 2; i++) {
			ref.subscribeCb!(toolStart("read", `g${i}`, { path: `/tmp/one-file.ts` }));
			ref.subscribeCb!(toolEnd("read", `g${i}`));
		}

		const text = `## Findings\n- summary: blew the budget\n\n## Difficulty\n- exploration: low\n- uncertainty: low\n- verification: pass\n- iteration: low\n- recommend: none\n`;
		ref.subscribeCb!(textDelta(text));
		ref.subscribeCb!(assistantEnd("end_turn", text));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBe(true);
		expect(result.output).toContain("[Budget Gate]");
		expect(result.output).toContain("forcing recommend=investigate");
		expect(result.output).toContain("gross breach");
		expect(result.output).toContain("exploration calls");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("investigate");
	});
});
