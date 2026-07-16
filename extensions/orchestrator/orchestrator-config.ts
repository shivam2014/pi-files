import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Types ─────────────────────────────────────────────────

export interface OrchestratorConfig {
	version: number;
	delegation: {
		mode: "sequential" | "parallel";
		parallel: {
			maxConcurrent: number;
			timeoutMs: number;
		};
	};
	models?: {
		/** Default model for all delegates (e.g. "anthropic/claude-sonnet-4") */
		delegate?: string;
		/** Per-specialist model overrides */
		specialists?: Record<string, string>;
	};
}

// ─── Defaults ──────────────────────────────────────────────

export const DEFAULTS: OrchestratorConfig = {
	version: 1,
	delegation: {
		mode: "sequential",
		parallel: {
			maxConcurrent: 4,
			timeoutMs: 120000,
		},
	},
	// models undefined = all delegates inherit parent model (current behavior)
};

// ─── Module-level state ────────────────────────────────────

export const _sessionModes = new Map<string, string>();
export let _currentDefaultMode: string = DEFAULTS.delegation.mode;

// ─── Helpers ───────────────────────────────────────────────

export function _configPath(): string {
	return join(getAgentDir(), "orchestrator.yml");
}

/**
 * Minimal YAML parser — handles 2-level nesting only.
 * Covers the orchestrator.yml format:
 *   key: value
 *   section:
 *     key: value
 *
 * Throws on malformed input (lines without ':').
 */
export function _parseYaml(raw: string): Record<string, any> {
	const result: Record<string, any> = {};
	let currentSection: Record<string, any> | null = null;
	let currentKey: string | null = null;

	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		// skip empty / comment lines
		if (!line.trim() || line.trimStart().startsWith("#")) continue;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();

		if (indent === 0) {
			// Top-level key: value
			const colonIdx = trimmed.indexOf(":");
			if (colonIdx === -1) {
				throw new Error(`Malformed YAML line: "${trimmed}"`);
			}
			const key = trimmed.slice(0, colonIdx).trim();
			const val = trimmed.slice(colonIdx + 1).trim();
			currentSection = null;
			currentKey = key;
			if (val === "") {
				// section header (e.g. "delegation:")
				currentSection = {};
				result[key] = currentSection;
			} else {
				result[key] = parseValue(val);
			}
		} else if (indent >= 2 && currentSection !== null) {
			// Nested key: value
			const colonIdx = trimmed.indexOf(":");
			if (colonIdx === -1) {
				throw new Error(`Malformed YAML line: "${trimmed}"`);
			}
			const key = trimmed.slice(0, colonIdx).trim();
			const val = trimmed.slice(colonIdx + 1).trim();

			if (val === "" && currentSection) {
				// 2nd-level section (e.g. "parallel:")
				const subSection: Record<string, any> = {};
				currentSection[key] = subSection;
				currentSection = subSection;
			} else if (currentSection) {
				currentSection[key] = parseValue(val);
			}
		}
	}

	return result;
}

function parseValue(val: string): string | number | boolean {
	if (val === "true") return true;
	if (val === "false") return false;
	const num = Number(val);
	if (!isNaN(num) && val !== "") return num;
	// strip surrounding quotes
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
		return val.slice(1, -1);
	}
	return val;
}

// ─── _extractSessionId ─────────────────────────────────────

export function _extractSessionId(ctx: any): string | undefined {
	if (ctx == null || typeof ctx !== "object") return undefined;
	const sm = ctx.sessionManager;
	if (sm == null || typeof sm !== "object") return undefined;
	return sm.sessionId;
}

// ─── loadOrchestratorConfig ────────────────────────────────

export function loadOrchestratorConfig(): OrchestratorConfig {
	const configPath = _configPath();

	if (!existsSync(configPath)) {
		return structuredClone(DEFAULTS);
	}

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch {
		return structuredClone(DEFAULTS);
	}

	let parsed: Record<string, any>;
	try {
		parsed = _parseYaml(raw);
	} catch (err: any) {
		console.warn("orchestrator-config: malformed YAML, using defaults", err?.message ?? err);
		return structuredClone(DEFAULTS);
	}

	return fillDefaults(parsed);
}

