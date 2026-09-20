import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeDelegate } from "./delegate-controller.ts";

const mockSpecialists = vi.hoisted(() => ({
  test: { name: "test", tools: ["read", "write"], systemPrompt: "test" },
  coder: { name: "coder", tools: ["edit", "write", "read", "bash"], systemPrompt: "coder" },
  researcher: { name: "researcher", tools: ["read", "grep", "bash"], systemPrompt: "researcher" },
  scout: { name: "scout", tools: ["read", "grep", "bash"], systemPrompt: "scout" },
  reviewer: { name: "reviewer", tools: ["read", "bash", "grep"], systemPrompt: "reviewer" },
  writer: { name: "writer", tools: ["read", "write"], systemPrompt: "writer" },
}));

const mockResolve = vi.hoisted(() => vi.fn(() => "pass"));

vi.mock("./specialists.ts", () => ({
  SPECIALISTS: mockSpecialists,
  SPECIALIST_VERBS: {
    scout: 'Scouting',
    coder: 'Coding',
    reviewer: 'Reviewing',
    researcher: 'Researching',
    writer: 'Writing',
  },
  getSpecialistSkills: (_name: string, override?: string[]) => override !== undefined ? override : [],
  DELIVERABLE_MARKERS: ["## Completed", "## Findings", "## Files Changed"],
  isReadOnlySpecialist: (name: string) => (mockSpecialists as any)[name]?.tools?.includes('edit') === false && (mockSpecialists as any)[name]?.tools?.includes('write') === false,
  canUseBash: (name: string) => (mockSpecialists as any)[name]?.tools?.includes('bash') === true,
  hasGitTools: (name: string) => false,
}));

const mockRunSubagent = vi.hoisted(() => vi.fn());
vi.mock("./subagent-runner.ts", () => ({ runSubagent: mockRunSubagent, ERROR_MARKER: "[error]", ABORT_MARKER: "[aborted]" }));

const mockHasActivePlan = vi.hoisted(() => vi.fn());
const mockSetupPlanPanel = vi.hoisted(() => vi.fn());
const mockStartDelegationStep = vi.hoisted(() => vi.fn());
const mockFinalizePlanStep = vi.hoisted(() => vi.fn());
const mockErrorPlanStep = vi.hoisted(() => vi.fn());
const mockIncrementDelegationCount = vi.hoisted(() => vi.fn());
const mockDecrementDelegationCount = vi.hoisted(() => vi.fn());
const mockClearPlanIfComplete = vi.hoisted(() => vi.fn());

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

const mockClearScope = vi.hoisted(() => vi.fn());
const mockResolveScope = vi.hoisted(() => vi.fn((params, specialistDef, cwd) => {
  if (params.scope) return params.scope;
  if (params.specialist === "coder") return null;
  if (params.specialist === "writer") return { filesToModify: [], filesToCreate: [], directories: [cwd], maxFiles: 20, requiresApprovalBeyondScope: true, changeType: 'multi-file', maxLinesPerFile: 400, gateMode: 'strict' };
  const isReadOnly = !specialistDef.tools.includes('edit') && !specialistDef.tools.includes('write');
  if (isReadOnly) return { filesToModify: [], filesToCreate: [], directories: [], maxFiles: 10, requiresApprovalBeyondScope: false, changeType: 'multi-file', maxLinesPerFile: 400, gateMode: 'relaxed' };
  return null;
}));
const mockCreateDelegationScope = vi.hoisted(() => vi.fn(() => "delegation-id"));
const mockClearDelegationScope = vi.hoisted(() => vi.fn());
vi.mock("./scope-manager.ts", () => ({
  ScopeManager: Object.assign(
    vi.fn(function() { return { writeScope: vi.fn(), clearScope: mockClearScope }; }),
    { resolveScope: mockResolveScope }
  ),
  createDelegationScope: mockCreateDelegationScope,
  clearDelegationScope: mockClearDelegationScope,
}));

