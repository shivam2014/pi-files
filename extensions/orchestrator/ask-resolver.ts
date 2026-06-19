/**
 * AskResolver — extracted from delegate-tool.ts during Issue #25.
 *
 * Provides the `createAskOrchestratorResolver` factory and all its
 * pure-function dependencies. No delegate-tool coupling.
 *
 * Resolution order:
 * 1. Files referenced in the question
 * 2. Project docs/ directory
 * 3. Recent conversation context
 * 4. User input (escalation)
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, isAbsolute, basename, extname } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

export const CODE_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".rb", ".go", ".rs", ".java", ".kt",
	".swift", ".cpp", ".cc", ".c", ".h", ".hpp",
	".md", ".txt", ".json", ".yaml", ".yml", ".toml",
]);

export const MAX_READ_CHARS = 8_000;
export const MAX_ANSWER_CHARS = 10_000;

export const CONTEXT_STOP_WORDS = new Set([
	"what", "which", "where", "when", "who", "how", "does", "is", "are", "was", "were",
	"the", "this", "that", "these", "those", "from", "with", "for", "and", "you", "your",
	"can", "should", "would", "could", "will", "shall", "may", "might", "must",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a path-like token and, if it points to an existing file under cwd,
 * return the absolute path. Returns undefined for non-existent or directory paths
 * unless the caller asked for a directory listing.
 */
