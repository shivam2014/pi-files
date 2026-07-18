import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { styledSymbol, getTheme } from "./orchestrator-theme.ts";
import { loadOrchestratorConfig, saveOrchestratorConfig, resolveSpecialistModel } from "./orchestrator-config.ts";
import type { OrchestratorConfig } from "./orchestrator-config.ts";
import { SPECIALISTS } from "./specialists.ts";

// ── Types ──────────────────────────────────────────────────

type ModelRow =
	| { type: "mode"; name: string; value: string }
	| { type: "separator"; name: string; value: string }
	| { type: "all"; name: string; value: string }
	| { type: "specialist"; name: string; value: string };

interface ModelState {
	config: OrchestratorConfig;
	view: "main" | "pick-model";
	selectedIndex: number;
	scrollOffset: number;
	rows: ModelRow[];
	editingTarget: string; // "all" or specialist name
	availableModels: string[];
}

// ── Helpers ────────────────────────────────────────────────

const MAX_VISIBLE = 10;

/** Strip ANSI escape codes to get visible character count. */
function visibleLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

const CURSOR = styledSymbol("nav.cursor");
const SEP_CHAR = "─";
const BOX = {
	topLeft:     styledSymbol("boxRound.topLeft"),
	topRight:    styledSymbol("boxRound.topRight"),
	bottomLeft:  styledSymbol("boxRound.bottomLeft"),
	bottomRight: styledSymbol("boxRound.bottomRight"),
	horizontal:  styledSymbol("boxRound.horizontal"),
	teeRight:    styledSymbol("boxRound.teeRight"),
	teeLeft:     styledSymbol("boxRound.teeLeft"),
};

// ── Component ──────────────────────────────────────────────

export async function showModelTUI(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		// Fallback for non-TUI modes — show status as notification
		const config = loadOrchestratorConfig();
		const defaultModel = config.models?.delegate ?? "(inherited)";
		const specialistCount = Object.keys(config.models?.specialists ?? {}).length;
		ctx.ui.notify([
			`Model Configuration`,
			`Default delegate: ${defaultModel}`,
			`Specialist overrides: ${specialistCount}`,
		].join("\n"), "info");
		return;
	}

	const rawConfig = loadOrchestratorConfig();

	// Filter out stale specialist overrides not in registry
	let removedCount = 0;
	const availableIds = ctx.modelRegistry.getAvailable().map((m: any) => `${m.provider}/${m.id}`);
	if (rawConfig.models?.specialists) {
		for (const key of Object.keys(rawConfig.models.specialists)) {
			if (!availableIds.includes(rawConfig.models.specialists[key])) {
				delete rawConfig.models.specialists[key];
				removedCount++;
			}
		}
		if (Object.keys(rawConfig.models.specialists).length === 0) {
			rawConfig.models.specialists = undefined;
		}
	}
	if (removedCount > 0) {
		ctx.ui.notify(`Warning: Removed ${removedCount} stale model override(s) for unavailable models.`, "warning");
	}

	const availableModels = availableIds;

	const result = await ctx.ui.custom<ModelState | null>(
		(_tui, theme, _kb, done) => {
			const state: ModelState = {
				config: structuredClone(rawConfig),
				view: "main",
				selectedIndex: 0,
				scrollOffset: 0,
				rows: buildRows(structuredClone(rawConfig)),
				editingTarget: "",
				availableModels,
			};

			return {
				handleInput(data: string): void {
					// ── Escape ──
					if (matchesKey(data, Key.escape)) {
						if (state.view === "pick-model") {
							state.view = "main";
							state.selectedIndex = 0;
							state.scrollOffset = 0;
						} else {
							done(state);
						}
						return;
					}

					// ── Enter ──
					if (matchesKey(data, Key.enter)) {
						if (state.view === "main") {
							const row = state.rows[state.selectedIndex];
							if (row.type === "separator") return;
							if (row.type === "mode") {
								// Toggle delegation mode
								state.config.delegation = state.config.delegation || { mode: "sequential", maxTurns: 30, parallel: { maxConcurrent: 4, timeoutMs: 600000 } };
								state.config.delegation.mode = state.config.delegation.mode === "sequential" ? "parallel" : "sequential";
								state.rows = buildRows(state.config);
								return;
							}
							state.editingTarget = row.type === "all" ? "all" : row.name;
							state.view = "pick-model";
							state.selectedIndex = 0;
							state.scrollOffset = 0;
						} else if (state.view === "pick-model") {
							const selectedModel = state.availableModels[state.selectedIndex];
							if (selectedModel) {
								if (state.editingTarget === "all") {
									state.config.models = state.config.models || {};
									state.config.models.delegate = selectedModel;
									// Clear individual specialist overrides — delegate is the new baseline
									state.config.models.specialists = {};
								} else {
									state.config.models = state.config.models || {};
									state.config.models.specialists = state.config.models.specialists || {};
									state.config.models.specialists[state.editingTarget] = selectedModel;
								}
								state.rows = buildRows(state.config);
							}
							state.view = "main";
							state.selectedIndex = 0;
							state.scrollOffset = 0;
						}
						return;
					}

					// ── Navigation ──
					const maxIndex = state.view === "pick-model"
						? state.availableModels.length - 1
						: state.rows.length - 1;

					if (matchesKey(data, Key.up) && state.selectedIndex > 0) {
						state.selectedIndex--;
						// Skip separator
						if (state.view === "main" && state.rows[state.selectedIndex]?.type === "separator") {
							state.selectedIndex = Math.max(0, state.selectedIndex - 1);
						}
					}
					if (matchesKey(data, Key.down) && state.selectedIndex < maxIndex) {
						state.selectedIndex++;
						// Skip separator
						if (state.view === "main" && state.rows[state.selectedIndex]?.type === "separator") {
							state.selectedIndex = Math.min(maxIndex, state.selectedIndex + 1);
						}
					}

					// ── Scroll adjustment for pick-model view ──
					if (state.view === "pick-model") {
						const totalModels = state.availableModels.length;
						if (state.selectedIndex >= state.scrollOffset + MAX_VISIBLE) {
							state.scrollOffset = state.selectedIndex - MAX_VISIBLE + 1;
						}
						if (state.selectedIndex < state.scrollOffset) {
							state.scrollOffset = state.selectedIndex;
						}
						state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, totalModels - MAX_VISIBLE));
					}

					// ── Reset all ──
					if ((data === "r" || data === "R") && state.view === "main") {
						state.config.models = undefined;
						state.rows = buildRows(state.config);
						state.selectedIndex = 0;
					}
				},

				render(width: number): string[] {
					const lines: string[] = [];
					const innerWidth = Math.max(width - 4, 20);

					if (state.view === "pick-model") {
						lines.push(...renderModelPicker(innerWidth, state, theme));
					} else {
						lines.push(...renderMainView(innerWidth, state, theme));
					}

					return lines;
				},

				invalidate(): void {
					// no cache — re-render is cheap
				},

				dispose(): void {},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 64,
				maxHeight: "80%",
			},
		},
	);

	if (result) {
		saveOrchestratorConfig(result.config);
		ctx.ui.notify("Model settings saved.", "info");
	}
}

