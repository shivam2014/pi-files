/**
 * Delegate tool registration — the primary tool orchestrator agents use.
 * Extracted from orchestrator.ts during refactoring.
 *
 * Registers the `delegate(specialist, task)` tool with:
 * - renderCall: shows "delegate SpecialistName: task" inline
 * - renderResult: shows live spinner during execution, ✓ done after
 * - execute: calls runSubagent(), updates plan panel
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Specialist, DelegationMetrics, SubagentContext } from "./types.ts";
import { SPECIALISTS } from "./specialists.ts";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, isAbsolute, basename, extname } from "node:path";
import { runSubagent, type OrchestratorUi } from "./subagent-runner.ts";

import { hasActivePlan, setupPlanPanel, startDelegationStep, finalizePlanStep, errorPlanStep, incrementDelegationCount, decrementDelegationCount, clearPlanIfComplete } from "./plan-panel.ts";
import type { Scope } from "./types.ts";
import { debugLog } from "./debug.ts";
import { ScopeManager } from "./scope-manager.ts";
import { hidePeek, unregisterPeekFeed } from "./peek-overlay.ts";
import { SPINNER_FRAMES, getSpinnerIndex } from "./spinner-state.ts";
import { Text } from "@earendil-works/pi-tui";

// Shared spinner — imported from spinner-state.ts
// (orchestratorActivity is now a local variable in execute())

// Verb mapping for working loader messages during delegation lifecycle
const PRESENT_PARTICIPLE: Record<string, string> = {
	scout: 'Scouting',
	coder: 'Coding',
	reviewer: 'Reviewing',
	researcher: 'Researching',
	writer: 'Writing',
};

const CODE_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".rb", ".go", ".rs", ".java", ".kt",
	".swift", ".cpp", ".cc", ".c", ".h", ".hpp",
	".md", ".txt", ".json", ".yaml", ".yml", ".toml",
]);

const MAX_READ_CHARS = 8_000;
const MAX_ANSWER_CHARS = 10_000;

/**
 * Normalize a path-like token and, if it points to an existing file under cwd,
 * return the absolute path. Returns undefined for non-existent or directory paths
 * unless the caller asked for a directory listing.
 */
