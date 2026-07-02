import type { FusionAnalysis } from "./types.ts";

export function extractJsonObject(text: string): string | null {
	if (!text) return null;

	// Strip markdown fences
	const withoutFences = text
		.replace(/```(?:json)?\s*([\s\S]*?)```/g, (_, inner: string) => inner)
		.trim();

	const objects: string[] = [];
	let inString = false;
	let escape = false;
	let depth = 0;
	let start = -1;

	for (let i = 0; i < withoutFences.length; i++) {
		const char = withoutFences[i];

		if (escape) {
			escape = false;
			continue;
		}
		if (char === "\\") {
			escape = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;

		if (char === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (char === "}") {
			if (depth > 0) {
				depth--;
				if (depth === 0 && start !== -1) {
					objects.push(withoutFences.slice(start, i + 1));
					start = -1;
				}
			}
		}
	}

	return objects.length > 0 ? objects[objects.length - 1] : null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isContradictions(value: unknown): value is FusionAnalysis["contradictions"] {
	if (!Array.isArray(value)) return false;
	return value.every(
		(c) =>
			typeof c === "object" &&
			c !== null &&
			typeof (c as any).topic === "string" &&
			Array.isArray((c as any).stances) &&
			(c as any).stances.every(
				(s: unknown) =>
					typeof s === "object" &&
					s !== null &&
					typeof (s as any).model === "string" &&
					typeof (s as any).stance === "string",
			),
	);
}

function isUniqueInsights(value: unknown): value is FusionAnalysis["unique_insights"] {
	if (!Array.isArray(value)) return false;
	return value.every(
		(i) =>
			typeof i === "object" &&
			i !== null &&
			typeof (i as any).model === "string" &&
			typeof (i as any).insight === "string",
	);
}

export function parseJudgeAnalysis(text: string): FusionAnalysis | null {
	const jsonText = extractJsonObject(text);
	if (!jsonText) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const a = parsed as Record<string, unknown>;

	if (
		!isStringArray(a.consensus) ||
		!isContradictions(a.contradictions) ||
		!isUniqueInsights(a.unique_insights) ||
		!isStringArray(a.blind_spots) ||
		!isStringArray(a.recommendations)
	) {
		return null;
	}

	return {
		consensus: a.consensus,
		contradictions: a.contradictions,
		unique_insights: a.unique_insights,
		blind_spots: a.blind_spots,
		recommendations: a.recommendations,
	};
}
