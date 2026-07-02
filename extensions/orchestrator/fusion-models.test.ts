import { describe, it, expect } from "vitest";
import { resolveModels, resolveOneModel, autoDiversePanel } from "./fusion-models.ts";

describe("resolveModels", () => {
	const mockRegistry = {
		find: (provider: string, id: string) => {
			if (provider === "valid" && id === "gpt4") return { id: "gpt4", provider: "valid" };
			if (provider === "valid" && id === "claude") return { id: "claude", provider: "valid" };
			return null;
		},
	};

	it("resolves valid model IDs", () => {
		const result = resolveModels(mockRegistry, ["valid/gpt4", "valid/claude"]);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("gpt4");
		expect(result[1].id).toBe("claude");
	});

	it("filters out unresolvable model IDs", () => {
		const result = resolveModels(mockRegistry, ["valid/gpt4", "nonexistent/model"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("gpt4");
	});

	it("returns empty array for empty input", () => {
		const result = resolveModels(mockRegistry, []);
		expect(result).toEqual([]);
	});

	it("returns empty array when no models resolve", () => {
		const result = resolveModels(mockRegistry, ["bad/a", "bad/b"]);
		expect(result).toEqual([]);
	});
});

describe("resolveOneModel", () => {
	const mockRegistry = {
		find: (provider: string, id: string) => {
			if (provider === "valid" && id === "gpt4") return { id: "gpt4", provider: "valid" };
			return null;
		},
	};

	it("resolves a valid model ID", () => {
		const result = resolveOneModel(mockRegistry, "valid/gpt4");
		expect(result).not.toBeNull();
		expect(result.id).toBe("gpt4");
	});

	it("returns null for empty modelId", () => {
		expect(resolveOneModel(mockRegistry, "")).toBeNull();
	});

	it("returns null for unresolvable model", () => {
		expect(resolveOneModel(mockRegistry, "bad/model")).toBeNull();
	});

	it("returns null for modelId without slash", () => {
		expect(resolveOneModel(mockRegistry, "no-slash")).toBeNull();
	});
});

describe("autoDiversePanel", () => {
	const makeModels = (count: number, provider: string) =>
		Array.from({ length: count }, (_, i) => ({ id: `${provider}-${i}`, provider }));

	it("returns empty array when no models available", () => {
		const registry = { getAvailable: () => [] };
		expect(autoDiversePanel(registry)).toEqual([]);
	});

	it("picks up to 2 models from diverse providers", () => {
		const registry = {
			getAvailable: () => [
				...makeModels(3, "provider1"),
				...makeModels(2, "provider2"),
			],
		};
		const result = autoDiversePanel(registry);
		expect(result).toHaveLength(2);
		expect(result[0].provider).toBe("provider1");
		expect(result[1].provider).toBe("provider2");
	});

	it("returns fewer than 2 when only one provider", () => {
		const registry = {
			getAvailable: () => makeModels(1, "only-one"),
		};
		const result = autoDiversePanel(registry);
		expect(result).toHaveLength(1);
	});

	it("deduplicates same model across providers", () => {
		const registry = {
			getAvailable: () => [
				{ id: "shared-model", provider: "p1" },
				{ id: "shared-model", provider: "p1" },
			],
		};
		const result = autoDiversePanel(registry);
		expect(result).toHaveLength(1);
	});
});
