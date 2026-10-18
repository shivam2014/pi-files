/**
 * Token Saver — All-in-one token compression extension
 *
 * Cache-safe: overrides built-in tools to return compressed output directly.
 * Compression happens BEFORE output enters context, so cached prefix stays clean.
 *
 * 5 compression layers:
 *   1. Output Style — always-on ADHD-shaped reply rules (no toggle)
 *   2. Read Dedup — fingerprint files, return stub on re-read
 *   3. ANSI Strip — remove color codes from tool output
 *   4. Per-Tool Budgets — aggressive line caps per tool
 *   5. Blank Collapse — remove redundant blank lines
 *
 * Install:
 *   ln -s "$(pwd)/token-saver.ts" ~/.pi/agent/extensions/token-saver.ts
 *
 * Commands: /tokenstats, /rtk. The output style is always on — no toggle.
 */

import { createHash } from "node:crypto";
import { createBashTool, createReadTool, createGrepTool, createFindTool, createLsTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

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
// Output style — single always-on constant, no toggle
// ============================================================================

/**
 * ADHD-shaped output rules. Appended to any system prompt that does not already carry the
 * `<communication>` contract (the orchestrator builder and every specialist prompt embed it), so a
 * session gets exactly ONE copy. Mirrors orchestrator/specialists.ts COMMUNICATION_INSTRUCTION.
 */
export const ADHD_PROMPT = `

<communication>
ADHD-shaped output, every turn. All substance, no filler.
1. Lead with the next action — first line is something the reader can do now, not context or plan.
2. Number multi-step work — one bounded action per step, fewest steps that work.
3. End with ONE concrete next action under two minutes, when anything is open.
4. Suppress tangents — finish issue one, offer the second separately at the end.
5. Restate state each turn — step, what is pending.
6. Estimate in real units ("2 minutes", "3 files") — never "some work".
7. Make finished work concrete — say what now works, not that it was "handled".
8. Matter-of-fact errors — cause, then fix. Never "uh oh" or "there seems to be a problem".
9. Cap lists at 5 items — split longer ones into "do now" and "later".
10. No preamble, no recap, no closers — forbidden: "Sure!", "Great question!", "Let me...", "Hope this helps", "Let me know...".
11. No hedging or idioms — "perhaps", "might", "could possibly" → the literal action.

## Auto-Clarity
Drop the shape for security warnings, destructive ops, multi-step ambiguity, or a user request for explanation. Full sentences there; resume after.

## Boundaries
Code, commits, PRs and docs are written normally. "stop adhd mode" / "normal mode" reverts the style.

When a rule fights the task or harness, they win — the shape stays.
</communication>`;

// ============================================================================
// Read dedup
// ============================================================================

const readFingerprints = new Map<string, { hash: string; length: number }>();
const MAX_FINGERPRINTS = 500;

function pruneFingerprints(): void {
    if (readFingerprints.size >= MAX_FINGERPRINTS) {
        // Delete oldest 50% of entries
        const keys = [...readFingerprints.keys()];
        for (let i = 0; i < keys.length / 2; i++) {
            readFingerprints.delete(keys[i]);
        }
    }
}

function hashContent(content: string): string {
	return createHash("md5").update(content).digest("hex").slice(0, 12);
}

// ============================================================================
// Caveman label shortener — for orchestrator step labels
// ============================================================================

/**
 * Truncate a label to max characters with ellipsis.
 * No word stripping, no regex mangling. Pure width control.
 */
export function truncateLabel(s: string, max = 58): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
}

