import { describe, it, expect } from "vitest";
import { SPECIALISTS } from "./specialists";

describe("A1 subagent prompt audit", () => {
  it("scout prompt contains no orchestrator tool docs", () => {
    const p = SPECIALISTS.scout.systemPrompt;
    expect(p).not.toContain("delegate(");
    expect(p).not.toContain("fusion(");
    expect(p).not.toContain("plan(");
  });
  it("every specialist prompt declares what it cannot do", () => {
    for (const name of Object.keys(SPECIALISTS)) {
      expect(SPECIALISTS[name].systemPrompt, name).toMatch(/You do NOT have/i);
    }
  });
});

describe("researcher web toolset", () => {
  it("researcher carries the atomic store/retrieve web tools", () => {
    const tools = SPECIALISTS.researcher.tools;
    expect(tools).toContain("web_search");
    expect(tools).toContain("fetch_content");
    expect(tools).toContain("get_search_content");
  });

  it("get_search_content stays read-only (no mutation tools on researcher)", () => {
    const tools = SPECIALISTS.researcher.tools;
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("bash");
  });
});
