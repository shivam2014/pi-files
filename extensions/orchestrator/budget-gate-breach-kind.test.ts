/**
 * budget-gate-breach-kind.test.ts
 *
 * Verifies the budget-gate FORCING RULE is breach-kind aware:
 *   - SUBSTANTIVE breach (exploration calls OR distinct files over budget) forces
 *     ONLY when the FINAL `## Difficulty` CORROBORATES confusion (verification=fail,
 *     uncertainty=high, or recommend=investigate). A read-heavy but clean run keeps
 *     the model's own recommend.
 *   - GROSS breach (≥2× any counted limit) ALWAYS forces, regardless of report.
 *   - TURNS-ONLY breach forces ONLY when the worker's FINAL `## Difficulty`
 *     admits difficulty (verification=fail OR uncertainty=high). A clean
 *     turns-only run keeps the model's own recommend.
 *   - The wrap-up NUDGE still fires on a turns breach (decoupled from forcing).
 */
import { describe, it, expect, vi } from "vitest";
import {
	SubagentRunner,
	computeBudgetStatus,
	shouldForceRecommend,
	isGrossBreach,
	BUDGET_WRAPUP_MESSAGE,
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

// ── Pure forcing rule ───────────────────────────────────────────────────────
describe("shouldForceRecommend (breach-kind forcing rule)", () => {
	const clean = { verification: "pass", uncertainty: "low" };

	it("substantive breach with a CLEAN difficulty does NOT force (corroboration required)", () => {
		expect(shouldForceRecommend("substantive", clean)).toBe(false);
		expect(shouldForceRecommend("substantive", { verification: "pass", uncertainty: "medium" })).toBe(false);
		expect(shouldForceRecommend("substantive", null)).toBe(false);
	});

	it("substantive breach forces when the difficulty CORROBORATES confusion", () => {
		expect(shouldForceRecommend("substantive", { verification: "fail", uncertainty: "low" })).toBe(true);
		expect(shouldForceRecommend("substantive", { verification: "pass", uncertainty: "high" })).toBe(true);
		expect(shouldForceRecommend("substantive", { verification: "pass", uncertainty: "low", recommend: "investigate" })).toBe(true);
	});

	it("a GROSS breach forces regardless of a clean difficulty", () => {
		expect(shouldForceRecommend("substantive", clean, true)).toBe(true);
		expect(shouldForceRecommend("turns-only", clean, true)).toBe(true);
		expect(shouldForceRecommend("none", clean, true)).toBe(false);
	});

	it("turns-only breach with verification=fail forces", () => {
		expect(shouldForceRecommend("turns-only", { verification: "fail", uncertainty: "low" })).toBe(true);
	});

	it("turns-only breach with uncertainty=high forces", () => {
		expect(shouldForceRecommend("turns-only", { verification: "pass", uncertainty: "high" })).toBe(true);
	});

	it("turns-only breach with verification=pass + uncertainty=low/medium does NOT force", () => {
		expect(shouldForceRecommend("turns-only", { verification: "pass", uncertainty: "low" })).toBe(false);
		expect(shouldForceRecommend("turns-only", { verification: "pass", uncertainty: "medium" })).toBe(false);
	});

	it("turns-only breach with missing difficulty does NOT force", () => {
		expect(shouldForceRecommend("turns-only", null)).toBe(false);
		expect(shouldForceRecommend("turns-only", undefined)).toBe(false);
		expect(shouldForceRecommend("turns-only", {})).toBe(false);
	});

	it("no breach never forces", () => {
		expect(shouldForceRecommend("none", { verification: "fail", uncertainty: "high" })).toBe(false);
	});

	it("is case-insensitive on difficulty values", () => {
		expect(shouldForceRecommend("turns-only", { verification: "FAIL", uncertainty: "LOW" })).toBe(true);
		expect(shouldForceRecommend("turns-only", { verification: "pass", uncertainty: "High" })).toBe(true);
	});
});

// ── Gross-breach hard cap (pure) ─────────────────────────────────────────────
describe("isGrossBreach (≥2× any counted limit)", () => {
	it("flags exploration calls at 2× the limit, not 2×-1", () => {
		expect(isGrossBreach({ explorationCalls: ESCALATION_MAX_EXPLORATION_CALLS * 2, distinctFiles: 0, turns: 0 })).toBe(true);
		expect(isGrossBreach({ explorationCalls: ESCALATION_MAX_EXPLORATION_CALLS * 2 - 1, distinctFiles: 0, turns: 0 })).toBe(false);
	});
	it("flags distinct files at 2× the limit, not 2×-1", () => {
		expect(isGrossBreach({ explorationCalls: 0, distinctFiles: ESCALATION_MAX_FILES_TOUCHED * 2, turns: 0 })).toBe(true);
		expect(isGrossBreach({ explorationCalls: 0, distinctFiles: ESCALATION_MAX_FILES_TOUCHED * 2 - 1, turns: 0 })).toBe(false);
	});
	it("flags turns at 2× the limit, not 2×-1", () => {
		expect(isGrossBreach({ explorationCalls: 0, distinctFiles: 0, turns: ESCALATION_MAX_TURNS * 2 })).toBe(true);
		expect(isGrossBreach({ explorationCalls: 0, distinctFiles: 0, turns: ESCALATION_MAX_TURNS * 2 - 1 })).toBe(false);
	});
});

// ── Breach-kind classification (pure) ───────────────────────────────────────
describe("computeBudgetStatus classifies breach kind", () => {
	it("exploration over budget → substantive", () => {
		const s = computeBudgetStatus({ read: ESCALATION_MAX_EXPLORATION_CALLS + 1 }, 1, 1);
		expect(s.breachKind).toBe("substantive");
	});
	it("distinct files over budget → substantive", () => {
		const s = computeBudgetStatus({ read: ESCALATION_MAX_EXPLORATION_CALLS }, ESCALATION_MAX_FILES_TOUCHED + 1, 1);
		expect(s.breachKind).toBe("substantive");
	});
	it("turns-only over budget → turns-only", () => {
		const s = computeBudgetStatus({}, 0, ESCALATION_MAX_TURNS + 1);
		expect(s.breachKind).toBe("turns-only");
	});
	it("under budget → none", () => {
		const s = computeBudgetStatus({ read: 1 }, 1, 1);
		expect(s.breachKind).toBe("none");
	});
	it("turns + exploration over budget → still substantive (substantive wins)", () => {
		const s = computeBudgetStatus({ read: ESCALATION_MAX_EXPLORATION_CALLS + 1 }, 1, ESCALATION_MAX_TURNS + 1);
		expect(s.breachKind).toBe("substantive");
	});
});

// ── End-to-end runner behavior ──────────────────────────────────────────────
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
		prompt: vi.fn((_msg?: string) => {
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
	return { ref, resolvePrompt: () => resolvePrompt(), resultPromise, mockSession };
}

const toolStart = (toolName: string, id: string, args: any = {}) => ({ type: "tool_execution_start", toolName, toolCallId: id, args });
const toolEnd = (toolName: string, id: string) => ({ type: "tool_execution_end", toolName, toolCallId: id, result: "ok", isError: false });
const textDelta = (text: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
const assistantEnd = (stopReason: string, text: string) => ({
	type: "message_end",
	message: { role: "assistant", stopReason, content: [{ type: "text", text }], usage: { input: 10, output: 5, totalTokens: 15 } },
});

const report = (opts: { verification: string; uncertainty: string; recommend?: string }) =>
	`## Findings\n- summary: done\n\n## Difficulty\n- exploration: medium\n- uncertainty: ${opts.uncertainty}\n- verification: ${opts.verification}\n- iteration: high\n- recommend: ${opts.recommend ?? "none"}\n`;

describe("PART A — breach-kind forcing (end-to-end)", () => {
	it("(files) 6 files > 5 with a CLEAN difficulty → substantive but NOT gross → banner shown, recommend NOT rewritten", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("files-over");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		// 6 distinct paths: files = 6 (> 5, substantive) but < 10 (not gross); exploration = 6 (under 10).
		for (let i = 0; i < ESCALATION_MAX_FILES_TOUCHED + 1; i++) {
			ref.subscribeCb!(toolStart("read", `r${i}`, { path: `/tmp/file-${i}.ts` }));
			ref.subscribeCb!(toolEnd("read", `r${i}`));
		}

		const text = report({ verification: "pass", uncertainty: "low" });
		ref.subscribeCb!(textDelta(text));
		ref.subscribeCb!(assistantEnd("end_turn", text));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBe(true);
		expect(result.budgetBreachKind).toBe("substantive");
		expect(result.output).toContain("⚠ [Budget Gate]");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("none");
		expect(result.output).not.toContain("forcing recommend=investigate");
	});

	it("(turns-clean) 13 turns > 12, exploration/files under, verification=pass + uncertainty=low → NOT forced", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("turns-clean");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		const text = report({ verification: "pass", uncertainty: "low" });
		ref.subscribeCb!(textDelta(text));
		for (let i = 0; i < ESCALATION_MAX_TURNS + 1; i++) ref.subscribeCb!(assistantEnd("end_turn", text));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetExceeded).toBe(true);
		expect(result.budgetBreachKind).toBe("turns-only");
		const d = extractDifficultyFromOutput(result.output)!;
		expect(d.recommend).toBe("none");
		expect(result.output).not.toContain("forcing recommend=investigate");
	});

	it("(turns-fail) 13 turns > 12 with verification=fail → forced recommend=investigate", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("turns-fail");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		const text = report({ verification: "fail", uncertainty: "low" });
		ref.subscribeCb!(textDelta(text));
		for (let i = 0; i < ESCALATION_MAX_TURNS + 1; i++) ref.subscribeCb!(assistantEnd("end_turn", text));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetBreachKind).toBe("turns-only");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("investigate");
	});

	it("(turns-uncertain) 13 turns > 12 with uncertainty=high → forced recommend=investigate", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createRunner("turns-uncertain");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		const text = report({ verification: "pass", uncertainty: "high" });
		ref.subscribeCb!(textDelta(text));
		for (let i = 0; i < ESCALATION_MAX_TURNS + 1; i++) ref.subscribeCb!(assistantEnd("end_turn", text));

		resolvePrompt();
		const result = await resultPromise;

		expect(result.budgetBreachKind).toBe("turns-only");
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("investigate");
	});

	it("(nudge) a turns-only breach still fires the wrap-up nudge (decoupled from forcing)", { timeout: 20_000 }, async () => {
		const { ref, resolvePrompt, resultPromise, mockSession } = createRunner("turns-nudge");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });

		const text = report({ verification: "pass", uncertainty: "low" });
		ref.subscribeCb!(textDelta(text));
		for (let i = 0; i < ESCALATION_MAX_TURNS + 1; i++) ref.subscribeCb!(assistantEnd("end_turn", text));

		resolvePrompt();
		const result = await resultPromise;

		// Nudge fired even though forcing did NOT (clean turns-only breach).
		expect(mockSession.prompt).toHaveBeenCalledWith(BUDGET_WRAPUP_MESSAGE);
		expect(extractDifficultyFromOutput(result.output)!.recommend).toBe("none");
	});
});
