import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOrchestratorConfig,
	getSessionMode,
	setSessionMode,
	_sessionModes,
	_currentDefaultMode,
	DEFAULTS,
} from "./orchestrator-config.ts";

// Mock getAgentDir so loadOrchestratorConfig() reads from an isolated temp dir,
// not the real ~/.pi/agent/orchestrator.yml. Keep the rest of the module real.
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

let tmpDir: string;

beforeEach(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "orch-config-mode-"));
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	vi.mocked(getAgentDir).mockReturnValue(tmpDir);
	_sessionModes.clear();
	// Reset module-level default to the built-in sequential default so each test
	// starts from a clean slate (loadOrchestratorConfig() is what re-syncs it).
	// We cannot reassign the imported live binding, so we rely on a config file
	// being absent in the fresh tmpDir to force DEFAULTS on the first load.
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
	writeFileSync(join(tmpDir, "orchestrator.yml"), yaml, "utf-8");
}

// ─── delegation.mode loaded from config ───────────────────

describe("delegation.mode config → effective default", () => {
	it("loads delegation.mode: parallel from orchestrator.yml as the effective default", () => {
		writeConfig("version: 1\ndelegation:\n  mode: parallel\n");

		const config = loadOrchestratorConfig();

		expect(config.delegation.mode).toBe("parallel");
		expect(_currentDefaultMode).toBe("parallel");
		// A fresh session with no /delegate-mode override inherits the config default.
		expect(getSessionMode({ sessionManager: { sessionId: "fresh" } })).toBe("parallel");
	});

	it("defaults to sequential when delegation.mode is absent from the config file", () => {
		writeConfig("version: 1\ndelegation:\n  maxTurns: 30\n");

		const config = loadOrchestratorConfig();

		expect(config.delegation.mode).toBe("sequential");
		expect(_currentDefaultMode).toBe("sequential");
		expect(getSessionMode({ sessionManager: { sessionId: "fresh" } })).toBe("sequential");
	});

	it("defaults to sequential when no config file exists", () => {
		const config = loadOrchestratorConfig();

		expect(config.delegation.mode).toBe(DEFAULTS.delegation.mode);
		expect(_currentDefaultMode).toBe(DEFAULTS.delegation.mode);
		expect(getSessionMode({ sessionManager: { sessionId: "fresh" } })).toBe("sequential");
	});
});

// ─── runtime /delegate-mode override wins over config ─────

describe("runtime /delegate-mode override precedence", () => {
	it("session override set via /delegate-mode wins over the config default", () => {
		writeConfig("version: 1\ndelegation:\n  mode: parallel\n");
		loadOrchestratorConfig();
		expect(_currentDefaultMode).toBe("parallel");

		// Simulate `/delegate-mode sequential` (session-only runtime override).
		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionMode(ctx, "sequential");

		// Override wins for this session...
		expect(getSessionMode(ctx)).toBe("sequential");
		// ...while another session without an override still sees the config default.
		expect(getSessionMode({ sessionManager: { sessionId: "s2" } })).toBe("parallel");
	});

	it("session override set via /delegate-mode parallel wins over a sequential config", () => {
		// Config absent → sequential default.
		loadOrchestratorConfig();
		expect(_currentDefaultMode).toBe("sequential");

		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionMode(ctx, "parallel");

		expect(getSessionMode(ctx)).toBe("parallel");
		expect(getSessionMode({ sessionManager: { sessionId: "s2" } })).toBe("sequential");
	});
});
