import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerPlanTool } from "./plan-tool";
import { setupPlanPanel, summarizeGoal } from "./plan-panel.ts";

vi.mock("./plan-panel.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./plan-panel.ts")>();
	return {
		...actual,
		setupPlanPanel: vi.fn(),
	};
});

function createMockPi() {
	const tools: any[] = [];
	return {
		registerTool: vi.fn((tool: any) => { tools.push(tool); }),
		getAllTools: () => tools,
	};
}

describe("registerPlanTool", () => {
	let tool: any;

	beforeEach(() => {
		const pi = createMockPi();
		registerPlanTool(pi as any);
		tool = pi.getAllTools()[0];
		vi.clearAllMocks();
	});

	it("uses the provided goal when non-empty", async () => {
		const ctx = { ui: { setWidget: vi.fn() } };
		const result = await tool.execute("call-1", { goal: "Fix auth bug", steps: ["Read auth.ts", "Update login"] }, undefined, () => {}, ctx);

		expect(result.content[0].text).toBe("Plan set: Fix auth bug (2 steps)");
		expect(result.details.goal).toBe("Fix auth bug");
		expect(setupPlanPanel).toHaveBeenCalledWith("Fix auth bug", ["Read auth.ts", "Update login"], ctx);
	});

	it("derives goal from steps when goal is empty", async () => {
		const steps = ["Read plan-tool.ts", "Implement fallback", "Run tests"];
		const expected = summarizeGoal(steps.join(" "));
		const ctx = { ui: { setWidget: vi.fn() } };

		const result = await tool.execute("call-2", { goal: "", steps }, undefined, () => {}, ctx);

		expect(result.details.goal).toBe(expected);
		expect(setupPlanPanel).toHaveBeenCalledWith(expected, steps, ctx);
	});

	it("treats whitespace-only goal as empty", async () => {
		const steps = ["Implement feature"];
		const expected = summarizeGoal(steps.join(" "));
		const ctx = { ui: { setWidget: vi.fn() } };

		const result = await tool.execute("call-3", { goal: "   ", steps }, undefined, () => {}, ctx);

		expect(result.details.goal).toBe(expected);
		expect(setupPlanPanel).toHaveBeenCalledWith(expected, steps, ctx);
	});

	it("falls back to Untitled plan when goal and steps are missing", async () => {
		const ctx = { ui: { setWidget: vi.fn() } };
		const result = await tool.execute("call-4", { goal: "", steps: [] }, undefined, () => {}, ctx);

		expect(result.content[0].text).toContain("Untitled plan");
		expect(setupPlanPanel).toHaveBeenCalledWith("Untitled plan", ["Planning..."], ctx);
	});

	it("renderCall derives goal from steps when goal is empty", () => {
		const text = tool.renderCall({ goal: "", steps: ["Read file", "Edit code"] }, {} as any, {} as any);
		const expected = summarizeGoal("Read file Edit code");
		expect((text as any).text).toContain(expected);
	});
});
