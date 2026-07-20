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
