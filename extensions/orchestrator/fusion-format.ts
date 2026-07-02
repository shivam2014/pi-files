export function formatFusionResult(analysis: any, succeeded: any[], failed: any[], panelModels: any[], judgeModel: any): string {
	let text = "## Fusion Analysis\n\n";

	if (analysis?.consensus?.length > 0) {
		text += "### Consensus\n" + analysis.consensus.map((c: string) => `- ${c}`).join("\n") + "\n\n";
	}

	if (analysis?.contradictions?.length > 0) {
		text += "### Contradictions\n";
		for (const c of analysis.contradictions) {
			text += `- **${c.topic}**:\n`;
			for (const s of c.stances || []) {
				text += `  - ${s.model}: ${s.stance}\n`;
			}
		}
		text += "\n";
	}

	if (analysis?.unique_insights?.length > 0) {
		text += "### Unique Insights\n";
		for (const i of analysis.unique_insights) {
			text += `- **${i.model}**: ${i.insight}\n`;
		}
		text += "\n";
	}

	if (analysis?.blind_spots?.length > 0) {
		text += "### Blind Spots\n" + analysis.blind_spots.map((b: string) => `- ${b}`).join("\n") + "\n\n";
	}

	if (analysis?.recommendations?.length > 0) {
		text += "### Recommendations\n" + analysis.recommendations.map((r: string) => `- ${r}`).join("\n") + "\n\n";
	}

	text += "### Panel\n\n";
	for (const r of succeeded) {
		text += `**${r.model}**:\n`;
		if (r.reports?.length) {
			for (const report of r.reports) {
				text += `  ✓ ${report}\n`;
			}
		} else {
			// Fallback: show first line of content if no reports
			const firstLine = r.content?.split("\n")[0] || "(no analysis)";
			text += `  ${firstLine}\n`;
		}
		text += "\n";
	}
	if (failed.length > 0) {
		text += "\n### Failed\n" + failed.map((r: any) => `- **${r.model}**: ${r.error}`).join("\n") + "\n";
	}
	if (analysis) {
		text += "### Judge\n\n";
		text += `**${judgeModel.id}**:\n`;
		if (analysis.consensus?.length) {
			for (const item of analysis.consensus) {
				text += `  ✓ ${item}\n`;
			}
		}
		if (analysis.contradictions?.length) {
			for (const item of analysis.contradictions) {
				const topic = typeof item === "string" ? item : item.topic || "";
				text += `  ⚡ Contradiction: ${topic}\n`;
			}
		}
		if (analysis.blind_spots?.length) {
			for (const item of analysis.blind_spots) {
				text += `  ⚠ Blind spot: ${item}\n`;
			}
		}
		if (analysis.recommendations?.length) {
			for (const item of analysis.recommendations) {
				text += `  → ${item}\n`;
			}
		}
		text += "\n";
	}

	return text;
}

export function formatPanelResults(
	succeeded: any[],
	failed: any[] = [],
	judgeModel?: any,
	judgeError?: string,
): { content: Array<{ type: "text"; text: string }>; details: { status: string; responses: any[]; errors: any[]; judgeError?: string } } {
	let text = "## Panel Responses\n\n";
	if (succeeded.length > 0) {
		text += succeeded.map((r: any) => `### ${r.model}\n${r.content}`).join("\n\n");
	} else {
		text += "*(No panel model succeeded)*";
	}

	const displayErrors = failed.slice();
	if (judgeModel && judgeError) {
		displayErrors.push({ model: judgeModel.id, error: judgeError });
	}

	if (displayErrors.length > 0) {
		text += "\n\n### Failed\n" + displayErrors.map((r: any) => `- **${r.model}**: ${r.error || "Unknown error (empty response)"}`).join("\n");
	}

	if (judgeModel && judgeError) {
		text += `\n\n*(No judge available — ${judgeModel.id} failed: ${judgeError})*`;
	} else if (!judgeModel) {
		text += "\n\n*(No judge available — judge model not configured or call failed)*";
	}

	return {
		content: [{ type: "text" as const, text }],
		details: { status: "no_judge", responses: succeeded, errors: displayErrors, judgeError },
	};
}
