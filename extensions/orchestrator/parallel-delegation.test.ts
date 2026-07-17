import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock specialists ──────────────────────────────────────────────────
const mockSpecialists = vi.hoisted(() => ({
	scout: { name: "scout", tools: ["read", "grep", "bash"], systemPrompt: "scout", readOnly: true },
	coder: { name: "coder", tools: ["edit", "write", "read", "bash"], systemPrompt: "coder", readOnly: false },
	reviewer: { name: "reviewer", tools: ["read", "bash", "grep"], systemPrompt: "reviewer", readOnly: true },
	researcher: { name: "researcher", tools: ["read", "grep", "bash"], systemPrompt: "researcher", readOnly: true },
	writer: { name: "writer", tools: ["read", "write"], systemPrompt: "writer", readOnly: false },
}));

vi.mock("./specialists.ts", () => ({
	listSpecialists: vi.fn(() => Object.keys(mockSpecialists)),
	SPECIALISTS: mockSpecialists,
	SPECIALIST_VERBS: { scout: "Scouting", coder: "Coding", reviewer: "Reviewing", researcher: "Researching", writer: "Writing" },
	getSpecialistSkills: (_name: string, override?: string[]) => override !== undefined ? override : [],
	TERSE_INSTRUCTION: "\n\nRespond with completeness but without verbosity.",
}));

// ── Mock subagent runner ──────────────────────────────────────────────
const mockRunSubagent = vi.hoisted(() => vi.fn());
vi.mock("./subagent-runner.ts", () => ({ runSubagent: mockRunSubagent }));

// ── Mock plan panel ───────────────────────────────────────────────────
const mockHasActivePlan = vi.hoisted(() => vi.fn(() => true));
const mockSetupPlanPanel = vi.hoisted(() => vi.fn());
const mockStartDelegationStep = vi.hoisted(() => vi.fn());
const mockFinalizePlanStep = vi.hoisted(() => vi.fn());
const mockErrorPlanStep = vi.hoisted(() => vi.fn());
const mockIncrementDelegationCount = vi.hoisted(() => vi.fn());
const mockDecrementDelegationCount = vi.hoisted(() => vi.fn());
const mockClearPlanIfComplete = vi.hoisted(() => vi.fn());
const mockUpdatePlanStepDetail = vi.hoisted(() => vi.fn());
const mockRecordTimelineFrame = vi.hoisted(() => vi.fn());

vi.mock("./plan-panel.ts", () => ({
	hasActivePlan: (...args: any[]) => mockHasActivePlan(...args as []),
	setupPlanPanel: (...args: any[]) => mockSetupPlanPanel(...args),
	startDelegationStep: (...args: any[]) => mockStartDelegationStep(...args),
	finalizePlanStep: (...args: any[]) => mockFinalizePlanStep(...args),
	errorPlanStep: (...args: any[]) => mockErrorPlanStep(...args),
	incrementDelegationCount: (...args: any[]) => mockIncrementDelegationCount(...args),
	decrementDelegationCount: (...args: any[]) => mockDecrementDelegationCount(...args),
	clearPlanIfComplete: (...args: any[]) => mockClearPlanIfComplete(...args),
	updatePlanStepDetail: (...args: any[]) => mockUpdatePlanStepDetail(...args),
	recordTimelineFrame: (...args: any[]) => mockRecordTimelineFrame(...args),
}));

// ── Mock scope manager ────────────────────────────────────────────────
const mockClearScope = vi.hoisted(() => vi.fn());
const mockWriteScope = vi.hoisted(() => vi.fn());
const mockResolveScope = vi.hoisted(() => vi.fn((_params, _specialistDef, _cwd) => null));

vi.mock("./scope-manager.ts", () => ({
	ScopeManager: Object.assign(
		vi.fn(function () { return { writeScope: mockWriteScope, clearScope: mockClearScope }; }),
		{ resolveScope: mockResolveScope }
	),
	createDelegationScope: vi.fn(() => "delegation-id-1"),
	clearDelegationScope: vi.fn(),
}));

