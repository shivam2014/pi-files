import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeDelegate } from "./delegate-controller.ts";

const mockSpecialists = vi.hoisted(() => ({
  test: { name: "test", tools: ["read", "write"], systemPrompt: "test" },
  coder: { name: "coder", tools: ["edit", "write", "read", "bash"], systemPrompt: "coder" },
  researcher: { name: "researcher", tools: ["read", "grep", "bash"], systemPrompt: "researcher" },
  writer: { name: "writer", tools: ["read", "write"], systemPrompt: "writer" },
}));

vi.mock("./specialists.ts", () => ({ SPECIALISTS: mockSpecialists }));

const mockRunSubagent = vi.hoisted(() => vi.fn());
vi.mock("./subagent-runner.ts", () => ({ runSubagent: mockRunSubagent }));

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
vi.mock("./scope-manager.ts", () => ({
  ScopeManager: vi.fn(function() { return { writeScope: vi.fn(), clearScope: mockClearScope }; }),
}));

vi.mock("./ask-resolver.ts", () => ({ createAskOrchestratorResolver: () => vi.fn() }));
vi.mock("./debug.ts", () => ({ debugLog: vi.fn() }));
vi.mock("./delegate-output-formatter.ts", () => ({
  extractFindingsFromOutput: vi.fn(() => null),
  extractAuditFromOutput: vi.fn(() => null),
}));
vi.mock("./peek-overlay.ts", () => ({ hidePeek: vi.fn(), unregisterPeekFeed: vi.fn() }));
vi.mock("./spinner-state.ts", () => ({
  SPINNER_FRAMES: ["⠋", "⠙", "⠹"],
  getSpinnerIndex: vi.fn(() => 0),
}));

function createMockCtx(overrides: Record<string, unknown> = {}) {
  return { cwd: "/test/project", modelRegistry: {}, model: "test-model", ...overrides };
}

function createSubagentResult(overrides: Record<string, unknown> = {}) {
  return { output: "done", turns: 3, toolCallTrail: [{ tool: "read", completed: true }], ...overrides };
}

describe("executeDelegate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasActivePlan.mockReturnValue(false);
    mockRunSubagent.mockResolvedValue(createSubagentResult());
  });

  describe("validation", () => {
    it("returns error when specialist missing", async () => {
      const r = await executeDelegate({ specialist: "", task: "x" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toBe("Provide specialist+task");
    });

    it("returns error when task missing", async () => {
      const r = await executeDelegate({ specialist: "test", task: "" }, createMockCtx(), vi.fn());
      expect(r.content[0].text).toBe("Provide specialist+task");
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

    it("sets up plan panel when no active plan", async () => {
      await executeDelegate({ specialist: "test", task: "plan" }, createMockCtx(), vi.fn());
      expect(mockSetupPlanPanel).toHaveBeenCalledOnce();
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
});
