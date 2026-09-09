import { describe, it, expect } from "vitest";
import { shouldNudge } from "./subagent-runner.ts";
import { hasDeliverableMarkers, isCleanCompleteStop } from "./subagent-runner.ts";

describe("shouldNudge", () => {
	it("returns true when stop + incomplete + not yet nudged", () => {
		expect(shouldNudge("stop", true, false)).toBe(true);
	});

	it("returns false when already nudged (second stop passes through)", () => {
		expect(shouldNudge("stop", true, true)).toBe(false);
	});

	it("returns false when steps are complete", () => {
		expect(shouldNudge("stop", false, false)).toBe(false);
	});

	it("returns false for error stop reason even with incomplete steps", () => {
		expect(shouldNudge("error", true, false)).toBe(false);
	});

	it("returns false for empty stopReason", () => {
		expect(shouldNudge("", true, false)).toBe(false);
	});

	it("returns false for other stop reasons (e.g. max_tokens)", () => {
		expect(shouldNudge("max_tokens", true, false)).toBe(false);
	});
});

// ── C1: a clean stop with deliverable markers must never be stall-evaluated ──
describe("hasDeliverableMarkers", () => {
	it("detects the canonical deliverable headings", () => {
		expect(hasDeliverableMarkers("## Completed\nAll done")).toBe(true);
		expect(hasDeliverableMarkers("some prose\n\n## Findings\n- thing")).toBe(true);
		expect(hasDeliverableMarkers("## Files Changed\n- src/x.ts")).toBe(true);
	});

	it("returns false for output without any deliverable marker", () => {
		expect(hasDeliverableMarkers("")).toBe(false);
		expect(hasDeliverableMarkers("partial thoughts only")).toBe(false);
	});
});

describe("isCleanCompleteStop (C1 guard)", () => {
	const report = "## Completed\nDone.\n\n## Findings\n- ok\n\n## Audit\n- clean";

	it("true for clean stop + complete steps + deliverable output (quiet-tail success)", () => {
		expect(isCleanCompleteStop("stop", false, report)).toBe(true);
	});

	it("false when steps remain incomplete (early-stop nudge path still applies)", () => {
		expect(isCleanCompleteStop("stop", true, report)).toBe(false);
	});

	it("false when no deliverable markers in output", () => {
		expect(isCleanCompleteStop("stop", false, "half-written text")).toBe(false);
	});

	it("false for error/empty stop reasons even with deliverables", () => {
		expect(isCleanCompleteStop("error", false, report)).toBe(false);
		expect(isCleanCompleteStop(undefined, false, report)).toBe(false);
	});
});
