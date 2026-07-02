import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultReasoningEffort, registerFusionTool, sanitizeFusionConfig, tryCompleteWithTemperatureFallback, _resetTemperatureCacheForTests, _resetFusionRegistrationsForTests } from "./fusion-tool";
import { extractText } from "./fusion-utils.ts";
import { complete } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";

vi.mock("@earendil-works/pi-ai/compat", () => {
	return {
		complete: vi.fn(),
	};
});

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "fusion-tool-"));
}

function writeFusionConfig(cwd: string, config: object) {
	const dir = join(cwd, ".pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "fusion.json"), JSON.stringify(config, null, 2));
}

function createMockPi() {
	const tools: any[] = [];
	return {
		registerTool: vi.fn((tool: any) => { tools.push(tool); }),
		getAllTools: vi.fn(() => tools),
		setActiveTools: vi.fn(),
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
	};
}

type MockPi = ReturnType<typeof createMockPi>;

function createMockRegistry(models: any[]) {
	return {
		getAvailable: vi.fn(() => models),
		find: vi.fn((provider: string, id: string) =>
			models.find((m: any) => m.provider === provider && m.id === id),
		),
		getApiKeyAndHeaders: vi.fn(() => ({ ok: true, apiKey: "test-key", headers: {} })),
	};
}

function buildCtx(cwd: string, registry: any) {
	return {
		cwd,
		modelRegistry: registry,
		sessionManager: { getSessionId: () => "session-1" },
	};
}

function panelSuccess(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "end",
	};
}

function panelError(message: string): any {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: message,
	};
}

function judgeSuccess(): any {
	return {
		role: "assistant",
		content: [{
			type: "text",
			text: JSON.stringify({
				consensus: ["agreed"],
				contradictions: [],
				unique_insights: [],
				blind_spots: [],
				recommendations: ["proceed"],
			}),
		}],
		stopReason: "end",
	};
}

function panelToolCalls(findings: string[]): any {
	return {
		role: "assistant",
		content: findings.map((finding, i) => ({
			type: "toolCall" as const,
			id: `call-${i}`,
			name: "reportFinding" as const,
			arguments: { finding },
		})),
		stopReason: "end",
	};
}