// ── Row builder ────────────────────────────────────────────

function buildRows(config: OrchestratorConfig): ModelRow[] {
	const specialistNames = Object.keys(SPECIALISTS);
	return [
		{ type: "mode", name: "Delegation mode", value: config.delegation?.mode ?? "sequential" },
		{ type: "separator", name: "", value: "" },
		{ type: "all", name: "Set all delegates", value: config.models?.delegate ?? "(inherit from parent)" },
		{ type: "separator", name: "", value: "" },
		...specialistNames.map((name) => {
			const resolved = resolveSpecialistModel(config, name, SPECIALISTS[name]?.model);
			return {
				type: "specialist" as const,
				name,
				value: resolved ?? "(inherit from parent)",
			};
		}),
	];
}

// ── Main view render ───────────────────────────────────────

function renderMainView(
	innerWidth: number,
	state: ModelState,
	theme: ReturnType<typeof getTheme>,
): string[] {
	const lines: string[] = [];
	const border = theme.fg("border", BOX.horizontal);
	const vert = theme.fg("border", "│");

	// ── Top border ──
	lines.push(
		theme.fg("border", BOX.topLeft) +
		border.repeat(innerWidth) +
		theme.fg("border", BOX.topRight),
	);

	// ── Title ──
	const title = "Model Settings";
	const titlePad = Math.max(0, innerWidth - visibleLen(title));
	const tPadL = Math.floor(titlePad / 2);
	const tPadR = titlePad - tPadL;
	lines.push(
		vert +
		" ".repeat(tPadL) +
		theme.fg("accent", theme.bold(title)) +
		" ".repeat(tPadR) +
		vert,
	);

	// ── Tee ──
	lines.push(
		theme.fg("border", BOX.teeRight) +
		border.repeat(innerWidth) +
		theme.fg("border", BOX.teeLeft),
	);

	// ── Blank line ──
	lines.push(vert + " ".repeat(innerWidth) + vert);

	// ── Rows ──
	for (let i = 0; i < state.rows.length; i++) {
		const row = state.rows[i];
		const isSelected = i === state.selectedIndex;

		if (row.type === "separator") {
			// Separator line
			lines.push(
				vert +
				theme.fg("border", SEP_CHAR.repeat(innerWidth)) +
				vert,
			);
			continue;
		}

		if (row.type === "mode") {
			const icon = row.value === "parallel" ? "⚡" : "🔄";
			const cursor = isSelected ? theme.fg("accent", CURSOR) : " ";
			const name = isSelected
				? theme.fg("accent", theme.bold(row.name))
				: row.name;
			const value = isSelected
				? theme.fg("accent", `${icon} ${row.value}`)
				: theme.fg("muted", `${icon} ${row.value}`);
			const nameWidth = visibleLen(row.name);
			const namePad = Math.max(0, 24 - nameWidth);
			const content = ` ${cursor} ${name}${" ".repeat(namePad)}${value}`;
			const contentWidth = 1 + 1 + nameWidth + namePad + visibleLen(icon) + 1 + visibleLen(row.value);
			const rightPad = Math.max(0, innerWidth - contentWidth);
			lines.push(vert + content + " ".repeat(rightPad) + vert);
			continue;
		}

		// Build display line: "▸ name            value"
		const cursor = isSelected ? theme.fg("accent", CURSOR) : " ";
		const name = isSelected
			? theme.fg("accent", theme.bold(row.name))
			: row.name;
		const value = isSelected
			? theme.fg("accent", row.value)
			: theme.fg("muted", row.value);

		// Pad name column to align values
		const nameWidth = visibleLen(row.name);
		const namePad = Math.max(0, 24 - nameWidth);
		const content = ` ${cursor} ${name}${" ".repeat(namePad)}${value}`;
		const contentWidth = 1 + 1 + nameWidth + namePad + visibleLen(row.value);

		// Pad to inner width
		const rightPad = Math.max(0, innerWidth - contentWidth);
		lines.push(vert + content + " ".repeat(rightPad) + vert);
	}

	// ── Blank line ──
	lines.push(vert + " ".repeat(innerWidth) + vert);

	// ── Hint ──
	const hintText = "  ℹ To configure orchestrator model, use /model";
	const hintPad = Math.max(0, innerWidth - visibleLen(hintText));
	lines.push(vert + theme.fg("dim", hintText) + " ".repeat(hintPad) + vert);

	// ── Footer ──
	const footerText = "[Enter] Edit  [R] Reset all  [Esc] Save & Close";
	const footerPad = Math.max(0, innerWidth - visibleLen(footerText));
	const fPadL = Math.floor(footerPad / 2);
	const fPadR = footerPad - fPadL;
	lines.push(
		theme.fg("border", BOX.bottomLeft) +
		theme.fg("dim", " ".repeat(fPadL) + footerText + " ".repeat(fPadR)) +
		theme.fg("border", BOX.bottomRight),
	);

	return lines;
}