/**
 * Shorten a task description into a compact label.
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
			const nextOffset = budget.maxLines + 1;
			result = `${kept.join("\n")}\n[...${lines.length - budget.maxLines} lines truncated. Use offset=${nextOffset} to continue.]`;
		}
	}

	return result;
}

// ============================================================================
// RTK (Rust Token Killer) integration
// ============================================================================

let rtkAvailable = false;
let rtkEnabled = true;
let rtkWarned = false;

function checkRtkVersion(): boolean {
	try {
		const result = spawnSync("rtk", ["--version"], {
			timeout: 2000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) return false;
		const version = (result.stdout || "").trim();
		const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
		if (!match) return false;
		const major = parseInt(match[1], 10);
		const minor = parseInt(match[2], 10);
		return major > 0 || (major === 0 && minor >= 23);
	} catch {
		return false;
	}
}

function rtkRewrite(command: string): string | null {
	try {
		const result = spawnSync("rtk", ["rewrite", command], {
			timeout: 2000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Exit codes: 0=rewritten, 1=no rewrite, 2=deny, 3=rewritten advisory
		if (result.status === 0 || result.status === 3) {
			const output = (result.stdout || "").trim();
			return output || null;
		}
		return null;
	} catch {
		return null;
	}
}

// ============================================================================
// The Extension
// ============================================================================

export default function (pi: ExtensionAPI) {

	// ── 0. Visual feedback on load ────────────────────────────────────────

	pi.on("session_start", async () => {
		// Clear read fingerprint cache on each session start so subagent
		// sessions get fresh file reads instead of "already read" stubs.
		readFingerprints.clear();

		rtkAvailable = checkRtkVersion();

		// Check orchestrator here (after runtime is initialized, not during load)
		checkOrchestrator(pi);

		const rtkStatus = rtkAvailable ? "rtk ✓" : "";
		pi.sendMessage({
			customType: "token-saver-status",
			content: `[token-saver] Active — adhd-shaped output style${rtkStatus ? ` (${rtkStatus})` : ""}`,
			display: true,
		}, { deliverAs: "steer" });

		// Register bash tool here if orchestrator is not present
		if (!hasOrchestrator) {
			const originalBash = createBashTool(cwd, {
				spawnHook: ({ command, cwd, env }) => {
					if (!rtkEnabled || !rtkAvailable) return { command, cwd, env };
					if (command.startsWith("rtk ")) return { command, cwd, env };
					const rewritten = rtkRewrite(command);
					return { command: rewritten ?? command, cwd, env };
				},
			});
			pi.registerTool({
				...originalBash,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const result = await originalBash.execute(toolCallId, params, signal, onUpdate);
					if (!result.content) return result;

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
		}
	});

	// ── 1. Output Style — always on, injected into the system prompt ───────

	pi.on("before_agent_start", async (event) => {
		// One authoritative copy: the orchestrator builder and every specialist prompt
		// already embed the communication contract (`<communication>…</communication>`),
		// which carries the same style rules. Skip the tone block when it is present.
		if (event.systemPrompt.includes("<communication>")) return;
		return { systemPrompt: event.systemPrompt + ADHD_PROMPT };
	});

	const cwd = process.cwd();

	// We need to defer getAllTools() until runtime is initialized,
	// so compute it lazily inside hook handlers.
	let hasOrchestratorChecked = false;
	let hasOrchestrator = false;

	function checkOrchestrator(pi: ExtensionAPI): void {
		if (!hasOrchestratorChecked) {
		hasOrchestrator = pi.getAllTools().some((t: any) => t.name === 'delegate');
		hasOrchestratorChecked = true;
		}
	}

	// ── 2. Override built-in tools with compressed versions ───────────────
	// Compression happens BEFORE output enters context = cache-safe

	// ── bash: RTK rewrite + ANSI strip + tail 80 lines ──
	// Orchestrator registers its own bash with destructive-op interception.
	// Only register our compressed bash when orchestrator is NOT present (see session_start above).

	// ── 2. Override built-in tools with compressed versions ───────────────
	// Compression happens BEFORE output enters context = cache-safe
	// Note: bash tool is registered in session_start handler (needs getAllTools())
	// Other tools are safe to register at load time.

	// ── read: dedup + line budget ──
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		...originalRead,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await originalRead.execute(toolCallId, params, signal, onUpdate);
			if (!result.content) return result;

			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			// Dedup check
			const path = (params as Record<string, unknown>)?.path || (params as Record<string, unknown>)?.file_path || "unknown";
			const hash = hashContent(text);
			const existing = readFingerprints.get(path as string);

			if (existing && existing.hash === hash) {
				return {
					...result,
					content: [...(result.content ?? []), { type: "text" as const, text: "[note: unchanged since your last read of this file]" }],
				};
			}

			pruneFingerprints();
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
			if (!result.content) return result;

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
			if (!result.content) return result;

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
			if (!result.content) return result;

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

	pi.registerCommand("tokenstats", {
		description: "Show dedup stats and compression info",
		handler: async (_args, ctx) => {
			const entries = Array.from(readFingerprints.entries());
			const totalSaved = entries.reduce((sum, [, v]) => sum + v.length, 0);

			const lines = [
				`Read dedup: ${entries.length} files tracked`,
				`Total bytes fingerprinted: ${(totalSaved / 1024).toFixed(1)}KB`,
				"Style: adhd-shaped output (always on)",
				"",
				"Tool budgets:",
				...Object.entries(BUDGETS).map(
					([name, b]) => `  ${name}: ${b.maxLines} lines${b.stripAnsi ? " (ansi strip)" : ""}${b.tailOnly ? " (tail)" : ""}`
				),
				`RTK: ${rtkAvailable ? "✓" : "✗"} (rewrite ${rtkEnabled ? "ON" : "OFF"})`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("rtk", {
		description: "Toggle RTK rewrite (on/off/status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!rtkAvailable) {
				ctx.ui.notify("RTK binary not found. Install rtk: brew install rtk-ai/rtk/rtk", "warning");
				return;
			}
			if (arg === "on") {
				rtkEnabled = true;
				ctx.ui.notify("RTK rewrite: ON", "info");
			} else if (arg === "off") {
				rtkEnabled = false;
				ctx.ui.notify("RTK rewrite: OFF", "info");
			} else if (arg === "status") {
				ctx.ui.notify(
					`RTK: ${rtkAvailable ? "✓" : "✗"} | rewrite: ${rtkEnabled ? "ON" : "OFF"}\n` +
					`Usage: /rtk [on|off|status]`,
					"info"
				);
			} else {
				// Toggle
				rtkEnabled = !rtkEnabled;
				ctx.ui.notify(`RTK rewrite: ${rtkEnabled ? "ON" : "OFF"}`, "info");
			}
		},
	});
}
