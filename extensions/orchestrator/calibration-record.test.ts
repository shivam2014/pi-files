/**
 * Calibration record — instrumentation round-trip + runner wiring.
 *
 * Verifies that every delegation persists ONE joinable JSON record carrying the
 * escalation data (difficulty / budget / budgetGate / outcome / progress) into
 * the existing flight-recorder dump file (same path — no join key required).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createFlightRecorderDump,
	computeBudgetStatus,
	isGrossBreach,
	shouldForceRecommend,
	SubagentRunner,
} from "./subagent-runner.ts";
import { writeCalibrationRecord, EMPTY_BUDGET_STATUS, EMPTY_BUDGET_GATE } from "./delegate-pipeline.ts";
import { DELEGATION_OUTCOME } from "./outcome.ts";
import type { CalibrationRecord } from "./types.ts";

// Same module mocks as subagent-runner.test.ts (needed for the live runner path).
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
	SYMBOLS: { "token.input": "↑", "token.output": "↓", "token.cacheRead": "⇄" },
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return { ...actual, ModelRuntime: { create: vi.fn().mockResolvedValue({}) } };
});

// ── Writer (pipeline read-modify-write) ──────────────────────────────────────

describe("calibration record — writer persists into the dump file", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	function baseDumpFile(): string {
		dir = mkdtempSync(join(tmpdir(), "calib-record-"));
		const file = join(dir, "delegation-test.json");
		const base = createFlightRecorderDump({
			specialist: "test-specialist",
			task: "do a thing",
			turns: 1,
			elapsedMs: 5,
			finalStatus: "completed",
			messages: [],
		});
		writeFileSync(file, JSON.stringify(base, null, 2));
		return file;
	}

	it("records all five field groups and preserves the base dump", () => {
		const file = baseDumpFile();
		const record: CalibrationRecord = {
			difficulty: { exploration: "low", uncertainty: "low", verification: "pass", iteration: "low", recommend: "none" },
			difficultyPresent: true,
			budget: EMPTY_BUDGET_STATUS,
			budgetGate: EMPTY_BUDGET_GATE,
			outcome: DELEGATION_OUTCOME.DONE,
			progress: { progressState: "HEALTHY", providerFailures: 0, stallTerminated: false },
		};
		writeCalibrationRecord(file, record);

		const observed = JSON.parse(readFileSync(file, "utf-8"));
		for (const key of ["difficulty", "difficultyPresent", "budget", "budgetGate", "outcome", "progress"]) {
			expect(observed).toHaveProperty(key);
		}
		// Base flight-recorder fields are NOT clobbered.
		expect(observed.specialist).toBe("test-specialist");
		// Reuses the BudgetStatus shape (not a redefinition).
		expect(observed.budget).toEqual({ exceeded: false, breachKind: "none", reason: "", explorationCalls: 0, distinctFiles: 0, turns: 0 });
	});

	it("records difficulty: null when the ## Difficulty block was absent (no throw)", () => {
		const file = baseDumpFile();
		expect(() =>
			writeCalibrationRecord(file, {
				difficulty: null,
				difficultyPresent: false,
				budget: EMPTY_BUDGET_STATUS,
				budgetGate: EMPTY_BUDGET_GATE,
				outcome: DELEGATION_OUTCOME.DONE,
				progress: {},
			}),
		).not.toThrow();

		const observed = JSON.parse(readFileSync(file, "utf-8"));
		expect(observed.difficulty).toBeNull();
		expect(observed.difficultyPresent).toBe(false);
	});

	it("records a forced budget breach as budgetGate.forced=true, finalRecommend='investigate'", () => {
		const file = baseDumpFile();
		// Build the gate via the REAL decision primitives (the escalation logic).
		const counts = { read: 25, grep: 0, find: 0, ls: 0 }; // 25 exploration calls > 2×10 → gross
		const budget = computeBudgetStatus(counts, 3, 4);
		const grossBreach = isGrossBreach(budget);
		const force = shouldForceRecommend(budget.breachKind, null, grossBreach);
		expect(budget.exceeded).toBe(true);
		expect(grossBreach).toBe(true);
		expect(force).toBe(true);

		writeCalibrationRecord(file, {
			difficulty: null,
			difficultyPresent: false,
			budget,
			budgetGate: { forced: force, grossBreach, finalRecommend: force ? "investigate" : "", banner: "⚠ [Budget Gate] ..." },
			outcome: DELEGATION_OUTCOME.RESOURCE_LIMIT,
			progress: {},
		});

		const observed = JSON.parse(readFileSync(file, "utf-8"));
		expect(observed.budgetGate.forced).toBe(true);
		expect(observed.budgetGate.grossBreach).toBe(true);
		expect(observed.budgetGate.finalRecommend).toBe("investigate");
		expect(observed.budget.breachKind).toBe("substantive");
	});

	it("is a no-op (never throws) when the dump path is undefined", () => {
		expect(() => writeCalibrationRecord(undefined, {
			difficulty: null,
			difficultyPresent: false,
			budget: EMPTY_BUDGET_STATUS,
			budgetGate: EMPTY_BUDGET_GATE,
			outcome: DELEGATION_OUTCOME.DONE,
			progress: {},
		})).not.toThrow();
	});
});

// ── Runner wiring (live run, mocked session) ─────────────────────────────────

describe("calibration record — runner wiring end-to-end", () => {
	type SubscribeCb = (event: any) => void;

	function createControllableRunner(specialistName = "calib-specialist") {
		const ref = { subscribeCb: null as SubscribeCb | null };
		let resolvePrompt: () => void = () => {};
		const mockSession = {
			sessionId: "calib-session",
			messages: [] as any[],
			subscribe: vi.fn((cb: SubscribeCb) => { ref.subscribeCb = cb; return () => {}; }),
			abort: vi.fn(),
			prompt: vi.fn(() => new Promise<void>((res) => { resolvePrompt = res; })),
			dispose: vi.fn(),
		};
		const mockModel = { contextWindow: 200_000 };
		const mockModelRegistry = { find: vi.fn(() => mockModel), getAvailable: vi.fn(() => [mockModel]), getAll: vi.fn(() => [mockModel]) } as any;
		const runner = new SubagentRunner({
			cwd: "/tmp",
			modelRegistry: mockModelRegistry,
			agentDir: "/Users/shivam94/.pi/agent",
			agentSessionFactory: async () => ({ session: mockSession }),
		} as any);
		const specialist = { name: specialistName, tools: ["read"], systemPrompt: "p" } as any;
		const resultPromise = runner.run("task", specialist);
		return { ref, resolvePrompt: () => resolvePrompt(), resultPromise };
	}

	const assistantEnd = (stopReason: string, text: string) => ({
		type: "message_end",
		message: { role: "assistant", stopReason, content: [{ type: "text", text }], usage: { input: 10, output: 5, totalTokens: 15 } },
	});

	it("run supplies flightRecorderPath + calibration; no ## Difficulty → difficulty null", { timeout: 15_000 }, async () => {
		const { ref, resolvePrompt, resultPromise } = createControllableRunner("calib-wiring");
		await vi.waitFor(() => expect(ref.subscribeCb).not.toBeNull(), { timeout: 10_000 });
		// A single read call — well under budget (10 exploration calls).
		ref.subscribeCb!({ type: "tool_execution_start", toolName: "read", toolCallId: "r1", args: { path: "/tmp/a.ts" } });
		ref.subscribeCb!({ type: "tool_execution_end", toolName: "read", toolCallId: "r1", result: "ok", isError: false });
		ref.subscribeCb!(assistantEnd("end_turn", "done — no difficulty block here"));
		resolvePrompt();
		const result = await resultPromise;

		expect(typeof result.flightRecorderPath).toBe("string");
		expect(result.calibration).toBeDefined();
		expect(result.calibration!.difficulty).toBeNull();
		expect(result.calibration!.difficultyPresent).toBe(false);
		expect(result.calibration!.budget.exceeded).toBe(false);
		expect(result.calibration!.budgetGate.forced).toBe(false);

		// Enrich the REAL file the runner wrote, then read it back.
		writeCalibrationRecord(result.flightRecorderPath, {
			difficulty: result.calibration!.difficulty,
			difficultyPresent: result.calibration!.difficultyPresent,
			budget: result.calibration!.budget,
			budgetGate: result.calibration!.budgetGate,
			outcome: DELEGATION_OUTCOME.DONE,
			progress: { progressState: result.progressState, providerFailures: result.providerFailures, stallTerminated: result.stallTerminated === true },
		});
		const observed = JSON.parse(readFileSync(result.flightRecorderPath!, "utf-8"));
		expect(observed.specialist).toBe("calib-wiring");
		expect(observed.difficulty).toBeNull();
		expect(observed.outcome).toBe(DELEGATION_OUTCOME.DONE);
		expect(observed).toHaveProperty("progress");

		rmSync(result.flightRecorderPath!, { force: true });
	});
});
