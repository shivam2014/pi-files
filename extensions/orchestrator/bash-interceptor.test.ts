import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createBashInterceptor,
  getBashToolReplacement,
  isWriteModifyingCommand,
} from "./bash-interceptor";

// ── createBashInterceptor ──

describe("createBashInterceptor", () => {
  let mockCtx: any;
  let mockEvent: any;

  beforeEach(() => {
    mockCtx = { ui: { notify: vi.fn() } };
    mockEvent = (command: string, specialist?: string) => ({
      toolName: "bash",
      input: { command },
      toolCallId: "test-123",
      specialist,
    });
  });

  it("allows read commands in read-only mode", async () => {
    const interceptor = createBashInterceptor({ readOnly: true });
    const result = await interceptor.handler(mockEvent("ls -la"), mockCtx);
    expect(result).toBeUndefined();
  });

  it("blocks write commands in read-only mode", async () => {
    const interceptor = createBashInterceptor({ readOnly: true });
    const result = await interceptor.handler(mockEvent("rm file.txt"), mockCtx);
    expect(result).toEqual({ block: true, reason: "Write command blocked in read-only mode" });
  });

  it("allows write commands in read-write mode", async () => {
    const interceptor = createBashInterceptor({ readOnly: false });
    const result = await interceptor.handler(mockEvent("rm file.txt"), mockCtx);
    expect(result).toBeUndefined();
  });

  it("blocks dangerous commands even in read-write mode", async () => {
    const interceptor = createBashInterceptor({ readOnly: false, blockDangerous: true });
    const result = await interceptor.handler(mockEvent("rm -rf /"), mockCtx);
    expect(result).toEqual({ block: true, reason: "Dangerous command blocked" });
  });

  it("logs blocked commands", async () => {
    const interceptor = createBashInterceptor({ readOnly: true });
    await interceptor.handler(mockEvent("rm file.txt"), mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Blocked"),
      "warning",
    );
  });

  it("ignores non-bash tool calls", async () => {
    const interceptor = createBashInterceptor({ readOnly: true });
    const result = await interceptor.handler({ toolName: "read", input: { path: "file.txt" } }, mockCtx);
    expect(result).toBeUndefined();
  });
});

// ── isWriteModifyingCommand ──

describe("isWriteModifyingCommand", () => {
  it("returns false for undefined", () => {
    expect(isWriteModifyingCommand(undefined)).toBe(false);
  });

  it("returns true for rm", () => {
    expect(isWriteModifyingCommand("rm file.txt")).toBe(true);
  });

  it("returns true for output redirection", () => {
    expect(isWriteModifyingCommand("echo hi > file.txt")).toBe(true);
  });

  it("returns false for ls", () => {
    expect(isWriteModifyingCommand("ls -la")).toBe(false);
  });

  it("returns false for cat", () => {
    expect(isWriteModifyingCommand("cat file.txt")).toBe(false);
  });
});

// ── getBashToolReplacement ──

describe("getBashToolReplacement", () => {
  it("returns allowed:true when override is true", () => {
    expect(getBashToolReplacement("cat file", true)).toEqual({ allowed: true });
  });

  it("returns allowed:true when command is undefined", () => {
    expect(getBashToolReplacement(undefined)).toEqual({ allowed: true });
  });

  it("redirects cat to read", () => {
    expect(getBashToolReplacement("cat file.txt")).toEqual({ allowed: true, tool: "read" });
  });

  it("redirects grep to grep", () => {
    expect(getBashToolReplacement("grep -r foo .")).toEqual({ allowed: true, tool: "grep" });
  });

  it("redirects rg to grep", () => {
    expect(getBashToolReplacement("rg -r foo .")).toEqual({ allowed: true, tool: "grep" });
  });

  it("redirects find to find", () => {
    expect(getBashToolReplacement("find . -name '*.ts'")).toEqual({ allowed: true, tool: "find" });
  });

  it("redirects ls to ls", () => {
    expect(getBashToolReplacement("ls -la")).toEqual({ allowed: true, tool: "ls" });
  });

  it("redirects mkdir to write", () => {
    expect(getBashToolReplacement("mkdir -p dir")).toEqual({ allowed: true, tool: "write" });
  });

  it("redirects touch to write", () => {
    expect(getBashToolReplacement("touch file.txt")).toEqual({ allowed: true, tool: "write" });
  });

  it("redirects sed -i to edit", () => {
    expect(getBashToolReplacement("sed -i 's/foo/bar/' file")).toEqual({ allowed: true, tool: "edit" });
  });

  it("allows sed without -i", () => {
    expect(getBashToolReplacement("sed 's/foo/bar/' file")).toEqual({ allowed: true });
  });

  it("redirects python with write indicator to edit", () => {
    expect(getBashToolReplacement("python -c \"open('f.txt','w')\"")).toEqual({ allowed: true, tool: "edit" });
  });

  it("allows python without write indicator", () => {
    expect(getBashToolReplacement("python script.py")).toEqual({ allowed: true });
  });

  it("allows node without write indicator", () => {
    expect(getBashToolReplacement("node script.js")).toEqual({ allowed: true });
  });

  it("redirects node with write indicator to edit", () => {
    expect(getBashToolReplacement("node -e \"fs.writeFile('x',data)\"")).toEqual({ allowed: true, tool: "edit" });
  });

  it("returns allowed:true for unknown commands", () => {
    expect(getBashToolReplacement("docker build .")).toEqual({ allowed: true });
  });

  it("blocks rm -rf with message", () => {
    const result = getBashToolReplacement("rm -rf /");
    expect(result).toEqual({
      allowed: false,
      reason:
        "Dangerous command blocked. This command cannot be executed even with override:true.",
    });
  });
});