function resolveExistingPath(token: string, cwd: string): string | undefined {
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
function extractReferencedPaths(text: string, cwd: string): string[] {
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

function readFilePreview(path: string): string {
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
function tryAnswerFromDocs(question: string, cwd: string): string | undefined {
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

const CONTEXT_STOP_WORDS = new Set([
	"what", "which", "where", "when", "who", "how", "does", "is", "are", "was", "were",
	"the", "this", "that", "these", "those", "from", "with", "for", "and", "you", "your",
	"can", "should", "would", "could", "will", "shall", "may", "might", "must",
]);

function messageContentToString(content: unknown): string {
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
function buildRecentContext(ctx: any): string {
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
function tryAnswerFromContext(question: string, recentContext: string | undefined): string | undefined {
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

/**
 * Parse a `## Scope` block from scout/researcher subagent output into the
 * canonical `Scope` type. Returns `null` if the block is missing or malformed.
 */
export function extractScopeFromOutput(output: string): Scope | null {
    const scopeMatch = output.match(/##\s+Scope\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
    if (!scopeMatch) return null;
    const block = scopeMatch[1];

    const entries: Record<string, unknown> = {};
    const lineRe = /^\s*[-*]\s*(\w+)\s*:\s*(.*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(block)) !== null) {
        const key = m[1];
        const raw = m[2].trim();
        if (raw.startsWith('[') && raw.endsWith(']')) {
            const inner = raw.slice(1, -1).trim();
            entries[key] = inner ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
        } else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
            entries[key] = raw.slice(1, -1);
        } else if (/^\d+$/.test(raw)) {
            entries[key] = parseInt(raw, 10);
        } else if (raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes') {
            entries[key] = true;
        } else if (raw.toLowerCase() === 'false' || raw.toLowerCase() === 'no') {
            entries[key] = false;
        } else {
            entries[key] = raw;
        }
    }

    const scopeKeys = ['filesToModify', 'filesToCreate', 'directories', 'changeType', 'maxLinesPerFile', 'maxFiles', 'requiresApprovalBeyondScope', 'gateMode'];
    if (!scopeKeys.some(k => k in entries)) return null;

    const changeType = entries.changeType === 'single-file' ? 'single-file' : 'multi-file';
    const scope: Scope = {
        filesToModify: Array.isArray(entries.filesToModify) ? entries.filesToModify as string[] : [],
        filesToCreate: Array.isArray(entries.filesToCreate) ? entries.filesToCreate as string[] : [],
        directories: Array.isArray(entries.directories) ? entries.directories as string[] : [],
        maxFiles: typeof entries.maxFiles === 'number' ? entries.maxFiles : 10,
        requiresApprovalBeyondScope: typeof entries.requiresApprovalBeyondScope === 'boolean' ? entries.requiresApprovalBeyondScope : true,
        changeType,
        maxLinesPerFile: typeof entries.maxLinesPerFile === 'number' ? entries.maxLinesPerFile : 400,
        gateMode: entries.gateMode === 'relaxed' || entries.gateMode === 'strict'
            ? entries.gateMode
            : (changeType === 'single-file' ? 'relaxed' : 'strict'),
    };
    return scope;
}

function getDefaultWriterScope(cwd: string): Scope {
    return {
        filesToModify: [],
        filesToCreate: [],
        directories: [cwd],
        maxFiles: 20,
        requiresApprovalBeyondScope: true,
        changeType: 'multi-file',
        maxLinesPerFile: 400,
        gateMode: 'strict',
        boundaries: `Doc-friendly default scope. You may create and modify:\n- *.md files in the current working directory\n- files under docs/ recursively\n- common documentation filenames such as README, AGENTS.md, CLAUDE.md, LICENSE, CONTRIBUTING.md, CHANGELOG.md, CODE_OF_CONDUCT.md, and SECURITY.md`,
    };
}

function extractFindingsFromOutput(output: string): { summary: string; key_files: string[]; issues: string[]; recommendation: string } | null {
    const findingsMatch = output.match(/##\s+Findings\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
    if (!findingsMatch) return null;
    const block = findingsMatch[1];
    const extract = (key: string): string => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*(.+)`, 'i'));
        return m ? m[1].trim() : '';
    };
    const extractList = (key: string): string[] => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*\\[?(.+?)\\]?\\s*$`, 'im'));
        if (!m) return [];
        return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };
    return {
        summary: extract('summary') || '',
        key_files: extractList('key_files'),
        issues: extractList('issues'),
        recommendation: extract('recommendation') || '',
    };
}

function extractAuditFromOutput(output: string): { problems: string[]; resolution: string[]; scope_stayed: boolean; scope_notes: string } | null {
    const auditMatch = output.match(/##\s+Audit\s*\n([\s\S]*?)(?:\n##\s+|\n---|\n*$)/);
    if (!auditMatch) return null;
    const block = auditMatch[1];
    const extractList = (key: string): string[] => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*\\[?(.+?)\\]?\\s*$`, 'im'));
        if (!m) return [];
        return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };
    const extract = (key: string): string => {
        const m = block.match(new RegExp(`-?\\s*${key}:\\s*(.+)`, 'i'));
        return m ? m[1].trim() : '';
    };
    const scopeStayed = extract('scope_stayed').toLowerCase();
    return {
        problems: extractList('problems'),
        resolution: extractList('resolution'),
        scope_stayed: scopeStayed === 'yes' || scopeStayed === 'true',
        scope_notes: extract('scope_notes') || '',
    };
}

/**
 * Register the delegate tool on the pi extension API.
 */
export function registerDelegateTool(pi: ExtensionAPI): void {
	// Scope is now managed by ScopeManager on per-delegation basis — no module-level cache

	pi.registerTool({
		name: "delegate",
		label: "delegate",
		description: "Delegate work to a specialist subagent. Provides specialist name and task.",
		parameters: Type.Object({
			specialist: Type.String({
				description: "Specialist: scout, coder, reviewer, researcher, writer",
			}),
			task: Type.String({
				description: "Task description for the specialist to execute",
			}),
			scope: Type.Optional(Type.Object({
				filesToModify: Type.Array(Type.String(), {
					description: "Existing files the specialist may modify",
				}),
				filesToCreate: Type.Array(Type.String(), {
					description: "New files the specialist may create",
				}),
				directories: Type.Optional(Type.Array(Type.String(), {
					description: "Directory-level scope boundaries",
				})),
				maxFiles: Type.Optional(Type.Number({
					description: "Max files allowed across all directories",
				})),
				requiresApprovalBeyondScope: Type.Optional(Type.Boolean({
					description: "If true, user must approve scope deviations",
				})),
				boundaries: Type.Optional(Type.String({
					description: "Free-text scope boundaries the specialist must respect",
				})),
			}, {
				description: "Structured scope constraints. REQUIRED when specialist=coder. Get this from scout's ## Scope output or declare it yourself based on your analysis.",
			})),
		}),

		// ── Render: what shows when tool is invoked ──
		renderCall(args: any, theme: any, context: any) {
			// Store args so renderResult can show the delegate header exactly once.
			// Rendering the header here would duplicate it with the result feed.
			const state = context.state || (context.state = {});
			state.delegateArgs = { specialist: args.specialist, task: args.task };

			const comp = context.lastComponent ?? new Text("", 0, 0);
			comp.setText("");
			return comp;
		},

		// ── Render: what shows during/after execution ──
		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			const state = context.state as any;
			const details = result.details as any;
			const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";

			if (isPartial && !state.interval) {
					context.invalidate(); // first paint so spinner shows before ✓
					state.interval = setInterval(() => {
						getSpinnerIndex(); // tick shared spinner
						context.invalidate();
					}, 80);
			}
			if (!isPartial && state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}

			const comp = context.lastComponent ?? new Text("", 0, 0);

			const delegateArgs = state.delegateArgs || {};
			const rawName = delegateArgs.specialist || details?.specialist || "";
			const rawTask = delegateArgs.task || details?.task || "";
			const name = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : "";
			const task = rawTask ? rawTask.slice(0, 60) : "";
			const prefix = name
				? theme.fg("toolTitle", theme.bold(`delegate ${name}`)) +
				  (task ? theme.fg("dim", `: ${task}`) : "")
				: "";

			if (isPartial) {
				if (text) state.lastFeedText = text;
				const feedText = text
					? theme.fg("warning", text)
					: theme.fg("warning", `${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} working...`);
				comp.setText(prefix ? `${prefix}\n${feedText}` : feedText);
			} else {
				const feedText = state.lastFeedText || text || "✓ done";
				comp.setText(prefix ? `${prefix}\n${theme.fg("success", feedText)}` : theme.fg("success", feedText));
			}

			return comp;
		},

		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			if (!params.specialist || !params.task) {
				return { content: [{ type: "text" as const, text: "Provide specialist+task" }], details: {} } as any;
			}

				const specialist: Specialist | undefined = SPECIALISTS[params.specialist];
			if (!specialist) {
				const available = Object.keys(SPECIALISTS).join(", ");
				return { content: [{ type: "text" as const, text: `Unknown specialist: "${params.specialist}". Available: ${available}` }], details: {} } as any;
			}

			// Normalize explicit orchestrator scope (no cache)
			let explicitScope: Scope | null = null;
			if (params.scope) {
				explicitScope = {
					...params.scope,
					filesToModify: params.scope.filesToModify ?? [],
					filesToCreate: params.scope.filesToCreate ?? [],
					directories: params.scope.directories ?? [],
					maxFiles: params.scope.maxFiles ?? 10,
					requiresApprovalBeyondScope: params.scope.requiresApprovalBeyondScope ?? true,
					changeType: params.scope.changeType ?? "multi-file",
					maxLinesPerFile: params.scope.maxLinesPerFile ?? 400,
					gateMode: params.scope.gateMode,
					boundaries: params.scope.boundaries,
				};
			}

			// Determine scope for this delegation (coder requires explicit scope, writer has doc-friendly defaults)
			let scopeToUse: Scope | null = null;
			if (params.specialist === "coder") {
				scopeToUse = explicitScope;
				if (!scopeToUse) {
					return {
						content: [{
							type: "text" as const,
							text: `⛔ **Scope required for coder.**

You must pass a \`scope\` parameter when calling coder.

\`\`\`
delegate("coder", "fix the auth middleware", {
    scope: {
        filesToModify: ["src/auth.ts"],
        filesToCreate: [],
        directories: ["src/"],
        maxFiles: 10
    }
})
\`\`\`

The scope tells the coder exactly which files it's allowed to touch.`
						}],
						details: {},
					} as any;
				}
			} else if (params.specialist === "writer") {
				scopeToUse = explicitScope ?? getDefaultWriterScope(ctx.cwd);
			} else {
				scopeToUse = explicitScope ?? null;
			}

			// Write scope for scope-guard enforcement before delegation
			if (scopeToUse) {
				new ScopeManager(ctx.cwd).writeScope(scopeToUse);
			}

			// Set up plan panel — consume or append a step for each delegation
			const specName = specialist.name.charAt(0).toUpperCase() + specialist.name.slice(1);
			const stepLabel = `${specName}: ${params.task}`;

			if (!hasActivePlan()) {
				// Auto-create a 1-step plan from the delegation task (plan tool may have failed to register)
				const autoGoal = params.task;
				const autoSteps = [params.specialist + ": " + params.task];
				setupPlanPanel(autoGoal, autoSteps, ctx);
				startDelegationStep(stepLabel);
			} else {
				startDelegationStep(stepLabel);
			}

			onUpdate?.({
				content: [{ type: "text", text: `${SPINNER_FRAMES[getSpinnerIndex() % SPINNER_FRAMES.length]} ${specialist.name}...` }],
				details: { status: "running", specialist: specialist.name },
			});

			// Dynamic status: delegating
			const orchestratorUi: OrchestratorUi | undefined = ctx?.ui ? ctx.ui : undefined;
			const verb = PRESENT_PARTICIPLE[specialist.name] || 'Working';
			try {
				if (orchestratorUi) {
					orchestratorUi.setWorkingMessage(`Sending to ${specialist.name}...`);
				}
			} catch {}

				incrementDelegationCount();
			// Per-delegation metrics tracking
			const metrics: DelegationMetrics = {
				readCalls: 0,
				grepCalls: 0,
				findCalls: 0,
				editCalls: 0,
				writeCalls: 0,
				bashCalls: 0,
				lsCalls: 0,
				scopeViolations: 0,
			};
			const wrappedOnUpdate = (update: any) => {
				if (update.details?.tool) {
					switch (update.details.tool) {
						case "read": metrics.readCalls++; break;
						case "grep": metrics.grepCalls++; break;
						case "find": metrics.findCalls++; break;
						case "edit": metrics.editCalls++; break;
						case "write": metrics.writeCalls++; break;
						case "bash": metrics.bashCalls++; break;
						case "ls": metrics.lsCalls++; break;
					}
				}
				onUpdate?.(update);
			};

			const startTime = Date.now();

			// Dynamic status: subagent session starting
			try {
				if (orchestratorUi) {
					orchestratorUi.setWorkingMessage(`${verb}...`);
				}
			} catch {}

			const parentCtx: SubagentContext = {
				modelRegistry: ctx.modelRegistry,
				model: ctx.model,
				onAskOrchestrator: createAskOrchestratorResolver(ctx),
			};

			const result = await runSubagent(
				specialist, params.task, ctx.cwd,
				parentCtx,
				signal, wrappedOnUpdate, scopeToUse, orchestratorUi,
			);
			const elapsedMs = Date.now() - startTime;

			// Dynamic status: subagent completed, sending result back
			try {
				if (orchestratorUi) {
					orchestratorUi.setWorkingMessage('Sending to orchestrator...');
				}
			} catch {}

			// === Check for errors/abort BEFORE any parsing ===
			const isAborted = (signal?.aborted || false) || (result?.output?.startsWith("[aborted]") ?? false);
			const isError = !result || !result.output || result.output.startsWith("[error]") || result.output.startsWith("[aborted]");
			const hasError = isAborted || isError;

			try {
				// Only do analysis if no error
				if (!hasError && result?.output) {
					// Dynamic status: processing result
					try {
						if (orchestratorUi) {
							orchestratorUi.setWorkingMessage('Processing...');
						}
					} catch {}

					if (result.output) {
						debugLog("delegate-tool: subagent completed", { specialist: params.specialist, outputLength: result.output.length });
					}

					// Parse scope from scout/researcher output (no caching — coder must receive explicit scope)
					if (params.specialist === "scout" || params.specialist === "researcher") {
						const extractedScope = extractScopeFromOutput(result.output);
						if (extractedScope) {
							debugLog("delegate-tool: scout/researcher produced scope", { specialist: params.specialist, scope: extractedScope });
						}
					}

					const findings = extractFindingsFromOutput(result.output);
					if (findings && findings.summary) {
						const summaryParts = [`[Findings: ${findings.summary}]`];
						if (findings.key_files.length > 0) summaryParts.push(`Files: ${findings.key_files.join(', ')}`);
						if (findings.issues.length > 0 && findings.issues[0] !== 'none') summaryParts.push(`Issues: ${findings.issues.join('; ')}`);
						if (findings.recommendation) summaryParts.push(`Next: ${findings.recommendation}`);
						result.output = summaryParts.join('\n') + '\n\n' + result.output;
					}

					// Prepend execution metadata for orchestrator visibility
					const execStatus = result.output?.startsWith("[error]") ? "error" : "ok";
					const execMeta = [`[Execution: elapsed=${(elapsedMs / 1000).toFixed(1)}s, turns=${result.turns || 0}, status=${execStatus}]`];
					if (execStatus === "error") {
						execMeta.push(`[Error: ${result.output.slice(0, 200)}]`);
					}
					result.output = execMeta.join('\n') + '\n\n' + result.output;

					// Prepend tool call trail for orchestrator visibility
					if (result.toolCallTrail && result.toolCallTrail.length > 0) {
						const trail = result.toolCallTrail.map(t =>
							`${t.completed ? '✓' : '⚠'} ${t.tool}${t.outputPreview ? ` → ${t.outputPreview}` : ''}`
						).join('\n');
						result.output = `[Tool Calls (${result.toolCallTrail.length}):
${trail}
]

` + result.output;
					}

					// Extract audit trail
					const audit = extractAuditFromOutput(result.output);
					if (audit) {
						const auditParts = [];
						if (audit.problems.length > 0 && audit.problems[0] !== 'none') {
							auditParts.push(`Problems: ${audit.problems.join('; ')}`);
							auditParts.push(`Resolution: ${audit.resolution.join('; ')}`);
						}
						if (!audit.scope_stayed) {
							auditParts.push(`Scope deviation: ${audit.scope_notes}`);
							metrics.scopeViolations++;
						}
						if (auditParts.length > 0) {
							result.output = `[Audit: ${auditParts.join(' | ')}]\n` + result.output;
						}
					}

					// Prepend metrics line
					const metricsLine = `[Metrics: read=${metrics.readCalls}, grep=${metrics.grepCalls}, find=${metrics.findCalls}, edit=${metrics.editCalls}, write=${metrics.writeCalls}, bash=${metrics.bashCalls}, ls=${metrics.lsCalls}, scopeViolations=${metrics.scopeViolations}]`;
					result.output = metricsLine + '\n' + result.output;

					// Build status note — first line of returned text so orchestrator sees outcome at a glance
					const turns = result.turns || 0;
					const toolCalls = result.toolCallTrail?.length || 0;
					const turnWord = turns === 1 ? "turn" : "turns";
					const toolWord = toolCalls === 1 ? "tool call" : "tool calls";
					const statusNote = `✓ Completed (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;
					result.output = `${statusNote}\n${result.output}`;
				} else if (result?.output) {
					// Error/Abort path: include tool call trail + status note
					const trail = result.toolCallTrail;
					const turns = result.turns ?? 0;
					const toolCalls = trail?.length ?? 0;
					const turnWord = turns === 1 ? "turn" : "turns";
					const toolWord = toolCalls === 1 ? "tool call" : "tool calls";

					let trailStr = "";
					if (trail && trail.length > 0) {
						trailStr = "\nCompleted tool calls:\n" + trail.map(t => `${t.completed ? '✓' : '⚠'} ${t.tool}`).join("\n");
					}

					const statusNote = isAborted
						? `■ Aborted — interrupted by user (${turns} ${turnWord}, ${toolCalls} ${toolWord})`
						: `✗ Error (${turns} ${turnWord}, ${toolCalls} ${toolWord})`;

					result.output = `${statusNote}${trailStr}\n\n${result.output}`;
				}

				// Mark plan step — now always runs correctly
				if (hasError) {
					errorPlanStep(ctx, isAborted);
				} else {
					finalizePlanStep(ctx);
				}
			} finally {
				decrementDelegationCount();
				clearPlanIfComplete(ctx);  // Clear widget if all steps done (count is now 0)
				hidePeek();
				unregisterPeekFeed();
				// Clear scope after delegation completes
				new ScopeManager(ctx.cwd).clearScope();
				// Dynamic status: clear on completion (even if extraction/parsing throws)
				try {
					if (orchestratorUi) {
						orchestratorUi.setWorkingMessage();
					}
				} catch {}
			}

			return {
				content: [{ type: "text", text: result?.output || "[error] Subagent returned no output" }],
				details: {
					specialist: specialist.name,
					task: params.task,
					status: "done",
					turns: result?.turns || 0,
					outputLength: result?.output?.length || 0,
				},
			};
		},
	});
}