function fillDefaults(parsed: Record<string, any>): OrchestratorConfig {
	const delegation = parsed.delegation && typeof parsed.delegation === "object" ? parsed.delegation : {};
	const parallel = delegation.parallel && typeof delegation.parallel === "object" ? delegation.parallel : {};

	// Parse models section
	let models: OrchestratorConfig['models'];
	const modelsSection = parsed.models && typeof parsed.models === "object" ? parsed.models : null;
	if (modelsSection) {
		models = {};
		if (typeof modelsSection.delegate === "string") {
			models.delegate = modelsSection.delegate;
		}
		// Parse flattened specialist keys: specialist_scout → specialists.scout
		const specialistEntries: Record<string, string> = {};
		for (const [key, val] of Object.entries(modelsSection)) {
			if (key.startsWith("specialist_") && typeof val === "string") {
				const name = key.slice("specialist_".length);
				specialistEntries[name] = val;
			}
		}
		if (Object.keys(specialistEntries).length > 0) {
			models.specialists = specialistEntries;
		}
		if (!models.delegate && !models.specialists) {
			models = undefined;
		}
	}

	return {
		version: typeof parsed.version === "number" ? parsed.version : DEFAULTS.version,
		delegation: {
			mode: delegation.mode ?? DEFAULTS.delegation.mode,
			parallel: {
				maxConcurrent: typeof parallel.maxConcurrent === "number" ? parallel.maxConcurrent : DEFAULTS.delegation.parallel.maxConcurrent,
				timeoutMs: typeof parallel.timeoutMs === "number" ? parallel.timeoutMs : DEFAULTS.delegation.parallel.timeoutMs,
			},
		},
		models,
	};
}

// ─── saveOrchestratorConfig ────────────────────────────────

export function saveOrchestratorConfig(config: OrchestratorConfig): void {
	// Clean up empty sections before saving
	if (config.models?.specialists && Object.keys(config.models.specialists).length === 0) {
		config.models.specialists = undefined;
	}
	if (config.models && !config.models.delegate && !config.models.specialists) {
		config.models = undefined;
	}

	const configPath = _configPath();
	mkdirSync(dirname(configPath), { recursive: true });

	const lines: string[] = [];
	lines.push(`version: ${config.version}`);
	lines.push("delegation:");
	lines.push(`  mode: ${config.delegation.mode}`);
	lines.push("  parallel:");
	lines.push(`    maxConcurrent: ${config.delegation.parallel.maxConcurrent}`);
	lines.push(`    timeoutMs: ${config.delegation.parallel.timeoutMs}`);

	// Write models section if present
	if (config.models) {
		lines.push("models:");
		if (config.models.delegate) {
			lines.push(`  delegate: "${config.models.delegate}"`);
		}
		if (config.models.specialists) {
			for (const [name, modelId] of Object.entries(config.models.specialists)) {
				lines.push(`  specialist_${name}: "${modelId}"`);
			}
		}
	}

	lines.push("");
	writeFileSync(configPath, lines.join("\n"), "utf-8");
}

/**
 * Resolve model ID for a specialist, checking config overrides first.
 * Priority: config.specialists[name] > config.delegate > specialist.model > undefined (inherits parent)
 */
export function resolveSpecialistModel(
	config: OrchestratorConfig,
	specialistName: string,
	specialistModel?: string,
): string | undefined {
	// 1. Per-specialist config override
	if (config.models?.specialists?.[specialistName]) {
		return config.models.specialists[specialistName];
	}
	// 2. Default delegate model
	if (config.models?.delegate) {
		return config.models.delegate;
	}
	// 3. Specialist's own model field
	if (specialistModel) {
		return specialistModel;
	}
	// 4. undefined = inherit from parent (current behavior)
	return undefined;
}

// ─── Session mode helpers ──────────────────────────────────

export function getSessionMode(ctx: any): string {
	const sessionId = _extractSessionId(ctx);
	if (sessionId && _sessionModes.has(sessionId)) {
		return _sessionModes.get(sessionId)!;
	}
	return _currentDefaultMode;
}

export function setSessionMode(ctx: any, mode: string): void {
	const sessionId = _extractSessionId(ctx);
	if (sessionId) {
		_sessionModes.set(sessionId, mode);
	}
}

export function clearSessionMode(sessionId: string): void {
	_sessionModes.delete(sessionId);
}
