import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadFusionConfig, saveFusionConfig } from "./fusion-tool.ts";
import { showFusionTUI } from "./fusion-tui.ts";

export function registerFusionCommands(pi: ExtensionAPI): void {
	pi.registerCommand("fusion", {
		description: "Manage Fusion settings — interactive TUI or quick toggle/status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "on") {
				const config = loadFusionConfig(ctx.cwd);
				config.enabled = true;
				saveFusionConfig(ctx.cwd, config);
				ctx.ui.notify("✅ Fusion enabled", "info");
				return;
			}
			if (trimmed === "off") {
				const config = loadFusionConfig(ctx.cwd);
				config.enabled = false;
				saveFusionConfig(ctx.cwd, config);
				ctx.ui.notify("❌ Fusion disabled", "warning");
				return;
			}
			if (trimmed === "status") {
				const config = loadFusionConfig(ctx.cwd);
				const status = config.enabled ? "✅ Enabled" : "❌ Disabled";
				ctx.ui.notify([
					`**Fusion Status**`,
					`State: ${status}`,
					`Panel: ${config.panel?.join(", ") || "auto-diverse"}`,
					`Judge: ${config.judge || "auto-diverse"}`,
					`Temperature: ${config.temperature ?? 0.3}`,
				].join("\n"), "info");
				return;
			}
			// Open interactive TUI
			await showFusionTUI(ctx);
		},
	});
}
