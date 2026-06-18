import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem, matchesKey, Key } from "@earendil-works/pi-tui";
import { loadFusionConfig, saveFusionConfig } from "./fusion-tool.ts";

interface FusionUIState {
	enabled: boolean;
	panel: string[];
	judge: string;
	temperature: number;
}

type Section = "enabled" | "panel" | "judge" | "temp" | "save";

export async function showFusionTUI(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		// Fallback for non-TUI modes — show status as notification
		const config = loadFusionConfig(ctx.cwd);
		const status = config.enabled ? "✅ Enabled" : "❌ Disabled";
		ctx.ui.notify([
			`Fusion Status`,
			`State: ${status}`,
			`Panel: ${config.panel?.join(", ") || "auto-diverse"}`,
			`Judge: ${config.judge || "auto-diverse"}`,
			`Temperature: ${config.temperature ?? 0.3}`,
		].join("\n"), "info");
		return;
	}

	const config = loadFusionConfig(ctx.cwd);
	const models = ctx.modelRegistry.getAvailable();

	const result = await ctx.ui.custom<FusionUIState | null>(
		(_tui, theme, _kb, done) => {
			const state: FusionUIState = {
				enabled: config.enabled ?? true,
				panel: config.panel?.slice() ?? [],
				judge: config.judge ?? "",
				temperature: config.temperature ?? 0.3,
			};

			let currentSection: Section = "enabled";
			let panelSubView = false;
			let judgeSubView = false;
			let panelSelectList: SelectList | null = null;
			let judgeSelectList: SelectList | null = null;

			// Build selectable model items from registry
			const modelItems: SelectItem[] = models.map((m: any) => ({
				value: `${m.provider}/${m.id}`,
				label: `${m.provider}/${m.name || m.id}`,
				description: m.id,
			}));

			const slTheme = getSelectListTheme();

			function enterPanelSubView(): void {
				panelSubView = true;
				panelSelectList = new SelectList(modelItems, 15, slTheme);
				const firstIdx = modelItems.findIndex((item) => state.panel.includes(item.value));
				if (firstIdx >= 0) panelSelectList.setSelectedIndex(firstIdx);
			}

			function enterJudgeSubView(): void {
				judgeSubView = true;
				judgeSelectList = new SelectList(modelItems, 15, slTheme);
				if (state.judge) {
					const idx = modelItems.findIndex((item) => item.value === state.judge);
					if (idx >= 0) judgeSelectList.setSelectedIndex(idx);
				}
			}

			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const border = theme.fg("muted", "─");
					const iw = Math.max(width - 4, 20);

					// ── Title bar ──
					lines.push(theme.fg("muted", `┌${border.repeat(Math.max(0, width - 2))}┐`));
					const title = theme.fg("accent", " Fusion Settings ");
					const padR = Math.max(0, width - 4 - title.length);
					lines.push(theme.fg("muted", `│`) + ` ${title}` + " ".repeat(padR) + theme.fg("muted", `│`));
					lines.push(theme.fg("muted", `├${border.repeat(Math.max(0, width - 2))}┤`));

					if (panelSubView && panelSelectList) {
						lines.push(theme.fg("accent", " Select panel models (Space to toggle, Enter confirm)"));
						lines.push(theme.fg("muted", " " + "─".repeat(iw)));
						for (const line of panelSelectList.render(iw)) {
							lines.push(" " + line);
						}
						if (state.panel.length > 0) {
							lines.push(theme.fg("muted", ` Selected: ${state.panel.map((v) => v.split("/")[1]).join(", ")}`));
						}
					} else if (judgeSubView && judgeSelectList) {
						lines.push(theme.fg("accent", " Select judge model (Enter to select)"));
						lines.push(theme.fg("muted", " " + "─".repeat(iw)));
						for (const line of judgeSelectList.render(iw)) {
							lines.push(" " + line);
						}
						if (state.judge) {
							lines.push(theme.fg("muted", ` Selected: ${state.judge.split("/")[1]}`));
						}
					} else {
						// ── Main settings view ──
						const rows: { key: Section; label: string }[] = [
							{ key: "enabled", label: "Enabled" },
							{ key: "panel", label: `Panel [${state.panel.length} model${state.panel.length !== 1 ? "s" : ""}]` },
							{ key: "judge", label: `Judge ${state.judge ? "(" + state.judge.split("/")[1] + ")" : "(auto-diverse)"}` },
							{ key: "temp", label: `Temperature: ${state.temperature}` },
							{ key: "save", label: "Save & Exit" },
						];

						for (const r of rows) {
							const focused = r.key === currentSection;
							const prefix = focused ? theme.fg("accent", "▸ ") : "  ";
							if (r.key === "enabled") {
								const toggle = state.enabled ? theme.fg("success", "ON") : theme.fg("error", "OFF");
								lines.push(`${prefix}${r.label}: ${toggle}`);
							} else if (r.key === "save") {
								lines.push("");
								lines.push(`${prefix}${focused ? theme.bold(r.label) : r.label}`);
							} else {
								lines.push(`${prefix}${r.label}`);
							}
						}
					}

					lines.push(theme.fg("muted", `└${border.repeat(Math.max(0, width - 2))}┘`));
					lines.push(theme.fg("muted", " ↑↓ navigate  Space toggle  Enter interact  Esc save & exit "));
					return lines;
				},

				handleInput(data: string): void {
					if (panelSubView && panelSelectList) {
						handlePanelSubInput(data);
						return;
					}
					if (judgeSubView && judgeSelectList) {
						handleJudgeSubInput(data);
						return;
					}
					handleMainInput(data);
				},

				invalidate(): void {
					// no cache to invalidate
				},
			};

			function handleMainInput(data: string): void {
				const sections: Section[] = ["enabled", "panel", "judge", "temp", "save"];
				if (matchesKey(data, Key.up)) {
					const idx = sections.indexOf(currentSection);
					currentSection = sections[(idx - 1 + sections.length) % sections.length];
					return;
				}
				if (matchesKey(data, Key.down)) {
					const idx = sections.indexOf(currentSection);
					currentSection = sections[(idx + 1) % sections.length];
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (currentSection === "enabled") {
						state.enabled = !state.enabled;
					} else if (currentSection === "panel") {
						enterPanelSubView();
					} else if (currentSection === "judge") {
						enterJudgeSubView();
					} else if (currentSection === "temp") {
						const temps = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0];
						const idx = temps.indexOf(state.temperature);
						state.temperature = temps[(idx + 1) % temps.length];
					} else if (currentSection === "save") {
						done(state);
					}
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
			}

			function handlePanelSubInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					panelSubView = false;
					panelSelectList = null;
					return;
				}
				if (matchesKey(data, Key.enter)) {
					panelSubView = false;
					panelSelectList = null;
					return;
				}
				if (matchesKey(data, Key.space)) {
					const item = panelSelectList!.getSelectedItem();
					if (item) {
						const idx = state.panel.indexOf(item.value);
						if (idx >= 0) {
							state.panel.splice(idx, 1);
						} else if (state.panel.length < 5) {
							state.panel.push(item.value);
						}
					}
					return;
				}
				// Delegate navigation, filtering to SelectList
				panelSelectList!.handleInput(data);
			}

			function handleJudgeSubInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					judgeSubView = false;
					judgeSelectList = null;
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const item = judgeSelectList!.getSelectedItem();
					if (item) {
						state.judge = item.value;
					}
					judgeSubView = false;
					judgeSelectList = null;
					return;
				}
				// Delegate navigation, filtering to SelectList
				judgeSelectList!.handleInput(data);
			}
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
		saveFusionConfig(ctx.cwd, {
			enabled: result.enabled,
			panel: result.panel,
			judge: result.judge,
			temperature: result.temperature,
			maxPanelModels: config.maxPanelModels ?? 3,
			maxTokensPerPanel: config.maxTokensPerPanel ?? 2048,
			maxTokensForJudge: config.maxTokensForJudge ?? 4096,
		});
	}
}
