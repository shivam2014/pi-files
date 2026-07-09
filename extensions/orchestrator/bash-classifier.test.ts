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
  it("blocks 2> redirection", () => expect(isWriteCommand("cmd 2> error.log")).toBe(true));
  
  // Edge cases
  it("blocks rm -rf /", () => expect(isWriteCommand("rm -rf /")).toBe(true));
  it("allows git status", () => expect(isWriteCommand("git status")).toBe(false));
  it("allows git log", () => expect(isWriteCommand("git log")).toBe(false));
  it("allows git diff", () => expect(isWriteCommand("git diff")).toBe(false));
  it("blocks git checkout (can modify files)", () => expect(isWriteCommand("git checkout .")).toBe(true));
});
