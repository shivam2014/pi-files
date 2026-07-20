import { describe, it, expect } from "vitest";
import { validateTaskCapabilities } from "./delegate-pipeline";

describe("A2 capability-aware validation", () => {
  it("warns when researcher is told to write a file", () => {
    const r = validateTaskCapabilities("researcher", "write file X");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/cannot/i);
  });
  it("allows scout to find files (read/find in its toolset)", () => {
    const r = validateTaskCapabilities("scout", "find all files that import foo");
    expect(r.ok).toBe(true);
  });
  it("allows researcher to research docs (no write/bash needed)", () => {
    const r = validateTaskCapabilities("researcher", "research the docs about X");
    expect(r.ok).toBe(true);
  });
  it("warns when a read-only specialist is told to edit", () => {
    const r = validateTaskCapabilities("reviewer", "edit the config file");
    expect(r.ok).toBe(false);
  });
});
