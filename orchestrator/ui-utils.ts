/**
 * UI utilities — box-drawing helpers and duration formatting.
 * Extracted from orchestrator.ts during refactoring.
 * Design spec: ORCHESTRATION-UI-DESIGN.md
 */

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

export function wrapInBox(lines: string[], boxWidth: number, contentColor?: (text: string) => string): string {
	const out: string[] = [];
	for (const line of lines) {
		const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
		const padded = clean.length > boxWidth - 4
			? clean.slice(0, boxWidth - 4)
			: clean + " ".repeat(boxWidth - 4 - clean.length);
		const coloredContent = contentColor ? contentColor(padded) : padded;
		out.push(`│ ${coloredContent} │`);
	}
	out.push(`╰${("─").repeat(boxWidth - 2)}╯`);
	return out.join("\n");
}

export function wrapInBoxStatic(lines: string[], boxWidth: number): string {
	const out: string[] = [];
	for (const line of lines) {
		const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
		const padded = clean.length > boxWidth - 4
			? clean.slice(0, boxWidth - 4)
			: clean + " ".repeat(boxWidth - 4 - clean.length);
		out.push(`│ ${padded} │`);
	}
	out.push(`╰${("─").repeat(boxWidth - 2)}╯`);
	return out.join("\n");
}
