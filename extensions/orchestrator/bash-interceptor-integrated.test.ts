import { describe, it, expect, vi, beforeEach } from "vitest";
import { createIntegratedBashInterceptor } from "./bash-interceptor-integrated";

describe("createIntegratedBashInterceptor", () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      ui: { notify: vi.fn() },
    };
  });

  const mockEvent = (command: string, specialist?: string) => ({
    toolName: "bash",
    input: { command },
    toolCallId: "test-123",
    specialist,
  });

  // Reviewer specialist (has bash, but read-only — no edit/write tools)
  it("blocks write commands for reviewer", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("rm file.txt", "reviewer");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toEqual({ block: true, reason: "Write command blocked for read-only specialist" });
  });

  it("allows read commands for reviewer", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("ls -la", "reviewer");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toBeUndefined();
  });

  // Coder specialist (read-write — has bash + edit + write)
  it("allows write commands for coder", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("rm file.txt", "coder");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toBeUndefined();
  });

  it("blocks dangerous commands for coder", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("rm -rf /", "coder");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toEqual({ block: true, reason: "Dangerous command blocked" });
  });

  // Scout specialist (no bash access — read-only)
  it("blocks write commands for scout", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("mv file1 file2", "scout");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toEqual({ block: true, reason: "Write command blocked for read-only specialist" });
  });

  it("allows read commands for scout", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("grep pattern file", "scout");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toBeUndefined();
  });

  // Unknown specialist (not in SPECIALISTS registry — defaults to read-only)
  it("blocks write commands for unknown specialist", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("rm file.txt", "unknown-specialist");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toEqual({ block: true, reason: "Write command blocked for read-only specialist" });
  });

  // No specialist (undefined — defaults to read-only)
  it("blocks write commands when no specialist specified", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("rm file.txt");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toEqual({ block: true, reason: "Write command blocked for read-only specialist" });
  });

  // Non-bash tool calls should pass through
  it("ignores non-bash tool calls", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = { toolName: "read", input: { path: "/etc/passwd" }, toolCallId: "test-456" };
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toBeUndefined();
  });

  // Dangerous commands always blocked regardless of specialist
  it("blocks dangerous commands for reviewer", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("git push --force origin main", "reviewer");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toEqual({ block: true, reason: "Dangerous command blocked" });
  });

  it("blocks dangerous commands for unknown specialist", async () => {
    const interceptor = createIntegratedBashInterceptor();
    const event = mockEvent("sudo rm -rf /", "unknown-specialist");
    const result = await interceptor.handler(event, mockCtx);
    expect(result).toEqual({ block: true, reason: "Dangerous command blocked" });
  });
});
