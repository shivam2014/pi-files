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

// ── rm -f over-match (round 4) ──
// The dangerous check must match a real recursive+force combo (flags only),
// not `-f` alone and not r/f letters inside a dash-containing OPERAND.

describe("isBlockedRmRecursive — rm flag combo detection (round 4)", () => {
  it("allows `rm -f /tmp/x` (force alone is not recursive)", () => {
    expect(getBashToolReplacement("rm -f /tmp/x")).toEqual({ allowed: true });
  });

  it("allows `rm -f <dash-containing operand naming r-then-f>` (old over-match)", () => {
    // Used to match /-[^ ]*r[^ ]*f/ via the OPERAND `capture-dir/reports-final.txt`
    // and blame it on "rm -rf is blocked".
    expect(getBashToolReplacement("rm -f /tmp/capture-dir/reports-final.txt")).toEqual({ allowed: true });
  });

  it("allows `rm -r /tmp/x` (recursive without force)", () => {
    expect(getBashToolReplacement("rm -r /tmp/x")).toEqual({ allowed: true });
  });

  it("still blocks `rm -rf <relative>` (combined flag)", () => {
    const r = getBashToolReplacement("rm -rf generated-dir");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("rm -rf is blocked");
  });

  it("blocks `rm -fr <path>` (combined, reversed order)", () => {
    const r = getBashToolReplacement("rm -fr /tmp/x");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("rm -rf is blocked");
  });

  it("blocks split `rm -r -f <path>` and `rm -f -r <path>`", () => {
    expect(getBashToolReplacement("rm -r -f /tmp/x").allowed).toBe(false);
    expect(getBashToolReplacement("rm -f -r /tmp/x").allowed).toBe(false);
  });

  it("blocks long-form `rm --recursive --force <path>`", () => {
    expect(getBashToolReplacement("rm --recursive --force /tmp/x").allowed).toBe(false);
  });

  it("does not block when `-r`/`-f` appear only after `--` (operands)", () => {
    expect(getBashToolReplacement("rm -f -- /tmp/-r-final.txt")).toEqual({ allowed: true });
  });

  it("`rm -rf /` stays blocked override-proof (dangerous, not just bypassable)", () => {
    expect(getBashToolReplacement("rm -rf /", true)).toEqual({
      allowed: false,
      reason:
        "Dangerous command blocked. This command cannot be executed even with override:true.",
    });
  });

  it("interceptor handler does not flag `rm -f /tmp/x` as dangerous", async () => {
    const interceptor = createBashInterceptor({ readOnly: false, blockDangerous: true });
    const ctx = { ui: { notify: vi.fn() } };
    const result = await interceptor.handler({ toolName: "bash", input: { command: "rm -f /tmp/x" } }, ctx);
    expect(result).toBeUndefined();
  });
});

// ── BUG-5: scoped /tmp exemptions (temp-scratch writes must not be redirected) ──

describe("getBashToolReplacement — BUG-5 scoped /tmp exemptions", () => {
  it("allows `mkdir -p /tmp/...` without redirecting to write tool", () => {
    const r = getBashToolReplacement("mkdir -p /tmp/orchestrator-debug");
    expect(r.allowed).toBe(true);
    expect(r.tool).toBeUndefined();
  });

  it("allows grep redirect into /tmp without redirecting to grep tool", () => {
    const r = getBashToolReplacement("grep -rn 'auth' src > /tmp/results.txt");
    expect(r.allowed).toBe(true);
    expect(r.tool).toBeUndefined();
  });

  it("allows heredoc/redirect writes into /tmp", () => {
    const r = getBashToolReplacement("cat > /tmp/findings.md");
    expect(r.allowed).toBe(true);
    expect(r.tool).toBeUndefined();
  });

  it("allows sed -i on /tmp files without redirecting to edit tool", () => {
    const r = getBashToolReplacement("sed -i 's/x/y/' /tmp/f.txt");
    expect(r.allowed).toBe(true);
    expect(r.tool).toBeUndefined();
  });

  it("still blocks dangerous commands even when they target /tmp", () => {
    const r = getBashToolReplacement("rm -rf /tmp/foo");
    expect(r.allowed).toBe(false);
  });

  it("still redirects non-temp grep to the grep tool (regression guard)", () => {
    const r = getBashToolReplacement("grep foo src/auth.ts");
    expect(r.allowed).toBe(true);
    expect(r.tool).toBe("grep");
  });

  it("still redirects pure reads from /tmp (no write indicator) to read tool", () => {
    const r = getBashToolReplacement("cat /tmp/notes.md");
    expect(r.allowed).toBe(true);
    expect(r.tool).toBe("read");
  });

  it("still redirects non-temp mkdir to write tool (regression guard)", () => {
    const r = getBashToolReplacement("mkdir -p src/generated");
    expect(r.allowed).toBe(true);
    expect(r.tool).toBe("write");
  });
});

// ── Round 5: read-only specialist diagnostics false positives ──
// createBashInterceptor({ readOnly: true }) must not block benign read-only
// diagnostics (basename-normalized binaries, pgrep/lsof, env-assignment
// prefixes, the ~/.pi/check-claim.sh read-only helper).

describe("createBashInterceptor — round 5 read-only diagnostics", () => {
  const run = (command: string) =>
    createBashInterceptor({ readOnly: true }).handler(
      { toolName: "bash", input: { command } },
      { ui: { notify: vi.fn() } },
    );

  it("allows `/bin/echo hi` (basename normalization)", async () => {
    expect(await run("/bin/echo hi")).toBeUndefined();
  });

  it("allows `CAPTURE_DIR=/tmp/x /bin/echo hi` (env-assignment prefix)", async () => {
    expect(await run("CAPTURE_DIR=/tmp/x /bin/echo hi")).toBeUndefined();
  });

  it("allows `pgrep -fl pi`", async () => {
    expect(await run("pgrep -fl pi")).toBeUndefined();
  });

  it("allows `lsof /some/file`", async () => {
    expect(await run("lsof /some/file")).toBeUndefined();
  });

  it("allows the `~/.pi/check-claim.sh` read-only helper", async () => {
    expect(await run("~/.pi/check-claim.sh")).toBeUndefined();
  });

  it("still blocks `/bin/rm -f x`", async () => {
    expect(await run("/bin/rm -f x")).toEqual({
      block: true,
      reason: "Write command blocked in read-only mode",
    });
  });

  it("still blocks redirects: `echo x > f`", async () => {
    expect(await run("echo x > f")).toEqual({
      block: true,
      reason: "Write command blocked in read-only mode",
    });
  });

  it("still blocks `~/.pi/claim.sh` (writes the claim file)", async () => {
    expect(await run("~/.pi/claim.sh orchestrator-ui-leaks")).toEqual({
      block: true,
      reason: "Write command blocked in read-only mode",
    });
  });
});