// ── Mock ask resolver ─────────────────────────────────────────────────
vi.mock("./ask-resolver.ts", () => ({
	createAskOrchestratorResolver: () => vi.fn(),
	resolve: () => "pass",
}));

// ── Mock other deps ───────────────────────────────────────────────────
vi.mock("./debug.ts", () => ({ debugLog: vi.fn() }));
vi.mock("./peek-overlay.ts", () => ({ hidePeek: vi.fn(), clearViewerState: vi.fn() }));
vi.mock("./spinner-state.ts", () => ({
	SPINNER_FRAMES: ["⠋", "⠙", "⠹"],
	currentFrame: vi.fn(() => "⠋"),
}));
vi.mock("./subagent-diagnostics.ts", () => ({
	captureDiagnostic: vi.fn(() => null),
	isDiagnosticsEnabled: vi.fn(() => false),
	persistDiagnostic: vi.fn(),
	cleanupOldDiagnostics: vi.fn(),
}));

// ── Mock orchestrator-config ──────────────────────────────────────────
const mockGetSessionMode = vi.hoisted(() => vi.fn(() => "parallel"));
vi.mock("./orchestrator-config", () => ({
	getSessionMode: (...args: any[]) => mockGetSessionMode(...args as []),
	loadOrchestratorConfig: vi.fn(() => ({
		delegation: { parallel: { maxConcurrent: 4, timeoutMs: 120000 } },
	})),
}));

// ── Mock orchestrator-theme (used by pipeline for status icons) ────────
vi.mock("./orchestrator-theme.ts", () => ({
	statusIcon: vi.fn(() => "✓"),
	styledSymbol: vi.fn(() => ""),
	getTheme: vi.fn(() => ({ fg: (_c: string, t?: string) => t || "" })),
}));

// ── Imports after mocks ───────────────────────────────────────────────
import { executeDelegate } from "./delegate-controller.ts";
import { DelegatePipeline } from "./delegate-pipeline.ts";
import { buildOrchestratorPrompt } from "./prompt-builder.ts";

// ── Helpers ───────────────────────────────────────────────────────────
function createMockCtx(overrides: Record<string, unknown> = {}) {
	return { cwd: "/test/project", modelRegistry: {}, model: "test-model", ...overrides };
}

function createSubagentResult(output = "done") {
	return {
		output,
		turns: 3,
		toolCallTrail: [{ tool: "read", completed: true }],
	};
}