vi.mock("./ask-resolver.ts", () => ({
  createAskOrchestratorResolver: () => vi.fn(),
  resolve: (...args: unknown[]) => (mockResolve as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("./debug.ts", () => ({ debugLog: vi.fn() }));
vi.mock("./delegate-output-formatter.ts", () => ({
  extractFindingsFromOutput: vi.fn(() => null),
  extractAuditFromOutput: vi.fn(() => null),
}));
vi.mock("./peek-overlay.ts", () => ({ hidePeek: vi.fn(), clearViewerState: vi.fn() }));
vi.mock("./spinner-state.ts", () => ({
  SPINNER_FRAMES: ["⠋", "⠙", "⠹"],
  currentFrame: vi.fn(() => "⠋"),
}));

// Mock orchestrator-config so getSessionMode/loadOrchestratorConfig are deterministic and
// the test does NOT depend on the real ~/.pi/agent/orchestrator.yml. Its delegation.mode may
// be "parallel", which would flip the pipeline into parallel mode and invoke createDelegationScope
// (previously the mode was always "sequential" because config was never loaded).
const mockGetSessionMode = vi.hoisted(() => vi.fn(() => "sequential"));
vi.mock("./orchestrator-config", async () => {
  const actual = await vi.importActual<typeof import("./orchestrator-config")>("./orchestrator-config");
  return {
    ...actual,
    getSessionMode: (...args: any[]) => mockGetSessionMode(...args as []),
    loadOrchestratorConfig: vi.fn(() => ({
      delegation: { parallel: { maxConcurrent: 4, timeoutMs: 600000 } },
    })),
  };
});

function createMockCtx(overrides: Record<string, unknown> = {}) {
  return { cwd: "/test/project", modelRegistry: {}, model: "test-model", ...overrides };
}

function createSubagentResult(overrides: Record<string, unknown> = {}) {
  return { output: "done", turns: 3, toolCallTrail: [{ tool: "read", completed: true }], ...overrides };
}

describe("executeDelegate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasActivePlan.mockReturnValue(true);
    mockRunSubagent.mockResolvedValue(createSubagentResult());
  });

  describe("validation", () => {
    it("returns error when specialist missing", async () => {
      const r = await executeDelegate({ specialist: "", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain("specialist");
    });

    it("returns error when task missing", async () => {
      const r = await executeDelegate({ specialist: "test", task: "" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain("specialist");
    });

    it("returns error for unknown specialist", async () => {
      const r = await executeDelegate({ specialist: "nope", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain('Unknown specialist: "nope"');
    });

    it("returns error for coder without scope", async () => {
      const r = await executeDelegate({ specialist: "coder", task: "fix" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain("Scope required for coder");
    });
  });

  describe("success", () => {
    it("returns correct result structure", async () => {
      const r = await executeDelegate({ specialist: "test", task: "write" }, createMockCtx(), vi.fn());
      expect(r.content).toHaveLength(1);
      expect(r.content[0].type).toBe("text");
      expect(r.details.specialist).toBe("test");
      expect(r.details.status).toBe("done");
      expect(r.details.turns).toBe(3);
    });

    it("auto-creates plan and proceeds when no active plan", async () => {
      mockHasActivePlan.mockReturnValue(false);
      const r = await executeDelegate({ specialist: "test", task: "plan" }, createMockCtx(), vi.fn());
      expect(mockSetupPlanPanel).toHaveBeenCalledOnce();
      const [goal, steps] = mockSetupPlanPanel.mock.calls[0];
      expect(goal).toContain("test");
      expect(steps).toHaveLength(1);
      expect(r.details.status).toBe("done");
    });

    it("appends to existing plan", async () => {
      mockHasActivePlan.mockReturnValue(true);
      await executeDelegate({ specialist: "test", task: "step" }, createMockCtx(), vi.fn());
      expect(mockSetupPlanPanel).not.toHaveBeenCalled();
    });
  });

  describe("specialist name normalization", () => {
    it("handles Researcher (capitalized)", async () => {
      const r = await executeDelegate({ specialist: "Researcher", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).not.toContain("Unknown specialist");
      expect(r.details.specialist).toBe("researcher");
    });

    it("handles RESEARCHER (uppercase)", async () => {
      const r = await executeDelegate({ specialist: "RESEARCHER", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).not.toContain("Unknown specialist");
      expect(r.details.specialist).toBe("researcher");
    });

    it("handles researcher (lowercase)", async () => {
      const r = await executeDelegate({ specialist: "researcher", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).not.toContain("Unknown specialist");
      expect(r.details.specialist).toBe("researcher");
    });

    it("handles Coder (capitalized) — resolves, then fails on scope", async () => {
      const r = await executeDelegate({ specialist: "Coder", task: "fix" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).not.toContain("Unknown specialist");
      expect(r.content[0].text).toContain("Scope required for coder");
    });

    it("returns error for unknown specialist", async () => {
      const r = await executeDelegate({ specialist: "unknown", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain('Unknown specialist: "unknown"');
    });

    it("protects against __proto__ pollution", async () => {
      const r = await executeDelegate({ specialist: "__proto__", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain("Unknown specialist");
    });

    it("protects against constructor pollution", async () => {
      const r = await executeDelegate({ specialist: "constructor", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain("Unknown specialist");
    });

    it("protects against toString pollution", async () => {
      const r = await executeDelegate({ specialist: "toString", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toContain("Unknown specialist");
    });

    it("trims leading whitespace", async () => {
      const r = await executeDelegate({ specialist: "  researcher", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).not.toContain("Unknown specialist");
      expect(r.details.specialist).toBe("researcher");
    });
  });

  describe("cleanup", () => {
    it("clears scope and decrements count in finally", async () => {
      await executeDelegate({ specialist: "test", task: "x" }, createMockCtx(), vi.fn());
      expect(mockClearScope).toHaveBeenCalledOnce();
      expect(mockDecrementDelegationCount).toHaveBeenCalledOnce();
    });
  });

  describe("read-only specialists", () => {
    it("Scout with empty scope is allowed (no vague-scope warning)", async () => {
      const r = await executeDelegate(
        { specialist: "scout", task: "find auth code" },
        createMockCtx(),
        vi.fn(),
      );
      expect(r.content[0].text).not.toContain("clarify");
      expect(r.content[0].text).not.toContain("vague");
      expect(r.details.status).toBe("done");
    });

    it("Reviewer with empty scope is allowed", async () => {
      const r = await executeDelegate(
        { specialist: "reviewer", task: "review PR" },
        createMockCtx(),
        vi.fn(),
      );
      expect(r.content[0].text).not.toContain("clarify");
      expect(r.content[0].text).not.toContain("vague");
      expect(r.details.status).toBe("done");
    });

    it("Researcher with empty scope is allowed", async () => {
      const r = await executeDelegate(
        { specialist: "researcher", task: "research topic" },
        createMockCtx(),
        vi.fn(),
      );
      expect(r.content[0].text).not.toContain("clarify");
      expect(r.content[0].text).not.toContain("vague");
      expect(r.details.status).toBe("done");
    });

    it("Coder with empty scope still gets vague-scope warning (unchanged)", async () => {
      mockResolve.mockReturnValueOnce("ask");
      const r = await executeDelegate(
        {
          specialist: "coder",
          task: "fix bug",
          scope: {
            filesToModify: [],
            filesToCreate: [],
            directories: [],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: "multi-file",
            maxLinesPerFile: 400,
            gateMode: "strict" as const,
          },
        },
        createMockCtx(),
        vi.fn(),
      );
      expect(r.content[0].text).toContain("Clarify");
    });

    it("Writer with empty scope still gets vague-scope warning (unchanged)", async () => {
      mockResolve.mockReturnValueOnce("ask");
      const r = await executeDelegate(
        {
          specialist: "writer",
          task: "write doc",
          scope: {
            filesToModify: [],
            filesToCreate: [],
            directories: [],
            maxFiles: 10,
            requiresApprovalBeyondScope: true,
            changeType: "multi-file",
            maxLinesPerFile: 400,
            gateMode: "strict" as const,
          },
        },
        createMockCtx(),
        vi.fn(),
      );
      expect(r.content[0].text).toContain("Clarify");
    });

    it("read-only specialist does not get vague-scope warning even when resolve returns 'ask'", async () => {
      mockResolve.mockReturnValueOnce("ask");
      const result = await executeDelegate(
        { specialist: "scout", task: "some read task" },
        createMockCtx(),
        vi.fn(),
      );
      expect(result.content[0].text).not.toContain("clarify");
      expect(result.content[0].text).not.toContain("vague");
    });
  });

  describe("error status", () => {
    it("returns status 'error' when stopReason is 'error'", async () => {
      mockRunSubagent.mockResolvedValueOnce(
        createSubagentResult({
          output: "[error] Task failed",
          stopReason: "error",
          errorMessage: "Task failed",
          turns: 2,
        }),
      );
      const r = await executeDelegate({ specialist: "test", task: "fail" }, createMockCtx(), vi.fn());
      expect(r.details.status).toBe("error");
    });

    it("includes stopReason in details when error", async () => {
      mockRunSubagent.mockResolvedValueOnce(
        createSubagentResult({
          output: "[error] Task failed",
          stopReason: "error",
          errorMessage: "Task failed",
          turns: 1,
        }),
      );
      const r = await executeDelegate({ specialist: "test", task: "fail" }, createMockCtx(), vi.fn());
      expect(r.details.stopReason).toBe("error");
    });

    it("includes errorMessage in details when error", async () => {
      mockRunSubagent.mockResolvedValueOnce(
        createSubagentResult({
          output: "[error] Task failed",
          stopReason: "error",
          errorMessage: "Task failed",
          turns: 1,
        }),
      );
      const r = await executeDelegate({ specialist: "test", task: "fail" }, createMockCtx(), vi.fn());
      expect(r.details.errorMessage).toBe("Task failed");
    });

    it("sets partialResults false when output is pure error text", async () => {
      mockRunSubagent.mockResolvedValueOnce(
        createSubagentResult({
          output: "[error] Some partial work",
          stopReason: "error",
          errorMessage: "crashed",
          turns: 3,
        }),
      );
      const r = await executeDelegate({ specialist: "test", task: "fail" }, createMockCtx(), vi.fn());
      expect(r.details.partialResults).toBe(false);
    });

    it("sets partialResults true when error has non-error output", async () => {
      mockRunSubagent.mockResolvedValueOnce(
        createSubagentResult({
          output: "Some useful work done",
          stopReason: "error",
          errorMessage: "crashed",
          turns: 3,
        }),
      );
      const r = await executeDelegate({ specialist: "test", task: "fail" }, createMockCtx(), vi.fn());
      expect(r.details.partialResults).toBe(true);
    });

    it("sets partialResults false when error has no output", async () => {
      mockRunSubagent.mockResolvedValueOnce(
        createSubagentResult({
          output: "",
          stopReason: "error",
          errorMessage: "crashed",
          turns: 0,
        }),
      );
      const r = await executeDelegate({ specialist: "test", task: "fail" }, createMockCtx(), vi.fn());
      expect(r.details.partialResults).toBe(false);
    });

    it("returns status 'done' and no partialResults on success", async () => {
      const r = await executeDelegate({ specialist: "test", task: "succeed" }, createMockCtx(), vi.fn());
      expect(r.details.status).toBe("done");
      expect(r.details.partialResults).toBeFalsy();
    });
  });

  describe("ask-resolver gate", () => {
    it("returns structured result when resolve() returns 'ask' instead of throwing", async () => {
      // Force resolve to return "ask" (vague scope)
      mockResolve.mockReturnValueOnce("ask");

      const result = await executeDelegate(
        { specialist: "writer", task: "write something vague", scope: { filesToModify: ["x.md"], filesToCreate: [], directories: [], maxFiles: 10, requiresApprovalBeyondScope: true, changeType: "multi-file", maxLinesPerFile: 400, gateMode: "strict" } },
        createMockCtx(),
        vi.fn(),
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Clarify");
      expect(result.details).toBeDefined();
    });
  });

  describe("child plan — nothing is ever injected into the child task", () => {
    // Owner decision: the child authors its own goal and steps via its own
    // planSteps({ goal, steps }) call. Neither an explicit `label` nor a
    // `## Steps`-looking section in the task text may reach the child.
    const rawTask = "Fix the flaky login test. Do not touch snapshots.";
    const structuredTask = "Do the work.\n\n## Steps\n1. read the file\n2. patch it";
    const acceptanceBlock =
      "\n\n## Acceptance Tests\nAfter implementing, describe acceptance tests (vitest assertions, plain text) that verify your work:\n" +
      "- Happy path — confirm feature works as expected\n" +
      "- Edge cases — boundary conditions are handled\n" +
      "- Regression (if fixing a bug) — fix stays effective\n\n" +
      "Include these as plain-text assertions under a ## Acceptance Tests section in your output. Do NOT use the plan() tool.\n";

    it("passes a plain task through byte-identical (no label, no ## Steps)", async () => {
      await executeDelegate({ specialist: "test", task: rawTask }, createMockCtx(), vi.fn());
      expect(mockRunSubagent.mock.calls[0][1]).toBe(rawTask);
    });

    it("passes a ## Steps-looking task through byte-identical", async () => {
      await executeDelegate({ specialist: "test", task: structuredTask }, createMockCtx(), vi.fn());
      expect(mockRunSubagent.mock.calls[0][1]).toBe(structuredTask);
    });

    it("ignores an explicit label when composing the child task (label shapes the parent step only)", async () => {
      await executeDelegate(
        { specialist: "test", task: rawTask, label: "Health-check orchestrator" },
        createMockCtx(),
        vi.fn(),
      );
      expect(mockRunSubagent.mock.calls[0][1]).toBe(rawTask);
    });

    it("never seeds — even with a ## Steps section AND an explicit label", async () => {
      await executeDelegate(
        { specialist: "test", task: structuredTask, label: "delegate to scout: READ-ONLY investigation" },
        createMockCtx(),
        vi.fn(),
      );
      const composed = mockRunSubagent.mock.calls[0][1] as string;
      expect(composed).toBe(structuredTask);
      expect(composed).not.toContain("[framework] Plan seed");
      expect(composed).not.toContain("planSteps({ goal:");
    });

    it("coder: raw task + the acceptance-tests block, nothing else", async () => {
      const scope = {
        filesToModify: [],
        filesToCreate: [],
        directories: [],
        maxFiles: 10,
        requiresApprovalBeyondScope: true,
        changeType: "multi-file" as const,
        maxLinesPerFile: 400,
        gateMode: "strict" as const,
      };
      await executeDelegate(
        { specialist: "coder", task: structuredTask, scope, label: "fix login" },
        createMockCtx(),
        vi.fn(),
      );
      const composed = mockRunSubagent.mock.calls[0][1] as string;
      expect(composed).not.toContain("[framework] Plan seed");
      expect(composed).not.toContain("planSteps({ goal:");
      // Exact pre-a5c61cd shape: the raw task + the acceptance block, nothing before it.
      expect(composed).toBe(structuredTask + acceptanceBlock);
    });
  });

  describe("plan-seed removal — the seed API no longer exists", () => {
    it("delegate-pipeline.ts no longer exports any seed symbol", async () => {
      const mod = await import("./delegate-pipeline.ts");
      for (const name of [
        "composeSeededTask",
        "buildPlanSeedBlock",
        "seedGoalLine",
        "deriveChildPlanSteps",
        "extractStepsFromTask",
        "PLAN_SEED_MARKER",
        "PARENT_PANEL_GOAL_PREFIX",
        "isParentPanelLabel",
      ]) {
        expect(Object.prototype.hasOwnProperty.call(mod, name), `${name} must be gone`).toBe(false);
      }
    });

    it("delegate-pipeline.ts source contains no seed marker or seed call site", () => {
      const source = readFileSync(resolve(__dirname, "delegate-pipeline.ts"), "utf-8");
      expect(source).not.toContain("[framework] Plan seed");
      expect(source).not.toContain("composeSeededTask");
      expect(source).not.toContain("planSteps({ goal:");
    });
  });
});
