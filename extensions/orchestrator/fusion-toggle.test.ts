import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFusionTool, loadFusionConfig } from "./fusion-tool";
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
		pi = createMockPi();
		cwd = makeTempDir();
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("does not register fusion tool, omit prompt section, and limits active tools when disabled", async () => {
		writeFusionConfig(cwd, { enabled: false });
		orchestrator(pi as any);

		const event = { systemPrompt: "BASE", systemPromptOptions: {} };
		const ctx = { cwd };
		const results = await pi.trigger("before_agent_start", event, ctx);
		const prompt = results[0]?.systemPrompt ?? event.systemPrompt;

		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(false);
		expect(pi.getActiveToolsHistory()[0]).toEqual(["plan", "delegate"]);
		expect(prompt).not.toContain("### Fusion Tool");
		expect(prompt).toContain("## Orchestrator Mode");
	});

	it("registers fusion tool, includes prompt section, and adds fusion to active tools when enabled", async () => {
		writeFusionConfig(cwd, { enabled: true });
		orchestrator(pi as any);

		const event = { systemPrompt: "BASE", systemPromptOptions: {} };
		const ctx = { cwd };
		const results = await pi.trigger("before_agent_start", event, ctx);
		const prompt = results[0]?.systemPrompt ?? event.systemPrompt;

		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);
		expect(pi.getActiveToolsHistory()[0]).toEqual(["plan", "delegate", "fusion"]);
		expect(prompt).toContain("### Fusion Tool");
		expect(prompt).toContain("## Orchestrator Mode");
	});

	it("defaults to enabled when no config exists", async () => {
		orchestrator(pi as any);

		const event = { systemPrompt: "BASE", systemPromptOptions: {} };
		const ctx = { cwd };
		const results = await pi.trigger("before_agent_start", event, ctx);
		const prompt = results[0]?.systemPrompt ?? event.systemPrompt;

		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);
		expect(pi.getActiveToolsHistory()[0]).toEqual(["plan", "delegate", "fusion"]);
		expect(prompt).toContain("### Fusion Tool");
	});

	it("unregisters fusion tool when config changes from enabled to disabled", async () => {
		writeFusionConfig(cwd, { enabled: true });
		registerFusionTool(pi as any, cwd);
		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);

		writeFusionConfig(cwd, { enabled: false });
		registerFusionTool(pi as any, cwd);
		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(false);
	});

	it("is idempotent when enabled", async () => {
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
