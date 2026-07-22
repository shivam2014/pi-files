import { describe, it, expect } from "vitest";
import type { ActivityFeedState } from "./types.ts";
import { renderTokenLine, renderActivityFeed } from "./activity-feed.ts";

// Theme is auto-initialized by vitest.setup.ts

function makeState(overrides: Partial<ActivityFeedState> = {}): ActivityFeedState {
	return {
		goal: "test",
		steps: [],
		currentStep: 0,
		rawText: "",
		planParsed: true,
		...overrides,
	};
}

describe("renderTokenLine", () => {
	it("renders all parts when all tokens present", () => {
		const line = renderTokenLine(makeState({
			tokenInput: 1000, tokenOutput: 500, tokenCached: 200,
			ctxTokens: 1700, ctxWindow: 128000,
		}));
		expect(line).toContain("↑");
		expect(line).toContain("⇄");
		expect(line).toContain("↓");
		expect(line).toContain("ctx");
		expect(line).toContain("/");
	});

	it("hides ⇄ when cacheRead is 0", () => {
		const line = renderTokenLine(makeState({
			tokenInput: 1000, tokenOutput: 500, tokenCached: 0,
			ctxTokens: 1500, ctxWindow: 128000,
		}));
		expect(line).toContain("↑");
		expect(line).not.toContain("⇄");
		expect(line).toContain("↓");
	});

	it("hides ⇄ when cacheRead is undefined", () => {
		const line = renderTokenLine(makeState({
			tokenInput: 1000, tokenOutput: 500,
			ctxTokens: 1500, ctxWindow: 128000,
		}));
		expect(line).not.toContain("⇄");
	});

	it("renders ctx without window when ctxWindow absent", () => {
		const line = renderTokenLine(makeState({
			tokenInput: 100, tokenOutput: 50,
			ctxTokens: 150,
		}));
		expect(line).toContain("ctx");
		expect(line).not.toContain("/");
	});

	it("formats k for thousands", () => {
		const line = renderTokenLine(makeState({
			tokenInput: 2700, tokenOutput: 903,
		}));
		expect(line).toContain("2.7k");
		expect(line).toContain("903");
	});

	it("formats M for millions", () => {
		const line = renderTokenLine(makeState({
			tokenInput: 1500000,
		}));
		expect(line).toContain("1.5M");
	});

	it("renders nothing when no token data", () => {
		const line = renderTokenLine(makeState());
		expect(line).toBe("");
	});

	it("renders frozen line on completion", () => {
		const line = renderTokenLine(makeState({
			tokenInput: 1000, tokenOutput: 500, tokenCached: 200,
			tokensFrozen: true,
		}));
		expect(line).toContain("↑");
		expect(line).toContain("⇄");
		expect(line).toContain("↓");
	});
});

describe("renderActivityFeed with token line", () => {
	it("includes token line in full render", () => {
		const state = makeState({
			goal: "Fix bug",
			steps: [{ label: "Step 1", completed: true, substeps: [] }],
			currentStep: 1,
			planParsed: true,
			tokenInput: 1000, tokenOutput: 500, tokenCached: 200,
			ctxTokens: 1700, ctxWindow: 128000,
		});
		const rendered = renderActivityFeed("coder", state);
		expect(rendered).toContain("↑");
		expect(rendered).toContain("⇄");
		expect(rendered).toContain("↓");
	});

	it("hides ⇄ in full render when cacheRead is 0", () => {
		const state = makeState({
			goal: "Fix bug",
			steps: [{ label: "Step 1", completed: true, substeps: [] }],
			currentStep: 1,
			planParsed: true,
			tokenInput: 1000, tokenOutput: 500, tokenCached: 0,
		});
		const rendered = renderActivityFeed("coder", state);
		expect(rendered).not.toContain("⇄");
	});
});