export function resolveExistingPath(token: string, cwd: string): string | undefined {
	if (!token || token.length > 500) return undefined;
	// Strip surrounding quotes/backticks/parens
	let p = token.replace(/^["'`(]+|["'`)]+$/g, "").trim();
	if (!p) return undefined;

	// Ignore obvious non-paths
	if (/^(https?|file):\/\//i.test(p)) return undefined;
	if (p.startsWith("-") || p.startsWith("`")) return undefined;

	let absolute = isAbsolute(p) ? p : resolve(cwd, p);
	if (!existsSync(absolute)) {
		// Try basename-only tokens with common source extensions
		if (!p.includes("/") && !p.includes("\\")) {
			for (const ext of CODE_EXTENSIONS) {
				const candidate = resolve(cwd, p + ext);
				if (existsSync(candidate)) {
					absolute = candidate;
					break;
				}
			}
		}
	}
	if (!existsSync(absolute)) return undefined;

	try {
		const stat = statSync(absolute);
		if (!stat.isFile()) return undefined;
	} catch {
		return undefined;
	}
	return absolute;
}

/**
 * Extract candidate file paths from a block of text. Returns absolute paths
 * of files that actually exist under cwd.
 */
export function extractReferencedPaths(text: string, cwd: string): string[] {
	const seen = new Set<string>();
	const results: string[] = [];

	// Split on whitespace and common delimiters used around paths
	const tokens = text.split(/[\s,;:"'()<>{}\[\]?!]+/);

	// First pass: tokens that contain a slash or backslash
	for (const token of tokens) {
		if (!token || (!token.includes("/") && !token.includes("\\"))) continue;
		const absolute = resolveExistingPath(token, cwd);
		if (absolute && !seen.has(absolute)) {
			seen.add(absolute);
			results.push(absolute);
		}
	}

	// Second pass: tokens ending with known code extensions (for basename refs)
	for (const token of tokens) {
		if (!token || token.includes("/") || token.includes("\\")) continue;
		const ext = extname(token).toLowerCase();
		if (!CODE_EXTENSIONS.has(ext)) continue;
		const absolute = resolveExistingPath(token, cwd);
		if (absolute && !seen.has(absolute)) {
			seen.add(absolute);
			results.push(absolute);
		}
	}

	return results.slice(0, 5);
}

export function readFilePreview(path: string): string {
	try {
		const content = readFileSync(path, "utf-8");
		if (content.length <= MAX_READ_CHARS) return content;
		return content.slice(0, MAX_READ_CHARS) + "\n[file truncated]";
	} catch (err) {
		return `[could not read ${path}: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

/**
 * Try to answer the question from a project's docs/ directory.
 * Matches question keywords against doc filenames.
 */
export function tryAnswerFromDocs(question: string, cwd: string): string | undefined {
	const docsDir = join(cwd, "docs");
	if (!existsSync(docsDir)) return undefined;

	const q = question.toLowerCase();
	let files: string[] = [];
	try {
		files = readdirSync(docsDir, { recursive: true, encoding: "utf-8" }) as string[];
	} catch {
		return undefined;
	}

	// Collect all file paths under docs/
	const docPaths: string[] = [];
	for (const entry of files) {
		const relative = Array.isArray(entry) ? entry[0] : entry;
		const full = join(docsDir, relative);
		try {
			if (statSync(full).isFile()) docPaths.push(full);
		} catch {}
	}

	for (const fullPath of docPaths) {
		const name = basename(fullPath).toLowerCase();
		const stem = basename(fullPath, extname(fullPath)).toLowerCase();
		// Simple keyword match: stem or filename words appear in question
		const words = stem.split(/[-_\s.]+/).filter((w) => w.length > 2);
		const matches = words.some((w) => q.includes(w)) || q.includes(stem);
		if (matches) {
			const content = readFilePreview(fullPath);
			return `From docs/${basename(fullPath)}:\n${content}`;
		}
	}
	return undefined;
}

export function messageContentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				if ((part as any).type === "text") return (part as any).text ?? "";
				if ((part as any).type === "image") return "[image]";
			}
			return "";
		}).join("");
	}
	return "";
}

/**
 * Summarize recent orchestrator conversation turns into a searchable string.
 * Uses ctx.sessionManager.getEntries() if available, otherwise ctx.messages.
 */
export function buildRecentContext(ctx: any): string {
	const entries = ctx?.sessionManager?.getEntries?.();
	if (Array.isArray(entries)) {
		const turns = entries
			.filter((e: any) => e?.type === "message" && e.message?.role && e.message?.content)
			.slice(-10)
			.map((e: any) => {
				const role = e.message.role;
				const text = messageContentToString(e.message.content).trim();
				return text ? `${role}: ${text}` : "";
			})
			.filter(Boolean);
		return turns.join("\n");
	}

	if (Array.isArray(ctx?.messages)) {
		return ctx.messages
			.filter((m: any) => m?.role && m?.content)
			.slice(-10)
			.map((m: any) => `${m.role}: ${messageContentToString(m.content).trim()}`)
			.filter(Boolean)
			.join("\n");
	}

	return "";
}

/**
 * Try to answer the question from the provided conversation context.
 * Simple keyword/fact matching: look for the context line that shares the most
 * significant words with the question.
 */
export function tryAnswerFromContext(question: string, recentContext: string | undefined): string | undefined {
	if (!recentContext || recentContext.trim().length === 0) return undefined;

	const q = question.toLowerCase();
	const qWords = [...new Set(q.split(/[^a-z0-9]+/))]
		.filter((w) => w.length > 3 && !CONTEXT_STOP_WORDS.has(w));
	if (qWords.length === 0) return undefined;

	const lines = recentContext.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	let bestLine: string | undefined;
	let bestScore = 0;

	for (const line of lines) {
		const lower = line.toLowerCase();
		const hits = qWords.filter((w) => lower.includes(w)).length;
		if (hits === 0) continue;
		// Require either 2+ keyword hits or a strong fraction of the question words.
		if (hits < 2 && hits / qWords.length < 0.4) continue;
		if (hits > bestScore) {
			bestScore = hits;
			bestLine = line;
		}
	}

	if (!bestLine) return undefined;
	const answer = `From the current conversation:\n${bestLine}`;
	return answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS) + "\n[answer truncated]" : answer;
}

/**
 * Build the resolver that the subagent calls via ask_orchestrator.
 *
 * Resolution order:
 * 1. Files explicitly referenced in the question/context
 * 2. Project docs/
 * 3. Recent orchestrator conversation context
 * 4. User input (escalation)
 */
export function createAskOrchestratorResolver(ctx: any): (question: string, context?: string) => Promise<string> {
	const cwd = ctx?.cwd ?? process.cwd();
	const recentContext = ctx?.recentContext ?? buildRecentContext(ctx);
	return async (question: string, context?: string) => {
		const combined = context ? `${question}\n\nContext: ${context}` : question;

		// 1. Answer from explicitly referenced files
		const paths = extractReferencedPaths(combined, cwd);
		if (paths.length > 0) {
			const parts = paths.map((p) => `--- ${p}\n${readFilePreview(p)}`);
			const answer = parts.join("\n\n");
			return answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS) + "\n[answer truncated]" : answer;
		}

		// 2. Answer from docs/
		const docAnswer = tryAnswerFromDocs(question, cwd);
		if (docAnswer) return docAnswer;

		// 3. Answer from recent conversation context (include any subagent-supplied context)
		const contextToSearch = [context, recentContext].filter((c) => c && c.trim().length > 0).join("\n\n");
		const contextAnswer = tryAnswerFromContext(question, contextToSearch);
		if (contextAnswer) return contextAnswer;

		// 4. Escalate to user
		if (ctx?.ui?.input) {
			const answer = await ctx.ui.input(question, "Answer for subagent...", { signal: ctx?.signal });
			return answer ?? "[no answer provided]";
		}

		return "[no answer available]";
	};
}
