import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFusionTool, loadFusionConfig, _resetFusionRegistrationsForTests } from "./fusion-tool";
import orchestrator from "./index";

function createMockPi() {
	const tools: any[] = [];
	const handlers: Record<string, any[]> = {};
	const activeTools: string[][] = [];
	const pi = {
		registerTool: (tool: any) => {
			tools.push(tool);
		},
		unregisterTool: (name: string) => {
			const idx = tools.findIndex((t: any) => t.name === name);
			if (idx >= 0) tools.splice(idx, 1);
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

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "fusion-toggle-"));
}

function writeFusionConfig(cwd: string, config: { enabled: boolean }) {
	const dir = join(cwd, ".pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "fusion.json"), JSON.stringify(config, null, 2));
}

describe("global fusion toggle", () => {
	let pi: MockPi;
	let cwd: string;

	beforeEach(() => {
		_resetFusionRegistrationsForTests();
		pi = createMockPi();
		cwd = makeTempDir();
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("omits fusion from active tools and prompt section when disabled", async () => {
		writeFusionConfig(cwd, { enabled: false });
		orchestrator(pi as any);

		// Fusion tool is always registered at init (idempotent)
		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);

		// Trigger session_start (where setActiveTools fires) before before_agent_start
		await pi.trigger("session_start", {}, { cwd });

		const event = { systemPrompt: "BASE", systemPromptOptions: {} };
		const ctx = { cwd };
		const results = await pi.trigger("before_agent_start", event, ctx);
		const prompt = results[0]?.systemPrompt ?? event.systemPrompt;

		// But setActiveTools excludes fusion when disabled
		expect(pi.getActiveToolsHistory()[0]).toEqual(["plan", "delegate", "read_skill", "list_skills", "list_tools"]);
		expect(prompt).not.toContain("### Fusion Tool");
		expect(prompt).toContain("## Orchestrator Mode");
	});

	it("includes fusion in active tools and prompt section when enabled", async () => {
		writeFusionConfig(cwd, { enabled: true });
		orchestrator(pi as any);

		// Trigger session_start (where setActiveTools fires) before before_agent_start
		await pi.trigger("session_start", {}, { cwd });

		const event = { systemPrompt: "BASE", systemPromptOptions: {} };
		const ctx = { cwd };
		const results = await pi.trigger("before_agent_start", event, ctx);
		const prompt = results[0]?.systemPrompt ?? event.systemPrompt;

		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);
		expect(pi.getActiveToolsHistory()[0]).toEqual(["plan", "delegate", "fusion", "read_skill", "list_skills", "list_tools"]);
		expect(prompt).toContain("### Fusion Tool");
		expect(prompt).toContain("## Orchestrator Mode");
	});

	it("defaults to enabled when no config exists", async () => {
		orchestrator(pi as any);

		// Trigger session_start (where setActiveTools fires) before before_agent_start
		await pi.trigger("session_start", {}, { cwd });

		const event = { systemPrompt: "BASE", systemPromptOptions: {} };
		const ctx = { cwd };
		const results = await pi.trigger("before_agent_start", event, ctx);
		const prompt = results[0]?.systemPrompt ?? event.systemPrompt;

		expect(pi.getActiveToolsHistory()[0]).toEqual(["plan", "delegate", "fusion", "read_skill", "list_skills", "list_tools"]);
		expect(prompt).toContain("### Fusion Tool");
	});

	it("fusion tool always registered — visibility controlled by setActiveTools", async () => {
		writeFusionConfig(cwd, { enabled: true });
		orchestrator(pi as any);
		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);

		// Simulate config change: setActiveTools controls visibility, not unregister
		writeFusionConfig(cwd, { enabled: false });
		// Trigger session_start with the updated config to reflect the change
		await pi.trigger("session_start", {}, { cwd });

		const event = { systemPrompt: "BASE", systemPromptOptions: {} };
		const ctx = { cwd };
		await pi.trigger("before_agent_start", event, ctx);

		// Tool still registered, but not in active tools
		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);
		expect(pi.getActiveToolsHistory()[0]).toEqual(["plan", "delegate", "read_skill", "list_skills", "list_tools"]);
	});

	it("is idempotent when enabled", () => {
		writeFusionConfig(cwd, { enabled: true });
		registerFusionTool(pi as any, cwd);
		registerFusionTool(pi as any, cwd);

		const fusionTools = pi.getAllTools().filter((t: any) => t.name === "fusion");
		expect(fusionTools.length).toBe(1);
	});

	it("loadFusionConfig reflects enabled flag", () => {
		writeFusionConfig(cwd, { enabled: false });
		const config = loadFusionConfig(cwd);
		expect(config.enabled).toBe(false);

		writeFusionConfig(cwd, { enabled: true });
		const config2 = loadFusionConfig(cwd);
		expect(config2.enabled).toBe(true);
	});
});
