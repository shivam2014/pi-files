import { describe, it, expect, beforeEach } from "vitest";
import { setupPlanPanel, clearPlanPanel, hasActivePlan, _resolveCtx, _instances } from "./plan-panel.js";
import type { SessionContext } from "./types.js";

// Mock ui.setWidget for all tests
const mockSetWidget = () => {};
const mockCtx = (sessionId: string): SessionContext => ({
  sessionManager: { sessionId } as any,
  ui: { setWidget: mockSetWidget } as any,
} as any);

describe("PlanPanel singleton isolation", () => {
  beforeEach(() => {
    // Clear all instances between tests
    _instances.clear();
  });

  it("creates separate PlanPanel instances for different session IDs", () => {
    const ctx1 = mockCtx("session-1");
    const ctx2 = mockCtx("session-2");

    setupPlanPanel("Goal 1", ["step1"], ctx1);
    setupPlanPanel("Goal 2", ["step2"], ctx2);

    const panel1 = _resolveCtx(ctx1);
    const panel2 = _resolveCtx(ctx2);

    expect(panel1).not.toBe(panel2);
    expect(hasActivePlan(ctx1)).toBe(true);
    expect(hasActivePlan(ctx2)).toBe(true);
  });

  it("clearing one session does not affect another", () => {
    const ctx1 = mockCtx("session-1");
    const ctx2 = mockCtx("session-2");

    setupPlanPanel("Goal 1", ["step1"], ctx1);
    setupPlanPanel("Goal 2", ["step2"], ctx2);

    clearPlanPanel(ctx1);

    expect(hasActivePlan(ctx1)).toBe(false);
    expect(hasActivePlan(ctx2)).toBe(true);
  });

  it("_instances map grows when sessions are added", () => {
    const ctx1 = mockCtx("s1");
    const ctx2 = mockCtx("s2");

    expect(_instances.size).toBe(0);

    setupPlanPanel("G1", ["s1"], ctx1);
    expect(_instances.size).toBe(1);

    setupPlanPanel("G2", ["s2"], ctx2);
    expect(_instances.size).toBe(2);
  });
});