// ── Model picker view render ───────────────────────────────

function renderModelPicker(
	innerWidth: number,
	state: ModelState,
	theme: ReturnType<typeof getTheme>,
): string[] {
	const lines: string[] = [];
	const border = theme.fg("border", BOX.horizontal);
	const vert = theme.fg("border", "│");

	// ── Top border ──
	lines.push(
		theme.fg("border", BOX.topLeft) +
		border.repeat(innerWidth) +
		theme.fg("border", BOX.topRight),
	);

	// ── Title ──
	const title = `Select model for ${state.editingTarget}`;
	const titlePad = Math.max(0, innerWidth - visibleLen(title));
	const tPadL = Math.floor(titlePad / 2);
	const tPadR = titlePad - tPadL;
	lines.push(
		vert +
		" ".repeat(tPadL) +
		theme.fg("accent", theme.bold(title)) +
		" ".repeat(tPadR) +
		vert,
	);

	// ── Tee ──
	lines.push(
		theme.fg("border", BOX.teeRight) +
		border.repeat(innerWidth) +
		theme.fg("border", BOX.teeLeft),
	);

	// ── Blank line ──
	lines.push(vert + " ".repeat(innerWidth) + vert);

	// ── Model list (scrollable window) ──
	const totalModels = state.availableModels.length;
	const start = state.scrollOffset;
	const end = Math.min(start + MAX_VISIBLE, totalModels);
	for (let i = start; i < end; i++) {
		const model = state.availableModels[i];
		const isSelected = i === state.selectedIndex;

		const cursor = isSelected ? theme.fg("accent", CURSOR) : " ";
		const name = isSelected
			? theme.fg("accent", theme.bold(model))
			: model;

		const content = ` ${cursor} ${name}`;
		const contentWidth = 1 + 1 + visibleLen(model);
		const rightPad = Math.max(0, innerWidth - contentWidth);
		lines.push(vert + content + " ".repeat(rightPad) + vert);
	}

	// ── Scroll indicator ──
	if (totalModels > MAX_VISIBLE) {
		const indicator = `  ${start + 1}-${end} of ${totalModels}`;
		const indicatorPad = Math.max(0, innerWidth - visibleLen(indicator));
		lines.push(vert + theme.fg("dim", indicator) + " ".repeat(indicatorPad) + vert);
	}

	// ── Blank line ──
	lines.push(vert + " ".repeat(innerWidth) + vert);

	// ── Footer ──
	const footerText = "[Enter] Confirm  [Esc] Cancel";
	const footerPad = Math.max(0, innerWidth - visibleLen(footerText));
	const fPadL = Math.floor(footerPad / 2);
	const fPadR = footerPad - fPadL;
	lines.push(
		theme.fg("border", BOX.bottomLeft) +
		theme.fg("dim", " ".repeat(fPadL) + footerText + " ".repeat(fPadR)) +
		theme.fg("border", BOX.bottomRight),
	);

	return lines;
}
