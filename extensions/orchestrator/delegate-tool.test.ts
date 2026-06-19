import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerDelegateTool, extractScopeFromOutput } from "./delegate-tool";
import { runSubagent } from "./subagent-runner";
import type { Scope } from "./types";

vi.mock("./subagent-runner.ts", async () => {
	return {
		runSubagent: vi.fn(),
		SUBAGENT_ENV_KEY: "PI_ORCHESTRATOR_SUBAGENT",
		_batchLoadSubagent: 0,
		isSubagentContext: vi.fn(() => false),
		isPlanParsed: vi.fn(() => false),
	};
});

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

describe("extractScopeFromOutput", () => {
	it("parses a well-formed ## Scope block", () => {
		const output = `
## Scope
- filesToModify: ["src/auth.ts", "src/login.ts"]
- filesToCreate: ["src/new.ts"]
- directories: ["src/"]
- changeType: "multi-file"
- maxLinesPerFile: 400
- maxFiles: 5
- requiresApprovalBeyondScope: false
- gateMode: strict
`;
		const scope = extractScopeFromOutput(output);
		expect(scope).toEqual({
			filesToModify: ["src/auth.ts", "src/login.ts"],
			filesToCreate: ["src/new.ts"],
			directories: ["src/"],
			changeType: "multi-file",
			maxLinesPerFile: 400,
			maxFiles: 5,
			requiresApprovalBeyondScope: false,
			gateMode: "strict",
		} satisfies Scope);
	});

	it("applies sensible defaults for minimal blocks", () => {
		const output = `
## Scope
- filesToModify: ["src/a.ts"]
- filesToCreate: []
`;
		const scope = extractScopeFromOutput(output);
		expect(scope).toMatchObject({
			filesToModify: ["src/a.ts"],
			filesToCreate: [],
			directories: [],
			maxFiles: 10,
			requiresApprovalBeyondScope: true,
			changeType: "multi-file",
			maxLinesPerFile: 400,
			gateMode: "strict",
		});
	});

	it("returns null when no ## Scope block is present", () => {
		expect(extractScopeFromOutput("## Findings\n- summary: nothing")).toBeNull();
	});

	it("returns null for malformed blocks with no scope keys", () => {
		expect(extractScopeFromOutput("## Scope\nSome random text\n")).toBeNull();
	});

	it("stops at the next ## heading", () => {
		const output = `
## Scope
- filesToModify: ["a.ts"]
- filesToCreate: []
## Recommendation
- do it
`;
		const scope = extractScopeFromOutput(output);
		expect(scope?.filesToModify).toEqual(["a.ts"]);
		expect(scope?.filesToCreate).toEqual([]);
	});

	it("infers relaxed gateMode for single-file changes", () => {
		const output = `
## Scope
- filesToModify: ["a.ts"]
- changeType: "single-file"
`;
		const scope = extractScopeFromOutput(output);
		expect(scope?.gateMode).toBe("relaxed");
		expect(scope?.changeType).toBe("single-file");
	});
});

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
		expect(comp.text).toContain("delegate Coder: fix auth");
		expect(comp.text).toContain("✓ done");
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
});
