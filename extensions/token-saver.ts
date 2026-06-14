/**
 * Token Saver — All-in-one token compression extension
 *
 * Cache-safe: overrides built-in tools to return compressed output directly.
 * Compression happens BEFORE output enters context, so cached prefix stays clean.
 *
 * 5 compression layers:
 *   1. Terse Mode — instructs model to reply without filler
 *   2. Read Dedup — fingerprint files, return stub on re-read
 *   3. ANSI Strip — remove color codes from tool output
 *   4. Per-Tool Budgets — aggressive line caps per tool
 *   5. Blank Collapse — remove redundant blank lines
 *
 * Install:
 *   ln -s "$(pwd)/token-saver.ts" ~/.pi/agent/extensions/token-saver.ts
 *
 * Configure via /caveman command.
 */

import { createHash } from "node:crypto";
import { createBashTool, createReadTool, createGrepTool, createFindTool, createLsTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// ANSI regex
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

// ============================================================================
// Per-tool budgets
// ============================================================================

interface ToolBudget {
	maxLines: number;
	stripAnsi: boolean;
	tailOnly: boolean;
}

const BUDGETS: Record<string, ToolBudget> = {
	bash: { maxLines: 80, stripAnsi: true, tailOnly: true },
	read: { maxLines: 300, stripAnsi: false, tailOnly: false },
	grep: { maxLines: 120, stripAnsi: false, tailOnly: false },
	find: { maxLines: 120, stripAnsi: false, tailOnly: false },
	ls: { maxLines: 80, stripAnsi: true, tailOnly: false },
};

// ============================================================================
// Terse mode prompts
// ============================================================================

const TERSE_PROMPTS: Record<string, string> = {
	lite: `\n\n## Reply Style: Terse
- Use fragments, not sentences
- No filler: "Great question!", "Sure!", "Let me help"
- No hedging: "I think", "It seems", "You might want to"
- Bullet points > paragraphs
- Code > explanation`,

	full: `\n\nRespond terse like smart caveman. All technical substance stay. Only fluff die.\n\n## Persistence\nACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.\n\n## Rules\nDrop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.\nPattern: [thing] [action] [reason]. [next step].\n\nBad: "Sure! I\'d be happy to help you with that..."\nGood: "Bug in auth middleware. Token expiry check use \'<\' not \'<=\'. Fix:"\n\n## Auto-Clarity\nDrop caveman for: security warnings, destructive ops, multi-step ambiguity, user asks clarify. Resume after clear part done.\n\n## Boundaries\nCode/commits/PRs: write normal. "stop caveman" or "normal mode": revert. Think short too. No verbose CoT.`,

	ultra: `\n\n## Reply Style: Ultra-Minimal
- Maximum 3 words per line
- No sentences at all
- Only: facts, paths, code
- Example: "src/auth.ts:42 — null check missing"
- If longer than 10 words, it's too long`,
};

// ============================================================================
// Read dedup
// ============================================================================

const readFingerprints = new Map<string, { hash: string; length: number }>();

function hashContent(content: string): string {
	return createHash("md5").update(content).digest("hex").slice(0, 12);
}

// ============================================================================
// Caveman label shortener — for orchestrator step labels
// ============================================================================

/**
 * Shorten a task description into a terse caveman label.
 * Rules: no filler, no articles, abbreviate, max ~40 chars.
 */
export function shortenLabel(label: string): string {
	let s = label;

	// Strip URLs
	s = s.replace(/https?:\/\/[^\s]+/g, "");

	// Strip {previous} placeholder
	s = s.replace(/\{\{previous\}\}|\{previous\}/g, "");

	// Strip common prefixes/suffixes
	s = s.replace(/^(Based on this|Task|Step \d+:?|Question|Answer)\s*:?\s*/gi, "");
	s = s.replace(/\s*:?\s*(Return|Output|Answer|Question|Summarize)\b.*$/gi, "");
	s = s.replace(/\{previous\}/g, "");

	// Remove all filler words aggressively
	s = s.replace(/\b(the|a|an|for|to|in|at|of|on|from|by|with|using|via|is|are|was|were|be|been|being|has|have|had|do|does|did|will|would|could|should|may|might|can|shall|must|need|this|that|these|those|it|its|and|or|but|if|then|else|when|while|where|how|what|which|who|whom|whose|why|also|just|only|even|still|already|yet|ever|never|always|often|sometimes|usually|really|very|quite|too|enough|almost|nearly|about|around|over|under|between|through|during|before|after|above|below|up|down|out|off|into|onto|upon|toward|towards|across|along|against|among|around|behind|beside|beyond|inside|outside|within|without|please|kindly|can you|could you|would you|I need you to|I want you to|make sure to|be sure to|concise|briefly|bullet points?|and report what you find|keep it under \d+ lines?|return concise)\b/gi, "");

	// Remove punctuation and special chars
	s = s.replace(/[,;:!?"'()\[\]{}|]/g, " ");
	s = s.replace(/~/g, " ");
	s = s.replace(/\d+/g, " "); // Remove numbers
	s = s.replace(/_/g, " ");
	s = s.replace(/\//g, " ");

	// Collapse whitespace
	s = s.replace(/\s+/g, " ").trim();

	// If empty after cleanup, return generic
	if (!s) return "task";

	// Split into words, keep only meaningful ones (3+ chars, not common stop words)
	const stopWords = new Set([
		"this", "that", "with", "from", "have", "been", "were", "your", "you",
		"will", "does", "into", "about", "also", "just", "only", "can",
		"should", "would", "could", "might", "must", "shall", "may",
		"not", "but", "and", "for", "the", "its", "over", "under",
		"zero", "none", "empty", "new", "existing", "best", "one",
		"approach", "consider", "based", "what", "how", "why",
		"line", "lines", "concise", "document", "include",
	]);

	const words = s.split(" ").filter((w) => w.length >= 3 && !stopWords.has(w.toLowerCase()));

	// Take first 5 meaningful words
	const short = words.slice(0, 5).join(" ");

	return short || "task";
}

// ============================================================================
// Compression engine
// ============================================================================

function compress(content: string, budget: ToolBudget): string {
	let result = content;

	if (budget.stripAnsi) {
		result = stripAnsi(result);
	}

	result = result.replace(/\n{3,}/g, "\n\n");

	const lines = result.split("\n");
	if (lines.length > budget.maxLines) {
		if (budget.tailOnly) {
			const kept = lines.slice(-budget.maxLines);
			result = `[...${lines.length - budget.maxLines} lines above]\n${kept.join("\n")}`;
		} else {
			const kept = lines.slice(0, budget.maxLines);
			result = `${kept.join("\n")}\n[...${lines.length - budget.maxLines} lines truncated]`;
		}
	}

	return result;
}

// ============================================================================
// State
// ============================================================================

let currentTerseMode: "off" | "lite" | "full" | "ultra" = "full";
let enabled = true;

// ============================================================================
// The Extension
// ============================================================================

export default function (pi: ExtensionAPI) {

	// ── 0. Visual feedback on load ────────────────────────────────────────

	pi.on("session_start", async () => {
		if (enabled) {
			pi.sendMessage({
				customType: "token-saver-status",
				content: `[token-saver] Active — ${currentTerseMode} mode`,
				display: true,
			}, { deliverAs: "steer" });
		}
	});

	// ── 1. Terse Mode — inject into system prompt ─────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		const prompt = TERSE_PROMPTS[currentTerseMode];
		if (!prompt) return;
		return { systemPrompt: event.systemPrompt + prompt };
	});

	// ── 2. Override built-in tools with compressed versions ───────────────
	// Compression happens BEFORE output enters context = cache-safe

	const cwd = process.cwd();

	// ── bash: ANSI strip + tail 80 lines ──
	const originalBash = createBashTool(cwd);
	pi.registerTool({
		...originalBash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await originalBash.execute(toolCallId, params, signal, onUpdate);
			if (!enabled || !result.content) return result;

			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			const budget = BUDGETS.bash;
			const compressed = compress(text, budget);

			if (compressed === text) return result;
			return { ...result, content: [{ type: "text", text: compressed }] };
		},
	});

	// ── read: dedup + line budget ──
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		...originalRead,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await originalRead.execute(toolCallId, params, signal, onUpdate);
			if (!enabled || !result.content) return result;

			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			// Dedup check
			const path = (params as Record<string, unknown>)?.path || (params as Record<string, unknown>)?.file_path || "unknown";
			const hash = hashContent(text);
			const existing = readFingerprints.get(path as string);

			if (existing && existing.hash === hash) {
				const lines = text.split("\n").length;
				return {
					...result,
					content: [{ type: "text", text: `[already read: ${path} — ${lines} lines, ${text.length} bytes, unchanged]` }],
				};
			}

			readFingerprints.set(path as string, { hash, length: text.length });

			// Line budget
			const budget = BUDGETS.read;
			const compressed = compress(text, budget);
			if (compressed === text) return result;
			return { ...result, content: [{ type: "text", text: compressed }] };
		},
	});

	// ── grep: line budget ──
	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		...originalGrep,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await originalGrep.execute(toolCallId, params, signal, onUpdate);
			if (!enabled || !result.content) return result;

			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			const budget = BUDGETS.grep;
			const compressed = compress(text, budget);
			if (compressed === text) return result;
			return { ...result, content: [{ type: "text", text: compressed }] };
		},
	});

	// ── find: line budget ──
	const originalFind = createFindTool(cwd);
	pi.registerTool({
		...originalFind,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await originalFind.execute(toolCallId, params, signal, onUpdate);
			if (!enabled || !result.content) return result;

			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			const budget = BUDGETS.find;
			const compressed = compress(text, budget);
			if (compressed === text) return result;
			return { ...result, content: [{ type: "text", text: compressed }] };
		},
	});

	// ── ls: ANSI strip + line budget ──
	const originalLs = createLsTool(cwd);
	pi.registerTool({
		...originalLs,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await originalLs.execute(toolCallId, params, signal, onUpdate);
			if (!enabled || !result.content) return result;

			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			const budget = BUDGETS.ls;
			const compressed = compress(text, budget);
			if (compressed === text) return result;
			return { ...result, content: [{ type: "text", text: compressed }] };
		},
	});

	// ── 3. Commands ──────────────────────────────────────────────────────

	pi.registerCommand("caveman", {
		description: "Toggle token compression (lite/full/ultra/off)",
		handler: async (args, ctx) => {
			const level = args.trim().toLowerCase() as "lite" | "full" | "ultra" | "off";

			if (!level || !["lite", "full", "ultra", "off"].includes(level)) {
				ctx.ui.notify(
					`Token saver: ${enabled ? "ON" : "OFF"} (${currentTerseMode})\n` +
					`Usage: /caveman [lite|full|ultra|off]\n\n` +
					`Budgets: bash:80 read:300 grep:120`,
					"info",
				);
				return;
			}

			if (level === "off") {
				enabled = false;
				currentTerseMode = "off";
				ctx.ui.notify("Token saver: OFF", "info");
			} else {
				enabled = true;
				currentTerseMode = level;
				ctx.ui.notify(`Token saver: ${level}`, "info");
			}
		},
	});

	pi.registerCommand("tokenstats", {
		description: "Show dedup stats and compression info",
		handler: async (_args, ctx) => {
			const entries = Array.from(readFingerprints.entries());
			const totalSaved = entries.reduce((sum, [, v]) => sum + v.length, 0);

			const lines = [
				`Read dedup: ${entries.length} files tracked`,
				`Total bytes fingerprinted: ${(totalSaved / 1024).toFixed(1)}KB`,
				`Mode: ${currentTerseMode}`,
				`Enabled: ${enabled}`,
				"",
				"Tool budgets:",
				...Object.entries(BUDGETS).map(
					([name, b]) => `  ${name}: ${b.maxLines} lines${b.stripAnsi ? " (ansi strip)" : ""}${b.tailOnly ? " (tail)" : ""}`
				),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
