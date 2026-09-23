import { describe, it, expect } from "vitest";
import { isWriteCommand } from "./bash-classifier";

describe("isWriteCommand", () => {
  // Read commands (should return false)
  it("allows ls", () => expect(isWriteCommand("ls")).toBe(false));
  it("allows cat", () => expect(isWriteCommand("cat file.txt")).toBe(false));
  it("allows grep", () => expect(isWriteCommand("grep pattern file")).toBe(false));
  it("allows find", () => expect(isWriteCommand("find . -name '*.ts'")).toBe(false));
  it("allows head", () => expect(isWriteCommand("head -n 10 file")).toBe(false));
  it("allows tail", () => expect(isWriteCommand("tail -n 10 file")).toBe(false));
  it("allows wc", () => expect(isWriteCommand("wc -l file")).toBe(false));
  it("allows echo", () => expect(isWriteCommand("echo hello")).toBe(false));
  it("allows pwd", () => expect(isWriteCommand("pwd")).toBe(false));
  it("allows date", () => expect(isWriteCommand("date")).toBe(false));
  
  // Write commands (should return true)
  it("blocks rm", () => expect(isWriteCommand("rm file.txt")).toBe(true));
  it("blocks mv", () => expect(isWriteCommand("mv file1 file2")).toBe(true));
  it("blocks cp", () => expect(isWriteCommand("cp file1 file2")).toBe(true));
  it("blocks git push", () => expect(isWriteCommand("git push")).toBe(true));
  it("blocks git commit", () => expect(isWriteCommand("git commit -m 'msg'")).toBe(true));
  it("blocks tee", () => expect(isWriteCommand("tee file.txt")).toBe(true));
  it("blocks chmod", () => expect(isWriteCommand("chmod 755 file")).toBe(true));
  it("blocks mkdir", () => expect(isWriteCommand("mkdir dir")).toBe(true));
  it("blocks touch", () => expect(isWriteCommand("touch file.txt")).toBe(true));
  
  // Output redirection (should return true)
  it("blocks > redirection", () => expect(isWriteCommand("echo hello > file.txt")).toBe(true));
  it("blocks >> redirection", () => expect(isWriteCommand("echo hello >> file.txt")).toBe(true));
  // Stderr-only redirection should NOT be blocked (just suppressing noise)
  it("allows ls 2> error.log", () => expect(isWriteCommand("ls 2> error.log")).toBe(false));
  it("allows find with 2>/dev/null", () => expect(isWriteCommand("find /path -name '*.ts' 2>/dev/null")).toBe(false));
  
  // Combined stdout+stderr redirection SHOULD be blocked
  it("blocks &> combined redirection", () => expect(isWriteCommand("cmd &> /dev/null")).toBe(true));
  it("blocks > with 2>&1 combined", () => expect(isWriteCommand("cmd > /dev/null 2>&1")).toBe(true));
  it("blocks stdout+stderr redirect", () => expect(isWriteCommand("echo hello > /tmp/file 2>/dev/null")).toBe(true));
  
  // Stderr redirect only on known read commands
  it("allows echo 2>/dev/null", () => expect(isWriteCommand("echo hello 2>/dev/null")).toBe(false));
  it("allows cat file 2>/dev/null", () => expect(isWriteCommand("cat file 2>/dev/null")).toBe(false));
  
  // Edge cases
  it("blocks rm -rf /", () => expect(isWriteCommand("rm -rf /")).toBe(true));
  it("allows git status", () => expect(isWriteCommand("git status")).toBe(false));
  it("allows git log", () => expect(isWriteCommand("git log")).toBe(false));
  it("allows git diff", () => expect(isWriteCommand("git diff")).toBe(false));
  it("blocks git checkout (can modify files)", () => expect(isWriteCommand("git checkout .")).toBe(true));
});