// ── Tests ─────────────────────────────────────────────────────────────
describe("parallel delegation (batch)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHasActivePlan.mockReturnValue(true);
		mockGetSessionMode.mockReturnValue("parallel");
		mockRunSubagent.mockResolvedValue(createSubagentResult());
	});

	describe("batch routing", () => {
		it("runBatch with 2 entries returns 2 results", async () => {
			mockRunSubagent.mockResolvedValue(createSubagentResult("output from subagent"));

			const r = await executeDelegate(
				{
					batch: [
						{ specialist: "scout", task: "investigate auth" },
						{ specialist: "scout", task: "investigate db" },
					],
				},
				createMockCtx(),
				vi.fn(),
			);

			expect(mockRunSubagent).toHaveBeenCalledTimes(2);
			expect(r.content[0].text).toContain("## Batch Delegation 1: scout");
			expect(r.content[0].text).toContain("## Batch Delegation 2: scout");
			expect(r.details.status).toBe("batch_complete");
			expect(r.details.total).toBe(2);
			expect(r.details.succeeded).toBe(2);
		});

		it("empty batch returns error", async () => {
			const r = await executeDelegate(
				{ batch: [] },
				createMockCtx(),
				vi.fn(),
			);

			// Empty batch falls through to single delegation path, which requires specialist+task
			expect(r.content[0].text).toContain("specialist and task are required");
		});
	});

	describe("concurrency limiting", () => {
		it("maxConcurrent limits parallelism", async () => {
			// Track concurrent calls
			let maxSeen = 0;
			let running = 0;

			mockRunSubagent.mockImplementation(async () => {
				running++;
				if (running > maxSeen) maxSeen = running;
				await new Promise(res => setTimeout(res, 10));
				running--;
				return createSubagentResult("done");
			});

			const ctx = createMockCtx({
				config: { delegation: { parallel: { maxConcurrent: 2, timeoutMs: 120000 } } },
			});

			const r = await executeDelegate(
				{
					batch: [
						{ specialist: "scout", task: "task1" },
						{ specialist: "scout", task: "task2" },
						{ specialist: "scout", task: "task3" },
						{ specialist: "scout", task: "task4" },
					],
				},
				ctx,
				vi.fn(),
			);

			expect(maxSeen).toBeLessThanOrEqual(2);
			expect(r.details.total).toBe(4);
			expect(r.details.succeeded).toBe(4);
		});
	});

	describe("error isolation", () => {
		it("batch error in one entry doesn't fail others", async () => {
			mockRunSubagent
				.mockResolvedValueOnce(createSubagentResult("success 1"))
				.mockRejectedValueOnce(new Error("subagent crashed"))
				.mockResolvedValueOnce(createSubagentResult("success 3"));

			const r = await executeDelegate(
				{
					batch: [
						{ specialist: "scout", task: "task1" },
						{ specialist: "scout", task: "task2" },
						{ specialist: "scout", task: "task3" },
					],
				},
				createMockCtx(),
				vi.fn(),
			);

			expect(r.details.status).toBe("batch_complete");
			expect(r.details.succeeded).toBe(2);
			expect(r.details.failed).toBe(1);
			expect(r.content[0].text).toContain("success 1");
			expect(r.content[0].text).toContain("success 3");
			expect(r.content[0].text).toContain("❌ Error: Error: subagent crashed");
		});
	});

	describe("mode guard", () => {
		it("batch blocked in sequential mode", async () => {
			mockGetSessionMode.mockReturnValue("sequential");

			const r = await executeDelegate(
				{
					batch: [
						{ specialist: "scout", task: "task1" },
						{ specialist: "scout", task: "task2" },
					],
				},
				createMockCtx(),
				vi.fn(),
			);

			expect(r.content[0].text).toContain("Batch delegation requires parallel mode");
			expect(r.details.error).toBe("batch_requires_parallel_mode");
			expect(mockRunSubagent).not.toHaveBeenCalled();
		});
	});

	describe("single delegation without batch", () => {
		it("specialist and task required when batch not provided", async () => {
			const r = await executeDelegate(
				{},
				createMockCtx(),
				vi.fn(),
			);

			expect(r.content[0].text).toContain("specialist and task are required");
		});
	});

	describe("result formatting", () => {
		it("results formatted with headers", async () => {
			mockRunSubagent
				.mockResolvedValueOnce(createSubagentResult("auth output"))
				.mockResolvedValueOnce(createSubagentResult("db output"));

			const r = await executeDelegate(
				{
					batch: [
						{ specialist: "scout", task: "investigate auth" },
						{ specialist: "scout", task: "investigate db" },
					],
				},
				createMockCtx(),
				vi.fn(),
			);

			const text = r.content[0].text;
			expect(text).toContain("## Batch Delegation 1: scout");
			expect(text).toContain("## Batch Delegation 2: scout");
			expect(text).toContain("---");
			expect(text).toContain("auth output");
			expect(text).toContain("db output");
		});
	});
});

describe("prompt-builder mode injection", () => {
	it("parallel mode includes batch instructions", () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: "", mode: "parallel" });
		expect(systemPrompt).toContain("parallel delegation mode");
		expect(systemPrompt).toContain("batch");
		expect(systemPrompt).toContain("concurrent");
	});

	it("sequential mode includes sequential instructions", () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: "", mode: "sequential" });
		expect(systemPrompt).toContain("sequential delegation mode");
		expect(systemPrompt).toContain("One delegation at a time");
	});

	it("no mode defaults to sequential text", () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: "" });
		expect(systemPrompt).toContain("sequential delegation mode");
	});

	it("parallel mode includes batch example", () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: "", mode: "parallel" });
		expect(systemPrompt).toContain("delegate({ batch:");
		expect(systemPrompt).toContain("specialist: \"scout\"");
	});
});
