import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import orchestrator from "./index";
import {
	getSessionMode,
	setSessionMode,
	loadOrchestratorConfig,
	_sessionModes,
	_currentDefaultMode,
} from "./orchestrator-config";

// Mock getAgentDir so loadOrchestratorConfig()/loadFusionConfig() read from an
// isolated temp dir, not the real ~/.pi/agent. Keep the rest of the module real.
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

function createMockPi() {
	const tools: any[] = [];
	const handlers: Record<string, any[]> = {};
	const activeTools: string[][] = [];
	const pi = {
		registerTool: (tool: any) => {
			tools.push(tool);
		},
		getAllTools: () => tools,
		setActiveTools: (list: string[]) => {
			activeTools.push(list);
		},
		on: (event: string, handler: any) => {
			handlers[event] = handlers[event] || [];
			handlers[event].push(handler);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		getActiveToolsHistory: () => activeTools,
		async trigger(event: string, ...args: any[]) {
			const results: any[] = [];
			for (const h of handlers[event] || []) {
				results.push(await h(...args));
			}
			return results;
		},
	};
	return pi;
}

type MockPi = ReturnType<typeof createMockPi>;

let tmpDir: string;

beforeEach(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "session-start-mode-"));
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	vi.mocked(getAgentDir).mockReturnValue(tmpDir);
	_sessionModes.clear();
	// Reset module-level effective default to the built-in sequential default so
	// each test starts from a clean slate (session_start re-syncs it via config).
	loadOrchestratorConfig();
	// Ensure the session_start handler doesn't early-return on a stale subagent flag.
	delete process.env["PI_ORCHESTRATOR_SUBAGENT"];
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
	writeFileSync(join(tmpDir, "orchestrator.yml"), yaml, "utf-8");
}

/**
 * Regression test for the "first batch rejected in a fresh headless session" bug.
 *
 * Root cause: `_currentDefaultMode` was only synced from orchestrator.yml inside
 * DelegatePipeline.run() (delegate-pipeline.ts:142), which executes AFTER the
 * batch-mode guard in executeDelegate (delegate-controller.ts:46). So on the very
 * first delegate({ batch }) in a fresh session, getSessionMode() returned the
 * frozen "sequential" default and the batch was rejected.
 *
 * Fix: session_start now calls loadOrchestratorConfig() so `_currentDefaultMode`
 * reflects `delegation.mode` BEFORE the first delegate/batch call.
 */
describe("session_start loads delegation mode for the first batch call", () => {
	it("first getSessionMode() after a fresh session_start returns the config's parallel mode", async () => {
		writeConfig("version: 1\ndelegation:\n  mode: parallel\n");
		const pi = createMockPi();
		orchestrator(pi as any);

		// Simulate a fresh headless session start.
		await pi.trigger("session_start", {}, { cwd: tmpDir });

		// The batch guard reads getSessionMode(ctx) — it must reflect the config
		// default ("parallel"), not the frozen "sequential" default.
		expect(_currentDefaultMode).toBe("parallel");
		expect(getSessionMode({ sessionManager: { sessionId: "fresh" } })).toBe("parallel");
	});

	it("first getSessionMode() after session_start defaults to sequential when config is absent", async () => {
		const pi = createMockPi();
		orchestrator(pi as any);

		await pi.trigger("session_start", {}, { cwd: tmpDir });

		expect(_currentDefaultMode).toBe("sequential");
		expect(getSessionMode({ sessionManager: { sessionId: "fresh" } })).toBe("sequential");
	});

	it("per-session /delegate-mode override still wins over the config default after session_start", async () => {
		writeConfig("version: 1\ndelegation:\n  mode: parallel\n");
		const pi = createMockPi();
		orchestrator(pi as any);

		await pi.trigger("session_start", {}, { cwd: tmpDir });
		expect(getSessionMode({ sessionManager: { sessionId: "s1" } })).toBe("parallel");

		// Runtime override for this session wins over the config default...
		const ctx = { sessionManager: { sessionId: "s1" } };
		setSessionMode(ctx, "sequential");
		expect(getSessionMode(ctx)).toBe("sequential");
		// ...while another session without an override still inherits the config default.
		expect(getSessionMode({ sessionManager: { sessionId: "s2" } })).toBe("parallel");
	});
});
