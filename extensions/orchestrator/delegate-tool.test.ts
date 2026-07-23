import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerDelegateTool } from "./delegate-tool.ts";
import { runSubagent } from "./subagent-runner.ts";
import type { Scope } from "./scope-manager.ts";

const mockHasActivePlan = vi.hoisted(() => vi.fn());
const mockSetupPlanPanel = vi.hoisted(() => vi.fn());
const mockStartDelegationStep = vi.hoisted(() => vi.fn());
const mockFinalizePlanStep = vi.hoisted(() => vi.fn());
const mockErrorPlanStep = vi.hoisted(() => vi.fn());
const mockIncrementDelegationCount = vi.hoisted(() => vi.fn());
const mockDecrementDelegationCount = vi.hoisted(() => vi.fn());
const mockClearPlanIfComplete = vi.hoisted(() => vi.fn());

vi.mock("./subagent-runner.ts", async () => {
	return {
		runSubagent: vi.fn(),
		SUBAGENT_ENV_KEY: "PI_ORCHESTRATOR_SUBAGENT",
		_batchLoadSubagent: 0,
		isSubagentContext: vi.fn(() => false),
		isPlanParsed: vi.fn(() => false),
	};
});

vi.mock("./plan-panel.ts", () => ({
	hasActivePlan: (...args: any[]) => mockHasActivePlan(...args),
	setupPlanPanel: (...args: any[]) => mockSetupPlanPanel(...args),
	startDelegationStep: (...args: any[]) => mockStartDelegationStep(...args),
	finalizePlanStep: (...args: any[]) => mockFinalizePlanStep(...args),
	errorPlanStep: (...args: any[]) => mockErrorPlanStep(...args),
	incrementDelegationCount: (...args: any[]) => mockIncrementDelegationCount(...args),
	decrementDelegationCount: (...args: any[]) => mockDecrementDelegationCount(...args),
	clearPlanIfComplete: (...args: any[]) => mockClearPlanIfComplete(...args),
}));

mockHasActivePlan.mockReturnValue(true);

function createMockPi() {
	const tools: any[] = [];
	const handlers: Record<string, any[]> = {};
	return {
		registerTool: vi.fn((tool: any) => { tools.push(tool); }),
		getAllTools: vi.fn(() => tools),
		on: vi.fn((event: string, handler: any) => {
			handlers[event] = handlers[event] || [];
			handlers[event].push(handler);
		}),
		trigger: (event: string) => (handlers[event] || []).forEach((h) => h()),
	};
}

type MockPi = ReturnType<typeof createMockPi>;


describe("delegate tool rendering", () => {
	let pi: MockPi;
	let delegateTool: any;

	beforeAll(() => {
		pi = createMockPi();
		registerDelegateTool(pi as any);
		delegateTool = pi.getAllTools().find((t: any) => t.name === "delegate");
	});

	it("renderCall returns empty content", () => {
		const comp = delegateTool.renderCall(
			{ specialist: "coder", task: "fix auth" },
			{ fg: (name: string, text: string) => text, bold: (text: string) => text },
			{},
		);
		expect(comp.text).toBe("");
	});

	it("renderResult prepends the delegate header from stored args", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
			dim: (text: string) => text,
		};
		const context = { state: { delegateArgs: { specialist: "coder", task: "fix auth" } } };
		const comp = delegateTool.renderResult(
			{ content: [{ type: "text", text: "" }], details: { specialist: "Coder", task: "fix auth" } },
			{ isPartial: false, expanded: false },
			theme,
			context,
		);
		expect(comp.text).toContain("delegate Coder");
		expect(comp.text).toContain("done");
	});

	it("renderResult does not duplicate task in header and goal line", () => {
		const theme = {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
			dim: (text: string) => text,
		};
		// Set up context via renderCall (mimics real flow)
		const context: any = {
			invalidate: vi.fn(),
		};
		delegateTool.renderCall(
			{ specialist: "coder", task: "fix auth bug", model: "gpt-4" },
			theme,
			context,
		);
		// Simulate a partial result where the feed text already contains the task
		// in the goal line (e.g. from activity feed: "◆ fix auth bug\n●○○ 1/3")
		const feedText = "\u25c6 fix auth bug\n\u25cf\u25cb\u25cb 1/3";
		const comp = delegateTool.renderResult(
			{ content: [{ type: "text", text: feedText }], details: { specialist: "coder", task: "fix auth bug", model: "gpt-4" } },
			{ isPartial: true },
			theme,
			context,
		);
		// Task should appear EXACTLY ONCE — either in header or goal, not both
		const matches = comp.text.match(/fix auth bug/g);
		expect(matches).toHaveLength(1);
	});
});

