/**
 * Init-guard test: verifies the extension default export does NOT call any
 * SDK action methods during the init (loading) phase.
 *
 * The pi SDK throws "Extension runtime not initialized" if action methods
 * like getAllTools, setActiveTools, etc. are called before session_start.
 * Only registration methods (registerTool, registerCommand, on, etc.) are
 * allowed during init.
 *
 * This test creates a mock ExtensionAPI where all action methods throw,
 * calls the extension's default export, and asserts no error.
 */
import { describe, it, expect, vi } from "vitest";
import orchestrator from "./index";

// ── Action methods that the SDK throws if called during init ──
// These are documented in @earendil-works/pi-coding-agent's ExtensionAPI.
// Registration methods (register*, on) are safe during init.
const ACTION_METHODS: string[] = [
	"getAllTools",
	"setActiveTools",
	"getActiveTools",
	"sendMessage",
	"sendUserMessage",
	"setSessionName",
	"getSessionName",
	"setLabel",
	"appendEntry",
	"exec",
	"setModel",
	"getThinkingLevel",
	"setThinkingLevel",
	"getCommands",
	"registerProvider",
	"unregisterProvider",
];

function createRestrictedMockPi(): Record<string, any> {
	const calledDuringInit: string[] = [];

	// Track failed action method calls
	function trackCall(method: string): never {
		calledDuringInit.push(method);
		throw new Error(
			"Extension runtime not initialized. Action methods cannot be called during extension loading.",
		);
	}

	const pi: Record<string, any> = {
		// Registration methods — allowed during init
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerFlag: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		events: {},
		getFlag: vi.fn(() => undefined),

		// Action methods — throw during init
		getAllTools: () => trackCall("getAllTools"),
		setActiveTools: () => trackCall("setActiveTools"),
		getActiveTools: () => trackCall("getActiveTools"),
		sendMessage: () => trackCall("sendMessage"),
		sendUserMessage: () => trackCall("sendUserMessage"),
		setSessionName: () => trackCall("setSessionName"),
		getSessionName: () => trackCall("getSessionName"),
		setLabel: () => trackCall("setLabel"),
		appendEntry: () => trackCall("appendEntry"),
		exec: () => trackCall("exec"),
		setModel: () => trackCall("setModel"),
		getThinkingLevel: () => trackCall("getThinkingLevel"),
		setThinkingLevel: () => trackCall("setThinkingLevel"),
		getCommands: () => trackCall("getCommands"),
		registerProvider: () => trackCall("registerProvider"),
		unregisterProvider: () => trackCall("unregisterProvider"),

		// Test helper — populated by trackCall
		_calledDuringInit: calledDuringInit,
	};

	return pi;
}

describe("init phase — no action method calls", () => {
	it("does not call any action methods during extension loading", () => {
		const pi = createRestrictedMockPi() as any;

		// This is what pi-agent does: calls the default export with the API.
		// If index.ts calls getAllTools, setActiveTools, etc. here, it throws.
		expect(() => orchestrator(pi)).not.toThrow();

		// Double-check: no action method was even touched.
		const called = pi._calledDuringInit as string[];
		expect(called).toEqual([]);
	});

	it("allows action methods after session_start (deferred calls work)", async () => {
		const pi = createRestrictedMockPi() as any;
		orchestrator(pi);

		// Simulate session_start — after this, action methods should work.
		// Replace the throwing stubs with real implementations for the test.
		const tools: any[] = [];
		const activeToolsLog: string[][] = [];
		pi.getAllTools = vi.fn(() => tools);
		pi.setActiveTools = vi.fn((list: string[]) => {
			activeToolsLog.push(list);
		});

		// Find and call the session_start handler that was registered via pi.on()
		const onMock = pi.on as ReturnType<typeof vi.fn>;
		const sessionCb = onMock.mock.calls.find(
			([event]: [string]) => event === "session_start",
		)?.[1];
		expect(sessionCb).toBeDefined("session_start handler must be registered");
		await sessionCb({}, { cwd: "/tmp/test-cwd" });

		// setActiveTools should have been called (the real handler does this)
		expect(pi.setActiveTools).toHaveBeenCalled();
		// getAllTools should have been called (updateToolDocs runs here now)
		expect(pi.getAllTools).toHaveBeenCalled();
	});
});
