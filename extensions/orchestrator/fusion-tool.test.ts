import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText, getDefaultReasoningEffort, registerFusionTool, sanitizeFusionConfig, tryCompleteWithTemperatureFallback, _resetTemperatureCacheForTests } from "./fusion-tool";
import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

vi.mock("@earendil-works/pi-ai", () => {
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
		expect(complete).toHaveBeenCalledTimes(1);
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