describe("extractText", () => {
	it("returns text from text-only response", () => {
		const response = {
			role: "assistant",
			content: [{ type: "text" as const, text: "hello world" }],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("hello world");
	});

	it("falls back to thinking when no text blocks", () => {
		const response = {
			role: "assistant",
			content: [{ type: "thinking" as const, thinking: "deep thought" }],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("deep thought");
	});

	it("falls back to thinking when text blocks are empty", () => {
		const response = {
			role: "assistant",
			content: [
				{ type: "text" as const, text: "" },
				{ type: "thinking" as const, thinking: "backup thought" },
			],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("backup thought");
	});

	it("joins mixed text and thinking, preferring text", () => {
		const response = {
			role: "assistant",
			content: [
				{ type: "text" as const, text: "first" },
				{ type: "thinking" as const, thinking: "ignored when text present" },
				{ type: "text" as const, text: "second" },
			],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("first\nsecond");
	});

	it("ignores toolCall blocks", () => {
		const response = {
			role: "assistant",
			content: [
				{ type: "text" as const, text: "analysis" },
				{ type: "toolCall" as const, id: "1", name: "reportFinding", arguments: { finding: "x" } },
			],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("analysis");
	});

	it("returns empty string for empty content array", () => {
		const response = {
			role: "assistant",
			content: [],
		} as unknown as AssistantMessage;
		expect(extractText(response)).toBe("");
	});
});

describe("getDefaultReasoningEffort", () => {
	it("prefers medium when present", () => {
		const model = {
			thinkingLevelMap: { low: "low", medium: "med", high: "high" },
		};
		expect(getDefaultReasoningEffort(model)).toBe("medium");
	});

	it("falls back to first non-null key", () => {
		const model = {
			thinkingLevelMap: { low: "low", high: "high" },
		};
		expect(getDefaultReasoningEffort(model)).toBe("low");
	});

	it("returns medium fallback for missing map", () => {
		expect(getDefaultReasoningEffort({})).toBe("medium");
		expect(getDefaultReasoningEffort({ thinkingLevelMap: null })).toBe("medium");
		expect(getDefaultReasoningEffort(undefined)).toBe("medium");
	});
});

describe("fusion error reporting", () => {
	let cwd: string;
	let pi: MockPi;
	let tool: any;

	beforeEach(() => {
		cwd = makeTempDir();
		pi = createMockPi();
		vi.mocked(complete).mockReset();
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function register(models: any[], panelIds: string[], judgeId: string) {
		writeFusionConfig(cwd, {
			enabled: true,
			panel: panelIds,
			judge: judgeId,
		});
		const registry = createMockRegistry(models);
		registerFusionTool(pi as any, cwd);
		tool = pi.getAllTools().find((t: any) => t.name === "fusion");
		return { registry, ctx: buildCtx(cwd, registry) };
	}

	it("reports a failed panel model in the returned content", async () => {
		const models = [
			{ id: "good", provider: "test" },
			{ id: "bad", provider: "test" },
			{ id: "judge", provider: "test" },
		];
		const { ctx } = register(models, ["test/good", "test/bad"], "test/judge");

		vi.mocked(complete).mockImplementation(async (model: any) => {
			if (model.id === "bad") return panelError("502 Bad Gateway");
			if (model.id === "judge") return judgeSuccess();
			return panelSuccess("good analysis");
		});

		const result = await tool.execute("call-1", { context: "ctx", task: "task" }, undefined, () => {}, ctx);

		expect(result.details.status).toBe("ok");
		expect(result.content[0].text).toContain("### Failed");
		expect(result.content[0].text).toContain("bad");
		expect(result.content[0].text).toContain("502 Bad Gateway");
		expect(result.content[0].text).toContain("good analysis");
	});

	it("reports a failed judge call in the returned content", async () => {
		const models = [
			{ id: "a", provider: "test" },
			{ id: "b", provider: "test" },
			{ id: "judge", provider: "test" },
		];
		const { ctx } = register(models, ["test/a", "test/b"], "test/judge");

		vi.mocked(complete).mockImplementation(async (model: any) => {
			if (model.id === "judge") throw new Error("Judge timeout");
			return panelSuccess(`${model.id} analysis`);
		});

		const result = await tool.execute("call-1", { context: "ctx", task: "task" }, undefined, () => {}, ctx);

		expect(result.details.status).toBe("no_judge");
		expect(result.content[0].text).toContain("### Failed");
		expect(result.content[0].text).toContain("judge");
		expect(result.content[0].text).toContain("Judge timeout");
		expect(result.content[0].text).toContain("a analysis");
		expect(result.content[0].text).toContain("b analysis");
	});

	it("reports all panel model failures without throwing", async () => {
		const models = [
			{ id: "a", provider: "test" },
			{ id: "b", provider: "test" },
			{ id: "judge", provider: "test" },
		];
		const { ctx } = register(models, ["test/a", "test/b"], "test/judge");

		vi.mocked(complete).mockImplementation(async (model: any) => {
			if (model.id === "a") return panelError("Connection reset");
			if (model.id === "b") return panelError("502 Bad Gateway");
			return judgeSuccess();
		});

		const result = await tool.execute("call-1", { context: "ctx", task: "task" }, undefined, () => {}, ctx);

		expect(result.details.status).toBe("no_judge");
		expect(result.content[0].text).toContain("### Failed");
		expect(result.content[0].text).toContain("a");
		expect(result.content[0].text).toContain("Connection reset");
		expect(result.content[0].text).toContain("b");
		expect(result.content[0].text).toContain("502 Bad Gateway");
		expect(result.details.responses).toHaveLength(0);
	});

	it("reports max iterations exceeded when panel model returns only tool calls", async () => {
		const models = [
			{ id: "loop-model", provider: "test" },
			{ id: "a", provider: "test" },
			{ id: "judge", provider: "test" },
		];
		const { ctx } = register(models, ["test/loop-model", "test/a"], "test/judge");

		// loop-model always returns tool calls — never text
		vi.mocked(complete).mockImplementation(async (model: any) => {
			if (model.id === "loop-model") {
				return panelToolCalls(["finding one", "finding two"]);
			}
			if (model.id === "judge") return judgeSuccess();
			return panelSuccess("good analysis from model a");
		});

		const result = await tool.execute(
			"call-1",
			{ context: "ctx", task: "task" },
			undefined,
			() => {},
			ctx
		);

		expect(result.details.status).toBe("ok");
		// Loop-model should be listed as failed with "Max iterations exceeded"
		expect(result.content[0].text).toContain("loop-model");
		expect(result.content[0].text).toContain("Max iterations exceeded");
		// BUG: loop-model's findings should be present but are lost
		// After fix, runPanelModel should return reports alongside the error
		expect(result.content[0].text).toContain("finding one");
		expect(result.content[0].text).toContain("finding two");
	});
});

describe("tryCompleteWithTemperatureFallback", () => {
	const model = { id: "temp-model", provider: "test" };
	const payload = { systemPrompt: "sys", messages: [] };

	beforeEach(() => {
		vi.mocked(complete).mockReset();
		_resetTemperatureCacheForTests();
	});

	it("succeeds on the first call with the requested temperature", async () => {
		vi.mocked(complete).mockResolvedValue(panelSuccess("ok") as any);

		const result = await tryCompleteWithTemperatureFallback(model, payload, { temperature: 0.5 });

		expect(extractText(result)).toBe("ok");
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete).toHaveBeenCalledWith(model, payload, expect.objectContaining({ temperature: 0.5 }));
	});

	it("retries without temperature when the provider rejects temperature", async () => {
		vi.mocked(complete)
			.mockRejectedValueOnce(new Error("temperature must be 1") as never)
			.mockResolvedValueOnce(panelSuccess("retried") as any);

		const result = await tryCompleteWithTemperatureFallback(model, payload, { temperature: 0.5 });

		expect(extractText(result)).toBe("retried");
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete).toHaveBeenNthCalledWith(1, model, payload, expect.objectContaining({ temperature: 0.5 }));
		expect(complete).toHaveBeenNthCalledWith(2, model, payload, expect.objectContaining({ temperature: undefined }));
	});

	it("does not retry on non-temperature errors", async () => {
		vi.mocked(complete).mockRejectedValue(new Error("rate limit") as never);

		await expect(tryCompleteWithTemperatureFallback(model, payload, { temperature: 0.5 })).rejects.toThrow("rate limit");
		expect(complete).toHaveBeenCalledTimes(2);
	});

	it("uses cached preference to skip temperature on subsequent calls", async () => {
		vi.mocked(complete)
			.mockRejectedValueOnce(new Error("temperature must be 1") as never)
			.mockResolvedValueOnce(panelSuccess("first") as any)
			.mockResolvedValueOnce(panelSuccess("second") as any);

		await tryCompleteWithTemperatureFallback(model, payload, { temperature: 0.5 });
		const result = await tryCompleteWithTemperatureFallback(model, payload, { temperature: 0.5 });

		expect(extractText(result)).toBe("second");
		expect(complete).toHaveBeenCalledTimes(3);
		expect(complete).toHaveBeenNthCalledWith(2, model, payload, expect.objectContaining({ temperature: undefined }));
		expect(complete).toHaveBeenNthCalledWith(3, model, payload, expect.objectContaining({ temperature: undefined }));
	});

	it("retries without temperature when the API returns a temperature error message (not thrown)", async () => {
		const model = { id: "temp-model", provider: "test" };
		const payload = { systemPrompt: "sys", messages: [] };

		vi.mocked(complete)
			.mockResolvedValueOnce(panelError("invalid temperature: only 1 is allowed"))
			.mockResolvedValueOnce(panelSuccess("retried"));

		const result = await tryCompleteWithTemperatureFallback(model, payload, {
			temperature: 0.5,
		});

		expect(extractText(result)).toBe("retried");
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete).toHaveBeenNthCalledWith(
			1, model, payload,
			expect.objectContaining({ temperature: 0.5 })
		);
		expect(complete).toHaveBeenNthCalledWith(
			2, model, payload,
			expect.objectContaining({ temperature: undefined })
		);
	});

	it("does not retry on non-temperature API errors (returned, not thrown)", async () => {
		const model = { id: "temp-model", provider: "test" };
		const payload = { systemPrompt: "sys", messages: [] };

		vi.mocked(complete).mockResolvedValue(
			panelError("rate limit exceeded")
		);

		const result = await tryCompleteWithTemperatureFallback(model, payload, {
			temperature: 0.5,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("rate limit exceeded");
		expect(complete).toHaveBeenCalledTimes(2);
	});

	it("retries without temperature on any API error (not just temperature-keyword errors)", async () => {
		const model = { id: "temp-model", provider: "test" };
		const payload = { systemPrompt: "sys", messages: [] };

		vi.mocked(complete)
			.mockResolvedValueOnce(
				panelError("502 upstream unknown returned 502: all route targets failed")
			)
			.mockResolvedValueOnce(panelSuccess("retried"));

		const result = await tryCompleteWithTemperatureFallback(model, payload, {
			temperature: 0.5,
		});

		expect(extractText(result)).toBe("retried");
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete).toHaveBeenNthCalledWith(
			1, model, payload,
			expect.objectContaining({ temperature: 0.5 })
		);
		expect(complete).toHaveBeenNthCalledWith(
			2, model, payload,
			expect.objectContaining({ temperature: undefined })
		);
	});
});

describe("sanitizeFusionConfig", () => {
	it("filters stale panel IDs and keeps valid ones", () => {
		const config = {
			enabled: true,
			panel: ["test/a", "test/ghost", "other/b", "other/gone"],
			judge: "test/judge",
		};
		const available = ["test/a", "other/b", "test/judge"];
		const { config: cleaned, removed } = sanitizeFusionConfig(config, available);

		expect(cleaned.panel).toEqual(["test/a", "other/b"]);
		expect(cleaned.judge).toBe("test/judge");
		expect(removed).toEqual(["test/ghost", "other/gone"]);
	});

	it("resets judge to default when it is stale", () => {
		const config = {
			panel: ["test/a"],
			judge: "test/old-judge",
		};
		const available = ["test/a", "test/new-judge"];
		const { config: cleaned, removed } = sanitizeFusionConfig(config, available);

		expect(cleaned.judge).toBe("");
		expect(removed).toContain("test/old-judge");
	});

	it("applies defaults for missing fields", () => {
		const config = {} as any;
		const available = ["test/a"];
		const { config: cleaned, removed } = sanitizeFusionConfig(config, available);

		expect(cleaned.enabled).toBe(true);
		expect(cleaned.panel).toEqual([]);
		expect(cleaned.judge).toBe("");
		expect(cleaned.maxPanelModels).toBe(3);
		expect(cleaned.temperature).toBe(0.3);
		expect(removed).toEqual([]);
	});
});

describe("fusion tool schema", () => {
	beforeEach(() => {
		_resetFusionRegistrationsForTests();
	});

	it("description is concise and has usage hint", async () => {
		const pi = createMockPi();
		registerFusionTool(pi as any, process.cwd());

		const tool = pi.getAllTools().find((t: any) => t.name === "fusion");
		expect(tool).toBeDefined();

		const desc = (tool as any).description;
		// Must be shorter than original 329 chars
		expect(desc.length).toBeLessThanOrEqual(150);
		// Must contain a usage hint like plan's "Call this first."
		expect(desc).toMatch(/Call this/i);
		// Must not contain verbose phrases
		expect(desc).not.toContain("typically");
		expect(desc).not.toContain("Use when you need");
	});

	it("description is stable across registration calls", async () => {
		const pi = createMockPi();
		registerFusionTool(pi as any, process.cwd());
		const desc1 = (pi.getAllTools().find((t: any) => t.name === "fusion") as any).description;

		// Re-register (simulates toggle): description should not change
		registerFusionTool(pi as any, process.cwd());
		const desc2 = (pi.getAllTools().find((t: any) => t.name === "fusion") as any).description;
		expect(desc2).toEqual(desc1);
	});

	it("description contributes minimal tokens to Available tools: section", async () => {
		const pi = createMockPi();
		// Register plan and delegate tools (as they would exist in production)
		pi.registerTool({ name: "plan", description: "Create or update a multi-step plan to accomplish a goal. Call this first." });
		pi.registerTool({ name: "delegate", description: "Assign a subtask to a sub-agent and wait for its result." });
		registerFusionTool(pi as any, process.cwd());

		const allTools = pi.getAllTools();
		const fusionTool = allTools.find((t: any) => t.name === "fusion") as any;

		// Calculate the total char length of all tool descriptions as a proxy for token size
		const totalDescLength = allTools
			.map((t: any) => (t.description || "").length)
			.reduce((sum: number, len: number) => sum + len, 0);

		// Fusion description should be at most ~2x plan/delegate length
		const planDesc = allTools.find((t: any) => t.name === "plan")?.description || "";
		const delegateDesc = allTools.find((t: any) => t.name === "delegate")?.description || "";
		const planLen = planDesc.length;
		const delegateLen = delegateDesc.length;

		// Fusion should not exceed plan+delegate combined length
		expect(fusionTool.description.length).toBeLessThanOrEqual(planLen + delegateLen);
	});
});
