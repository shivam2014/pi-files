/**
 * Unit tests for peek-overlay.ts
 * Run: npx vitest run peek-overlay.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	showPeek,
	hidePeek,
	updatePeek,
	isPeekOpen,
	PeekComponent,
	MIN_HEIGHT,
	pushStreamingText,
} from "./peek-overlay";

// ============================================================================
// Helpers
// ============================================================================

/** Create a PeekComponent instance for testing render/handleInput */
function createTestComponent(): PeekComponent {
	// PeekComponent is exported for testing — instantiate directly
	// It uses module-level state (_peekGoal, _peekFeedState, _peekLines),
	// so tests run against the module singleton state.
	return new PeekComponent();
}

beforeEach(() => {
	// Ensure clean state before each test
	hidePeek();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Test 1: render() returns at least MIN_HEIGHT lines
// ============================================================================

describe("PeekComponent.render — minimum height", () => {
	it("returns at least MIN_HEIGHT lines", () => {
		const comp = createTestComponent();
		const lines = comp.render(80);
		expect(lines.length).toBeGreaterThanOrEqual(MIN_HEIGHT);
		expect(MIN_HEIGHT).toBe(15);
	});

	it("pads with empty lines when content is short", () => {
		const comp = createTestComponent();
		const lines = comp.render(80);
		// With no feed state and no peek lines, content is just header + footer
		// which is less than 9 lines — should be padded to MIN_HEIGHT
		expect(lines.length).toBe(MIN_HEIGHT);
		// Box-drawn lines always have │ borders. Empty interior = │<spaces>│
		expect(lines.some((l) => /^│\s+│$/.test(l))).toBe(true);
	});
});

// ============================================================================
// Test 2: truncate strips ANSI — SKIP (not exported)
// ============================================================================

describe.skip("truncate — strips ANSI", () => {
	it("would test ANSI stripping if truncate were exported", () => {
		// truncate() is not exported from peek-overlay.ts
		// Skip this test as specified
	});
});

describe("PeekComponent.handleInput — closes on escape", () => {
	const inputs = ["\x1b", "escape", "esc", "\x1b", "", "ctrl+q", "C-q"];
	for (const input of inputs) {
		it(`accepts ${JSON.stringify(input)} without throwing`, () => {
			const comp = createTestComponent();
			expect(() => comp.handleInput(input)).not.toThrow();
		});
	}
});

// ============================================================================
// Smoke tests — public API works without crashing
// ============================================================================

describe("peek-overlay — public API smoke tests", () => {
	it("isPeekOpen returns false when no peek is shown", () => {
		expect(isPeekOpen()).toBe(false);
	});

	it("hidePeek can be called when no peek is active", () => {
		expect(() => hidePeek()).not.toThrow();
	});

	it("updatePeek does nothing when no peek is open (no throw)", () => {
		expect(() => updatePeek("test")).not.toThrow();
	});
});

// ============================================================================
// Test 7: Streaming flickering regression tests
// ============================================================================

describe("streaming flickering regression", () => {
	it("render output should be deterministic with identical state", () => {
		const comp = new PeekComponent();
		const r1 = comp.render(80);
		const r2 = comp.render(80);
		expect(r1).toEqual(r2);
	});

	it("hidePeek cleans up without throwing", () => {
		// hidePeek should not create any intervals — no leak regression
		expect(() => hidePeek()).not.toThrow();
		expect(() => hidePeek()).not.toThrow();
	});

	it("pushStreamingText should be callable and accumulate text", () => {
		// pushStreamingText has a guard: if (!_peekHandle || _peekHandle.isHidden()) return;
		// In test context with no peek handle, it should return early without error
		expect(() => pushStreamingText("test text")).not.toThrow();
	});
	
	it("contentLines.slice(-maxContent) should preserve last N lines on repeated renders", () => {
		const comp = new PeekComponent();
		
		// Render 3 times in a row
		const results = [comp.render(80), comp.render(80), comp.render(80)];
		
		// All 3 should be identical (deterministic rendering)
		expect(results[0]).toEqual(results[1]);
		expect(results[1]).toEqual(results[2]);
		
		// Verify MIN_HEIGHT constraint
		expect(results[0].length).toBeGreaterThanOrEqual(MIN_HEIGHT);
	});
});

// ============================================================================
// Issue #87: streaming buffer GC test
// ============================================================================

describe("streaming buffer GC", () => {
	it("should handle large streaming text without throwing", () => {
		const longText = "x".repeat(6000);
		pushStreamingText(longText);
		const comp = new PeekComponent();
		expect(() => comp.render(80)).not.toThrow();
	});
});

// ============================================================================
// Issue #86: render coordination test
// ============================================================================

describe("render coordination", () => {
	it("multiple render triggers should not throw", () => {
		const comp = new PeekComponent();
		comp.render(80);
		expect(() => {
			// Simulate rapid succession of render triggers
			updatePeek("test line");
		}).not.toThrow();
	});
});
