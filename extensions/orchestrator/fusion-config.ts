import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FusionConfig } from "./types.ts";
import { debugLog } from "./debug.ts";

// ─── Config ────────────────────────────────────────────────

export function getDefaultReasoningEffort(model: any): string {
	const map = model?.thinkingLevelMap;
	if (map && typeof map === "object") {
		if (map["medium"] != null) return "medium";
		for (const key of Object.keys(map)) {
			if (map[key] != null) return key;
		}
	}
	return "medium";
}

export function sanitizeFusionConfig(
	config: FusionConfig,
	availableModelIds: string[],
): { config: Required<FusionConfig>; removed: string[] } {
	const removed: string[] = [];

	const panel = (config.panel ?? []).filter((id) => {
		if (availableModelIds.includes(id)) return true;
		removed.push(id);
		return false;
	});

	let judge = config.judge ?? "";
	if (judge && !availableModelIds.includes(judge)) {
		removed.push(judge);
		judge = "";
	}

	const cleaned: Required<FusionConfig> = {
		enabled: config.enabled ?? true,
		panel,
		judge,
		maxPanelModels: config.maxPanelModels ?? 3,
		temperature: config.temperature ?? 0.3,
		maxTokensPerPanel: config.maxTokensPerPanel ?? 2048,
		maxTokensForJudge: config.maxTokensForJudge ?? 4096,
	};

	return { config: cleaned, removed };
}

export function loadFusionConfig(cwd: string, availableModelIds?: string[]): Required<FusionConfig> {
	const projectPath = join(cwd, ".pi", "fusion.json");
	const globalPath = join(getAgentDir(), "fusion.json");

	let config: FusionConfig = {};

	if (existsSync(globalPath)) {
		try {
			config = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch (err: any) {
			debugLog("fusion-tool: failed to load global fusion config", { globalPath, error: err.message ?? String(err) });
		}
	}
	if (existsSync(projectPath)) {
		try {
			const projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
			config = { ...config, ...projectConfig };
		} catch (err: any) {
			debugLog("fusion-tool: failed to load project fusion config", { projectPath, error: err.message ?? String(err) });
		}
	}

	const defaulted: Required<FusionConfig> = {
		enabled: config.enabled ?? true,
		panel: config.panel ?? [],
		judge: config.judge ?? "",
		maxPanelModels: config.maxPanelModels ?? 3,
		temperature: config.temperature ?? 0.3,
		maxTokensPerPanel: config.maxTokensPerPanel ?? 2048,
		maxTokensForJudge: config.maxTokensForJudge ?? 4096,
	};

	if (availableModelIds && availableModelIds.length > 0) {
		const { config: cleaned, removed } = sanitizeFusionConfig(defaulted, availableModelIds);
		if (removed.length > 0) {
			debugLog("fusion-tool: removed stale fusion models", { removed });
			saveFusionConfig(cwd, cleaned);
		}
		return cleaned;
	}

	return defaulted;
}

export function saveFusionConfig(cwd: string, config: Partial<FusionConfig>): void {
	const projectPath = join(cwd, ".pi", "fusion.json");
	const existing = loadFusionConfig(cwd);
	const merged = { ...existing, ...config };
	mkdirSync(dirname(projectPath), { recursive: true });
	writeFileSync(projectPath, JSON.stringify(merged, null, 2) + "\n");
}
