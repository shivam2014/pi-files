import { describe, it, expect } from "vitest";

describe("maxTurns budget", () => {
  it("DEFAULTS has maxTurns 30", async () => {
    const { DEFAULTS } = await import("./orchestrator-config.ts");
    expect(DEFAULTS.delegation.maxTurns).toBe(30);
  });
  it("timeoutMs is 600000", async () => {
    const { DEFAULTS } = await import("./orchestrator-config.ts");
    expect(DEFAULTS.delegation.parallel.timeoutMs).toBe(600000);
  });
});
