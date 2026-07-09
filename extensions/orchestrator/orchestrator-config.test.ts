import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	DEFAULTS,
	_sessionModes,
	_currentDefaultMode,
	_extractSessionId,
	_parseYaml,
	getSessionMode,
	setSessionMode,
	clearSessionMode,
} from "./orchestrator-config.ts";

// ─── _extractSessionId ─────────────────────────────────────

describe("_extractSessionId", () => {
	it("returns undefined for null", () => {
		expect(_extractSessionId(null)).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(_extractSessionId(undefined)).toBeUndefined();
	});

	it("returns undefined for non-object", () => {
		expect(_extractSessionId("string")).toBeUndefined();
		expect(_extractSessionId(42)).toBeUndefined();
		expect(_extractSessionId(true)).toBeUndefined();
	});

	it("returns undefined when ctx has no sessionManager", () => {
		expect(_extractSessionId({})).toBeUndefined();
	});

	it("returns undefined when sessionManager is not an object", () => {
		expect(_extractSessionId({ sessionManager: "invalid" })).toBeUndefined();
	});

	it("returns undefined when sessionManager has no sessionId", () => {
		expect(_extractSessionId({ sessionManager: {} })).toBeUndefined();
	});

	it("returns sessionId from valid ctx", () => {
		const ctx = { sessionManager: { sessionId: "abc-123" } };
		expect(_extractSessionId(ctx)).toBe("abc-123");
	});
});

// ─── _parseYaml ────────────────────────────────────────────

describe("_parseYaml", () => {
	it("parses simple key-value pairs", () => {
		const raw = "version: 1\ndelegation:\n  mode: sequential\n";
		const result = _parseYaml(raw);
		expect(result.version).toBe(1);
		expect(result.delegation).toEqual({ mode: "sequential" });
	});

	it("parses nested sections", () => {
		const raw = [
			"version: 1",
			"delegation:",
			"  mode: parallel",
			"  parallel:",
			"    maxConcurrent: 8",
			"    timeoutMs: 60000",
			"",
		].join("\n");
		const result = _parseYaml(raw);
		expect(result.version).toBe(1);
		expect(result.delegation).toEqual({
			mode: "parallel",
			parallel: { maxConcurrent: 8, timeoutMs: 60000 },
		});
	});

	it("handles comments and empty lines", () => {
		const raw = "# top comment\nversion: 1\n\n# inline comment\n";
		const result = _parseYaml(raw);
		expect(result.version).toBe(1);
	});

	it("parses string values with quotes", () => {
		const raw = 'name: "hello world"\nmode: \'test\'\n';
		const result = _parseYaml(raw);
		expect(result.name).toBe("hello world");
		expect(result.mode).toBe("test");
	});

	it("parses boolean values", () => {
		const raw = "enabled: true\ndisabled: false\n";
		const result = _parseYaml(raw);
		expect(result.enabled).toBe(true);
		expect(result.disabled).toBe(false);
	});

	it("throws on line without colon", () => {
		expect(() => _parseYaml("no_colon_here\n")).toThrow('Malformed YAML line: "no_colon_here"');
	});

	it("throws on nested line without colon", () => {
		const raw = "section:\n  bad_line_no_colon\n";
		expect(() => _parseYaml(raw)).toThrow('Malformed YAML line: "bad_line_no_colon"');
	});
});

// ─── getSessionMode / setSessionMode ────────────────────────

describe("getSessionMode", () => {
	beforeEach(() => {
		_sessionModes.clear();
	});

	it("returns default mode when no session context", () => {
		expect(getSessionMode(null)).toBe(DEFAULTS.delegation.mode);
	});

	it("returns default mode for unknown session", () => {
		const ctx = { sessionManager: { sessionId: "unknown-session" } };
		expect(getSessionMode(ctx)).toBe(DEFAULTS.delegation.mode);
	});

	it("returns session-specific mode when set", () => {
		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionMode(ctx, "parallel");
		expect(getSessionMode(ctx)).toBe("parallel");
	});
});

describe("setSessionMode", () => {
	beforeEach(() => {
		_sessionModes.clear();
	});

	it("stores mode for session", () => {
		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionMode(ctx, "parallel");
		expect(_sessionModes.get("s1")).toBe("parallel");
	});

	it("does nothing for invalid ctx", () => {
		setSessionMode(null, "parallel");
		expect(_sessionModes.size).toBe(0);
	});

	it("overwrites existing mode", () => {
		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionMode(ctx, "parallel");
		setSessionMode(ctx, "sequential");
		expect(_sessionModes.get("s1")).toBe("sequential");
	});
});

describe("clearSessionMode", () => {
	beforeEach(() => {
		_sessionModes.clear();
	});

	it("removes session from map", () => {
		_sessionModes.set("s1", "parallel");
		clearSessionMode("s1");
		expect(_sessionModes.has("s1")).toBe(false);
	});

	it("no-op for unknown sessionId", () => {
		clearSessionMode("nonexistent");
		expect(_sessionModes.size).toBe(0);
	});
});

// ─── DEFAULTS ──────────────────────────────────────────────

describe("DEFAULTS", () => {
	it("has expected structure", () => {
		expect(DEFAULTS.version).toBe(1);
		expect(DEFAULTS.delegation.mode).toBe("sequential");
		expect(DEFAULTS.delegation.parallel.maxConcurrent).toBe(4);
		expect(DEFAULTS.delegation.parallel.timeoutMs).toBe(120000);
	});
});
