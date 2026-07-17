import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { complete } from "@earendil-works/pi-ai/compat";
import { FusionPipeline, FusionRunContext, tryCompleteWithTemperatureFallback, _resetTemperatureCacheForTests } from "./fusion-pipeline";
import { extractText } from "./fusion-utils";

vi.mock("@earendil-works/pi-ai/compat", () => ({
	complete: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────

function makeRegistry(models: any[]) {
	return {
		getAvailable: vi.fn(() => models),
		getApiKeyAndHeaders: vi.fn(() => ({ ok: true, apiKey: "test-key", headers: {} })),
	};
}

function panelSuccess(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "end" };
}

function panelToolCalls(findings: string[]): any {
	return {
		role: "assistant",
		content: findings.map((f, i) => ({
			type: "toolCall" as const,
			id: `call-${i}`,
			name: "reportFinding" as const,
			arguments: { finding: f },
		})),
		stopReason: "end",
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

function panelError(message: string): any {
	return { role: "assistant", content: [], stopReason: "error", errorMessage: message };
}

// ─── Tests ───────────────────────────────────────────────

describe("FusionPipeline — panel calls", () => {
	let ctx: FusionRunContext;

	beforeEach(() => {
		vi.mocked(complete).mockReset();
		_resetTemperatureCacheForTests();
		ctx = new FusionRunContext();
	});

	it("panel call sends no tools to complete()", async () => {
		const model = { id: "p1", provider: "test" };
		const registry = makeRegistry([model]);
		const pipeline = new FusionPipeline(registry, {
			enabled: true, panel: ["test/p1"], judge: "test/p1",
			maxPanelModels: 3, maxTokensPerPanel: 4096, maxTokensForJudge: 4096,
			temperature: 0.3,
		}, ctx);

		vi.mocked(complete).mockResolvedValue(panelSuccess("analysis text"));

		const { succeeded } = await pipeline.panelPhase([model], "sys", "user prompt");

		expect(succeeded).toHaveLength(1);
		expect(succeeded[0].content).toBe("analysis text");

		// Find the panel call (not the probe call) — panel call has messages with the user prompt
		const panelCall = vi.mocked(complete).mock.calls.find((call: any) => {
			const payload = call[1];
			return payload?.messages?.some((m: any) =>
				m.content?.some((c: any) => c.text?.includes("user prompt"))
			);
		});
		expect(panelCall).toBeDefined();
		expect(panelCall![1].tools).toBeUndefined();
	});

	it("panel response collected via extractText, not tool calls", async () => {
		const model = { id: "p1", provider: "test" };
		const registry = makeRegistry([model]);
		const pipeline = new FusionPipeline(registry, {
			enabled: true, panel: ["test/p1"], judge: "test/p1",
			maxPanelModels: 3, maxTokensPerPanel: 4096, maxTokensForJudge: 4096,
			temperature: 0.3,
		}, ctx);

		vi.mocked(complete).mockResolvedValue(panelSuccess("natural language analysis"));

		const { succeeded } = await pipeline.panelPhase([model], "sys", "user");

		expect(succeeded[0].content).toBe("natural language analysis");
		expect(succeeded[0].reports).toEqual(["natural language analysis"]);
	});

	it("panel model that returns only tool calls (no text) gets error", async () => {
		const model = { id: "tool-only", provider: "test" };
		const registry = makeRegistry([model]);
		const pipeline = new FusionPipeline(registry, {
			enabled: true, panel: ["test/tool-only"], judge: "test/tool-only",
			maxPanelModels: 3, maxTokensPerPanel: 4096, maxTokensForJudge: 4096,
			temperature: 0.3,
		}, ctx);

		// Model returns only tool calls, no text
		vi.mocked(complete).mockResolvedValue(panelToolCalls(["finding one"]));

		const { succeeded, failed } = await pipeline.panelPhase([model], "sys", "user");

		expect(succeeded).toHaveLength(0);
		expect(failed).toHaveLength(1);
		expect(failed[0].error).toBe("Empty response from model");
	});

	it("panel makes exactly one complete() call per model (no probe)", async () => {
		const model = { id: "single-call", provider: "test" };
		const registry = makeRegistry([model]);
		const pipeline = new FusionPipeline(registry, {
			enabled: true, panel: ["test/single-call"], judge: "test/single-call",
			maxPanelModels: 3, maxTokensPerPanel: 4096, maxTokensForJudge: 4096,
			temperature: 0.3,
		}, ctx);

		vi.mocked(complete).mockResolvedValue(panelSuccess("analysis"));

		await pipeline.panelPhase([model], "sys", "user");

		// Exactly 1 call to complete per model — no probe call
		expect(vi.mocked(complete)).toHaveBeenCalledTimes(1);
	});

	it("tryCompleteWithTemperatureFallback is still used for panel calls", async () => {
		const model = { id: "temp-panel", provider: "test" };
		const registry = makeRegistry([model]);
		const pipeline = new FusionPipeline(registry, {
			enabled: true, panel: ["test/temp-panel"], judge: "test/temp-panel",
			maxPanelModels: 3, maxTokensPerPanel: 4096, maxTokensForJudge: 4096,
			temperature: 0.3,
		}, ctx);

		// First call fails with temperature error, second succeeds
		vi.mocked(complete)
			.mockResolvedValueOnce(panelError("invalid temperature"))
			.mockResolvedValueOnce(panelSuccess("retried ok"));

		const { succeeded } = await pipeline.panelPhase([model], "sys", "user");

		expect(succeeded).toHaveLength(1);
		expect(succeeded[0].content).toBe("retried ok");
		// Should have retried: 1 failed + 1 succeeded = 2 calls
		expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
	});
});

describe("FusionPipeline — judge calls (unchanged)", () => {
	let ctx: FusionRunContext;

	beforeEach(() => {
		vi.mocked(complete).mockReset();
		_resetTemperatureCacheForTests();
		ctx = new FusionRunContext();
	});

	it("judge call sends no tools and parses JSON", async () => {
		const model = { id: "j1", provider: "test" };
		const registry = makeRegistry([model]);
		const pipeline = new FusionPipeline(registry, {
			enabled: true, panel: [], judge: "test/j1",
			maxPanelModels: 3, maxTokensPerPanel: 4096, maxTokensForJudge: 4096,
			temperature: 0.3,
		}, ctx);

		vi.mocked(complete).mockResolvedValue(judgeSuccess());

		const { analysis } = await pipeline.judgePhase(
			[{ model: "p1", content: "panel response" }],
			model,
		);

		expect(analysis).not.toBeNull();
		expect(analysis!.consensus).toEqual(["agreed"]);
		expect(analysis!.recommendations).toEqual(["proceed"]);

		// Judge should also have no tools
		const callPayload = vi.mocked(complete).mock.calls[0][1];
		expect(callPayload.tools).toBeUndefined();
	});
});
