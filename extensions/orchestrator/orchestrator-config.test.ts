import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	DEFAULTS,
	_sessionModes,
	_currentDefaultMode,
	_sessionModels,
	_extractSessionId,
	_parseYaml,
	getSessionMode,
	setSessionMode,
	clearSessionMode,
	getSessionModels,
	setSessionModels,
	clearSessionModels,
	resolveSpecialistModel,
	mergeEffectiveModels,
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

// ─── undefined session ID phantom session ─────────────────

describe("BUG: undefined session ID phantom session", () => {
	beforeEach(() => {
		_sessionModes.clear();
	});

	it("multiple sessions with broken ctx share phantom 'undefined' session", () => {
		// Session with valid ctx
		setSessionMode({ sessionManager: { sessionId: "valid-session" } }, "parallel");

		// Session with broken ctx (no sessionManager)
		setSessionMode({}, "sequential");

		// Both should be independent, but broken ctx gets key "undefined"
		expect(getSessionMode({ sessionManager: { sessionId: "valid-session" } })).toBe("parallel");
		expect(getSessionMode({})).toBe("sequential"); // This should fail if bug exists

		// The map should only have the valid session stored
		expect(_sessionModes.size).toBe(1);
		expect(_sessionModes.has("valid-session")).toBe(true);
	});
});

// ─── DEFAULTS ──────────────────────────────────────────────

describe("DEFAULTS", () => {
	it("has expected structure", () => {
		expect(DEFAULTS.version).toBe(1);
		expect(DEFAULTS.delegation.mode).toBe("sequential");
		expect(DEFAULTS.delegation.maxTurns).toBe(30);
		expect(DEFAULTS.delegation.parallel.maxConcurrent).toBe(4);
		expect(DEFAULTS.delegation.parallel.timeoutMs).toBe(600000);
	});
});

// ─── maxTurns config ──────────────────────────────────────

describe("maxTurns config", () => {
	it("defaults to 30", () => {
		expect(DEFAULTS.delegation.maxTurns).toBe(30);
	});
	it("can be overridden via YAML", () => {
		const yaml = `delegation:\n  maxTurns: 50\n`;
		const parsed = _parseYaml(yaml);
		expect(parsed.delegation.maxTurns).toBe(50);
	});
});

// ─── Session model overrides ──────────────────────────────

describe("session model overrides", () => {
	beforeEach(() => {
		_sessionModels.clear();
	});

	it("setSessionModels then getSessionModels returns override for same session id", () => {
		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionModels(ctx, { delegate: "anthropic/claude-sonnet-4" });
		expect(getSessionModels(ctx)).toEqual({ delegate: "anthropic/claude-sonnet-4" });
	});

	it("different session id sees no override", () => {
		setSessionModels({ sessionManager: { sessionId: "s1" } }, { delegate: "model/x" });
		expect(getSessionModels({ sessionManager: { sessionId: "s2" } })).toBeUndefined();
	});

	it("returns undefined when no override set", () => {
		expect(getSessionModels({ sessionManager: { sessionId: "s1" } })).toBeUndefined();
	});

	it("setSessionModels with undefined clears the override", () => {
		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionModels(ctx, { delegate: "model/x" });
		setSessionModels(ctx, undefined);
		expect(getSessionModels(ctx)).toBeUndefined();
	});

	it("does nothing for invalid ctx in set/clearSessionModels", () => {
		setSessionModels(null, { delegate: "model/x" });
		expect(_sessionModels.size).toBe(0);
		clearSessionModels(null);
		expect(_sessionModels.size).toBe(0);
	});

	it("clearSessionModels removes only the given session's override", () => {
		setSessionModels({ sessionManager: { sessionId: "s1" } }, { delegate: "model/a" });
		setSessionModels({ sessionManager: { sessionId: "s2" } }, { delegate: "model/b" });
		clearSessionModels({ sessionManager: { sessionId: "s1" } });
		expect(_sessionModels.has("s1")).toBe(false);
		expect(getSessionModels({ sessionManager: { sessionId: "s2" } })).toEqual({ delegate: "model/b" });
	});
});

// ─── resolveSpecialistModel session precedence ────────────

describe("resolveSpecialistModel session precedence", () => {
	const global = {
		version: 1,
		delegation: { mode: "sequential" as const, parallel: { maxConcurrent: 1, timeoutMs: 1000 } },
		models: {
			delegate: "global/delegate",
			specialists: { scout: "global/scout" },
		},
	};
	const noModelsGlobal = {
		version: 1,
		delegation: { mode: "sequential" as const, parallel: { maxConcurrent: 1, timeoutMs: 1000 } },
		models: undefined,
	};

	it("session specialist wins over session delegate", () => {
		expect(resolveSpecialistModel(global, "scout", undefined, { delegate: "session/delegate", specialists: { scout: "session/scout" } }))
			.toBe("session/scout");
	});

	it("session delegate wins over global specialist", () => {
		expect(resolveSpecialistModel(global, "scout", undefined, { delegate: "session/delegate" }))
			.toBe("session/delegate");
	});

	it("global specialist wins over global delegate", () => {
		expect(resolveSpecialistModel(global, "scout", undefined, undefined)).toBe("global/scout");
	});

	it("global delegate used when no specialist override and no session", () => {
		expect(resolveSpecialistModel(global, "coder", undefined, undefined)).toBe("global/delegate");
	});

	it("specialist.model used after global delegate", () => {
		expect(resolveSpecialistModel(noModelsGlobal, "scout", "specialist/model", undefined)).toBe("specialist/model");
	});

	it("returns undefined (inherit) when nothing matches", () => {
		expect(resolveSpecialistModel(noModelsGlobal, "scout", undefined, undefined)).toBeUndefined();
	});
});

// ─── mergeEffectiveModels ──────────────────────────────────

describe("mergeEffectiveModels", () => {
	it("returns global unchanged when no session override", () => {
		const global = { delegate: "g/d", specialists: { scout: "g/scout" } };
		expect(mergeEffectiveModels(global, undefined)).toBe(global);
	});

	it("session delegate overrides global delegate", () => {
		const global = { delegate: "g/d", specialists: { scout: "g/scout" } };
		expect(mergeEffectiveModels(global, { delegate: "s/d" })?.delegate).toBe("s/d");
	});

	it("session delegate shadows global specialists", () => {
		const global = { delegate: "g/d", specialists: { scout: "g/scout" } };
		expect(mergeEffectiveModels(global, { delegate: "s/d" })?.specialists).toBeUndefined();
	});

	it("session specialist merged over global specialist", () => {
		const global = { specialists: { scout: "g/scout", coder: "g/coder" } };
		expect(mergeEffectiveModels(global, { specialists: { scout: "s/scout" } })?.specialists).toEqual({ scout: "s/scout", coder: "g/coder" });
	});
});