describe("package manager test runners", () => {
  it("allows npx vitest", () => expect(isWriteCommand("npx vitest run")).toBe(false));
  it("allows npx jest", () => expect(isWriteCommand("npx jest")).toBe(false));
  it("allows npm test", () => expect(isWriteCommand("npm test")).toBe(false));
  it("allows npm run test", () => expect(isWriteCommand("npm run test")).toBe(false));
  it("allows yarn test", () => expect(isWriteCommand("yarn test")).toBe(false));
  it("allows pnpm vitest", () => expect(isWriteCommand("pnpm vitest")).toBe(false));
  it("allows npx tsc --noEmit", () => expect(isWriteCommand("npx tsc --noEmit")).toBe(false));
  it("allows npx eslint", () => expect(isWriteCommand("npx eslint src/")).toBe(false));
  it("allows npx vitest no args", () => expect(isWriteCommand("npx vitest")).toBe(false));
  it("blocks npm publish", () => expect(isWriteCommand("npm publish")).toBe(true));
  it("blocks npm run build", () => expect(isWriteCommand("npm run build")).toBe(true));
  it("blocks npx some-random-binary", () => expect(isWriteCommand("npx some-binary")).toBe(true));
});

describe("quote-aware redirects and wrapper classification (guard-hardening)", () => {
  it('does not treat " > " inside quotes as a redirect', () => {
    expect(isWriteCommand('git log --format="%h > %s" -n 5')).toBe(false);
  });
  it('does not treat a quoted literal in a grep pattern as a redirect', () => {
    expect(isWriteCommand('grep -rn "rm -rf /" docs/')).toBe(false);
  });
  it("keeps unquoted redirects as writes", () => {
    expect(isWriteCommand("cat src/index.ts > /tmp/out.txt")).toBe(true);
  });
  it("classifies ps as read", () => expect(isWriteCommand("ps aux")).toBe(false));
  it("classifies rg as read", () => expect(isWriteCommand("rg -n pattern src/")).toBe(false));
  it("classifies git --version as read", () => expect(isWriteCommand("git --version")).toBe(false));
  it("classifies sed -i as write", () => expect(isWriteCommand("sed -i '' 's/a/b/' src/index.ts")).toBe(true));
  it("keeps sed without -i as read", () => expect(isWriteCommand("sed -n '1,10p' src/index.ts")).toBe(false));
  it("classifies `bash ls -la` as read (wrapper recursion)", () => expect(isWriteCommand("bash ls -la")).toBe(false));
  it("classifies `bash -c …` as write (opaque payload, fail closed)", () => expect(isWriteCommand('bash -c "rm -rf /tmp/x"')).toBe(true));
});

describe("round 3 — read-only tool allowlist (read-only specialist false positives)", () => {
  it("classifies shasum as read", () => expect(isWriteCommand("shasum -a 256 /work/root/repo/src/index.ts")).toBe(false));
  it("classifies diff as read", () => expect(isWriteCommand("diff -q a.ts b.ts")).toBe(false));
  it("classifies cmp as read", () => expect(isWriteCommand("cmp a.ts b.ts")).toBe(false));
  it("classifies tail -40 as read", () => expect(isWriteCommand("tail -40 /work/root/repo/build.log")).toBe(false));
  it("classifies wc -l as read", () => expect(isWriteCommand("wc -l /work/root/repo/src/index.ts")).toBe(false));
  it("classifies stat as read", () => expect(isWriteCommand("stat /work/root/repo/src/index.ts")).toBe(false));
  it("classifies sort -rn as read", () => expect(isWriteCommand("sort -rn")).toBe(false));
  // Compounds: the classifier decides from the BASE command; the guard splits
  // segments at `|` before classifying, so a pipeline of read verbs stays read.
  it("classifies `stat | tail` as read (base verb, guard splits segments)", () =>
    expect(isWriteCommand("stat | tail")).toBe(false));
  it("classifies `stat | sort -rn | head` as read", () =>
    expect(isWriteCommand("stat | sort -rn | head")).toBe(false));
  it("classifies `ps aux | tail -3` as read", () => expect(isWriteCommand("ps aux | tail -3")).toBe(false));
  // Regression guard: the unknown-command default must stay WRITE.
  it("still classifies unknown commands as write", () => expect(isWriteCommand("frobnicate --flag")).toBe(true));
  it("still classifies `diff` with a redirect as write", () =>
    expect(isWriteCommand("diff -q a.ts b.ts > /tmp/d.txt")).toBe(true));
});
