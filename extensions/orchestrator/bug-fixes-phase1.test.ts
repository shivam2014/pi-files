import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./bash-interceptor.ts", () => ({
  getBashToolReplacement: vi.fn(() => ({ allowed: true })),
}));

vi.mock("./bash-classifier.ts", () => ({
  isWriteCommand: vi.fn(() => false),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  isToolCallEventType: vi.fn(() => true),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn() };
});

vi.mock("node:path", () => ({
  resolve: (...args: string[]) => args.join("/"),
  join: (...args: string[]) => args.join("/"),
}));

// ScopeGuard mock — isPathAllowed returns FALSE to simulate real scope enforcement
const ScopeGuardMock = vi.hoisted(() => vi.fn() as any);
ScopeGuardMock.mockImplementation(function (this: any, _cwd: string) {
  this.isScopeValid = () => true;
  this.isPathAllowed = vi.fn(() => ({ allowed: false, reason: "outside scope" }));
  this.checkFileSize = () => ({ allowed: true });
  this.requestExpansion = () => null;
});
vi.mock("./scope-guard.ts", () => ({ ScopeGuard: ScopeGuardMock }));

import { handleSubagentToolCall } from "./subagent-tool-guard";
import type { SubagentState } from "./subagent-sessions";

function subagentState(planParsed = true): SubagentState {
  return { specialistName: "coder", planParsed };
}

// Correct signature: handleSubagentToolCall(event, fusionEnabled, ctx?, subagentState?)
// ctx: { cwd?: string; readOnly?: boolean }

describe("Bug fixes phase 1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Bug 1: git commit -m message should not trigger scope check", () => {
    it("should NOT block git commit with a commit message referencing a file", () => {
      const event = {
        toolName: "bash",
        input: { command: 'git commit -m "fix delegate-pipeline.ts"' },
      };

      const result = handleSubagentToolCall(event, true, { cwd: "/tmp" }, subagentState());

      expect(result?.block).toBeFalsy();
    });

    it("should NOT call isPathAllowed with the commit message content", () => {
      const event = {
        toolName: "bash",
        input: { command: 'git commit -m "fix delegate-pipeline.ts"' },
      };

      handleSubagentToolCall(event, true, { cwd: "/tmp" }, subagentState());

      const instance = ScopeGuardMock.mock.instances[0];
      expect(instance).toBeDefined();
      const calls = instance.isPathAllowed.mock.calls.map((c: any[]) => String(c[0]));
      expect(calls.some((c: string) => c.includes("delegate-pipeline"))).toBe(false);
    });
  });

  describe("Bug 2: npx vitest run should not treat test file arg as scope path", () => {
    it("should NOT block npx vitest run with a test file argument", () => {
      const event = {
        toolName: "bash",
        input: { command: "npx vitest run foo.test.ts" },
      };

      const result = handleSubagentToolCall(event, true, { cwd: "/tmp" }, subagentState());

      // This should NOT be blocked — test runner commands are not file writes
      expect(result?.block).toBeFalsy();
    });

    it("should NOT call isPathAllowed with the test file name", () => {
      const event = {
        toolName: "bash",
        input: { command: "npx vitest run foo.test.ts" },
      };

      handleSubagentToolCall(event, true, { cwd: "/tmp" }, subagentState());

      const instance = ScopeGuardMock.mock.instances[0];
      expect(instance).toBeDefined();
      const calls = instance.isPathAllowed.mock.calls.map((c: any[]) => String(c[0]));
      expect(calls.some((c: string) => c.includes("foo.test.ts"))).toBe(false);
    });

    it("should NOT block npm test with a test file argument", () => {
      const event = {
        toolName: "bash",
        input: { command: "npm test -- foo.test.ts" },
      };

      const result = handleSubagentToolCall(event, true, { cwd: "/tmp" }, subagentState());

      expect(result?.block).toBeFalsy();
    });

    it("should NOT block npx jest with a test file argument", () => {
      const event = {
        toolName: "bash",
        input: { command: "npx jest foo.test.ts" },
      };

      const result = handleSubagentToolCall(event, true, { cwd: "/tmp" }, subagentState());

      expect(result?.block).toBeFalsy();
    });
  });

  describe("Bug 3: debug-path-trace should snapshot input at call time", () => {
    it("should log the original path, not a mutated one", async () => {
      const { enablePathTrace, traceToolCallEntry } = await import("./debug-path-trace");
      enablePathTrace();

      const sharedInput: any = { path: "original-file.ts" };
      const event = { toolName: "read", input: sharedInput };

      traceToolCallEntry("test", event, { cwd: "/tmp" });

      // Mutate after trace call
      sharedInput.path = "mutated-file.ts";

      const realReaddir = (await vi.importActual<typeof import("node:fs")>("node:fs")).readdirSync;
      const realReadFile = (await vi.importActual<typeof import("node:fs")>("node:fs")).readFileSync;

      let logContent = "";
      try {
        const files = realReaddir("/tmp/orchestrator-debug") as string[];
        const logFiles = files.filter((f: string) => f.startsWith("path-trace-"));
        if (logFiles.length > 0) {
          const latest = logFiles.sort().pop()!;
          logContent = realReadFile(`/tmp/orchestrator-debug/${latest}`, "utf-8") as string;
        }
      } catch {
        // If read fails, test will fail
      }

      expect(logContent).toContain("original-file.ts");
    });
  });
});
