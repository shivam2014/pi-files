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
