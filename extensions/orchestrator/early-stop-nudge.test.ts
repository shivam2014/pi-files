import { describe, it, expect } from "vitest";
import { shouldNudge } from "./subagent-runner.ts";

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