describe("delegate scope resolution", () => {
	let pi: MockPi;
	let delegateTool: any;

	beforeAll(() => {
		pi = createMockPi();
		registerDelegateTool(pi as any);
		delegateTool = pi.getAllTools().find((t: any) => t.name === "delegate");
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(runSubagent).mockResolvedValue({ output: "", turns: 0 });
	});

	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "delegate-test-"));
	});

	async function execute(params: any, ctx: any = { cwd: testDir }) {
		const fullCtx = {
			cwd: ctx.cwd ?? testDir,
			ui: {
				setWidget: vi.fn(),
				setWorkingMessage: vi.fn(),
				setStatus: vi.fn(),
				theme: {},
			},
			...ctx,
		};
		return delegateTool.execute("call-1", params, new AbortController().signal, () => {}, fullCtx);
	}

	function lastScopePassed(): Scope | null | undefined {
		const calls = vi.mocked(runSubagent).mock.calls;
		const last = calls[calls.length - 1];
		return last?.[6] as Scope | null | undefined;
	}

	it("coder without scope is rejected", async () => {
		const result = await execute({ specialist: "coder", task: "fix auth" });
		expect(result.content[0].text).toContain("Scope required for coder");
		expect(runSubagent).not.toHaveBeenCalled();
	});

	it("coder with explicit scope works", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

		await execute({
			specialist: "coder",
			task: "fix auth",
			scope: {
				filesToModify: ["src/auth.ts"],
				filesToCreate: [],
				changeType: "single-file",
				maxLinesPerFile: 200,
			},
		});

		expect(lastScopePassed()).toMatchObject({
			filesToModify: ["src/auth.ts"],
			filesToCreate: [],
			changeType: "single-file",
			maxLinesPerFile: 200,
		});
	});

	it("writer uses doc-friendly defaults without explicit scope", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

		await execute({ specialist: "writer", task: "write readme" });

		const scope = lastScopePassed();
		expect(scope).toMatchObject({
			filesToModify: [],
			filesToCreate: [],
			directories: [testDir],
			maxFiles: 20,
			requiresApprovalBeyondScope: true,
			changeType: "multi-file",
			maxLinesPerFile: 400,
			gateMode: "strict",
		});
		expect(scope?.boundaries).toContain("*.md files");
		expect(scope?.boundaries).toContain("docs/");
		expect(scope?.boundaries).toContain("README");
	});

	it("explicit orchestrator scope is used by coder", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

		await execute({
			specialist: "coder",
			task: "fix auth",
			scope: {
				filesToModify: ["src/new.ts"],
				filesToCreate: [],
			},
		});

		expect(lastScopePassed()?.filesToModify).toEqual(["src/new.ts"]);
	});

	it("scout/researcher does not cache scope for coder", async () => {
		vi.mocked(runSubagent)
			.mockResolvedValueOnce({
				output: `## Scope\n- filesToModify: ["src/auth.ts"]\n- filesToCreate: []\n- changeType: single-file\n- maxLinesPerFile: 200\n`,
				turns: 1,
			})
			.mockResolvedValueOnce({ output: "done", turns: 1 });

		// Scout produces scope, but coder should NOT pick it up (no cache)
		await execute({ specialist: "scout", task: "investigate" });
		const result = await execute({ specialist: "coder", task: "fix auth" });

		expect(result.content[0].text).toContain("Scope required for coder");
	});

	it("passes skills override to runSubagent", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

		await execute({
			specialist: "coder",
			task: "fix auth",
			skills: ["tdd", "code-review"],
			scope: {
				filesToModify: ["src/auth.ts"],
				filesToCreate: [],
			},
		});

		const calls = vi.mocked(runSubagent).mock.calls;
		const last = calls[calls.length - 1];
		// suggestedSkills is the 9th argument (index 8)
		expect(last[8]).toEqual(["implement", "tdd", "code-review"]);
	});

	it("passes undefined suggestedSkills when no override given", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

		await execute({
			specialist: "writer",
			task: "write docs",
		});

		const calls = vi.mocked(runSubagent).mock.calls;
		const last = calls[calls.length - 1];
		// suggestedSkills arg should be resolved (mock returns [] for no override)
		expect(last[8]).toBeDefined();
	});

	describe("auto-create plan when no active plan", () => {
		it("auto-creates plan when hasActivePlan returns false", async () => {
			mockHasActivePlan.mockReturnValue(false);
			vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

			await execute({ specialist: "writer", task: "write docs" });

			expect(mockSetupPlanPanel).toHaveBeenCalledOnce();
			const [goal, steps] = mockSetupPlanPanel.mock.calls[0];
			expect(goal).toBe("delegate to writer: write docs");
			expect(steps).toEqual(["Writer: write docs"]);
		});

		it("does NOT auto-create when hasActivePlan returns true", async () => {
			mockHasActivePlan.mockReturnValue(true);
			vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

			await execute({ specialist: "writer", task: "write docs" });

			expect(mockSetupPlanPanel).not.toHaveBeenCalled();
		});

		it("auto-create works for different specialists", async () => {
			mockHasActivePlan.mockReturnValue(false);
			vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

			await execute({ specialist: "scout", task: "find files" });

			expect(mockSetupPlanPanel).toHaveBeenCalledOnce();
			const [goal] = mockSetupPlanPanel.mock.calls[0];
			expect(goal).toBe("delegate to scout: find files");
		});

		it("delegation proceeds after auto-create", async () => {
			mockHasActivePlan.mockReturnValue(false);
			vi.mocked(runSubagent).mockResolvedValueOnce({ output: "done", turns: 1 });

			await execute({ specialist: "writer", task: "write docs" });

			expect(mockSetupPlanPanel).toHaveBeenCalledOnce();
			expect(mockStartDelegationStep).toHaveBeenCalled();
			expect(runSubagent).toHaveBeenCalled();
		});
	});
});
