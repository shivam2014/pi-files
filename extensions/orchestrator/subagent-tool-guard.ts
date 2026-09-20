/**
 * Subagent tool call enforcement — blocks non-native tools, enforces scope.
 * Depends on BashInterceptor, ScopeGuard, and orchestrator state.
 */

import { getBashToolReplacement } from "./bash-interceptor.ts";
import { isWriteCommand } from "./bash-classifier.ts";
import { ScopeGuard } from "./scope-guard.ts";
import type { SubagentState } from "./subagent-sessions.ts";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { debugLog } from "./debug.ts";
import { traceToolCallEntry, tracePathsExtracted, tracePathResolved, traceScopeCheck, traceDecision } from "./debug-path-trace.ts";
import { resolve } from "node:path";
import * as os from 'os';

/** Tools that never modify state — always safe to allow */
const readOnlyTools = new Set(['read', 'grep', 'find', 'ls', 'git-read', 'head', 'tail', 'wc', 'file', 'web_search', 'fetch_content', 'read_skill', 'vision_query', 'glob', 'planSteps', 'advanceStep', 'reportFinding', 'ask_orchestrator']);

/** Check if a bash call should be intercepted and replaced with a native tool. */
function checkBashInterception(
	event: any,
	override: boolean,
): { block: true; reason: string } | undefined {
	if (event.toolName !== 'bash') return undefined;
	const command = isToolCallEventType('bash', event) ? event.input.command : event.input?.command;
	const replacement = getBashToolReplacement(command, override);
	if (!replacement.allowed) {
		return {
			block: true,
			reason: replacement.reason || `Bash command blocked (command: ${command?.trim().split(/\s+/)[0]}). Set override:true to bypass.`,
		};
	}
	if (replacement.tool) {
		return {
			block: true,
			reason: `Use ${replacement.tool} instead of bash (command: ${command?.trim().split(/\s+/)[0]}). Set override:true in tool input to force bash — e.g. bash({ command: 'your-cmd', override: true }).`,
		};
	}
	return undefined;
}

/**
 * gh write block reason. Truthful about tool availability: coder/reviewer/writer
 * have NO gh tool at all, and where gh exists (scout/researcher) it is
 * read-only (Allowed: list, view, status; `gh api` disallowed). The old wording
 * ("Use the dedicated gh tool instead") told callers to use a tool they lack
 * for a write the tool cannot do. gh writes must route through the orchestrator.
 */
function ghWriteBlockReason(command: string): string {
	return `\u26D4 gh write command blocked. Specialists have no gh write access — the gh tool (available only to scout/researcher) is read-only (list, view, status; gh api disallowed).\nCommand: ${command}\nHint: route the gh write request through the orchestrator instead.`;
}

/** One tokenized shell word. `quoted` marks tokens that contained quoted text. */
interface ShellToken {
	value: string;
	quoted: boolean;
}

/** Shell operators that separate commands on a command line. */
const SHELL_SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

/**
 * Quote-aware shell tokenizer (#139). Whitespace splits tokens; characters
 * inside single/double quotes stay in one token (the quote characters are
 * dropped); unquoted shell separators (&&, ||, ;, |, &) are emitted as
 * standalone tokens. Tokens that contained quoted text are flagged so callers
 * can ignore quoted regions — commit messages, sed scripts, grep patterns —
 * when scanning for path-like tokens.
 */
function tokenizeShell(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let current = '';
	let currentQuoted = false;
	let quote: string | null = null;
	const flush = () => {
		if (current) {
			tokens.push({ value: current, quoted: currentQuoted });
			current = '';
			currentQuoted = false;
		}
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; currentQuoted = true; continue; }
		if (/\s/.test(ch)) { flush(); continue; }
		if (ch === '&' || ch === '|' || ch === ';') {
			flush();
			if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
				tokens.push({ value: ch + ch, quoted: false });
				i++;
			} else {
				tokens.push({ value: ch, quoted: false });
			}
			continue;
		}
		current += ch;
	}
	flush();
	return tokens;
}

/** Split a tokenized command line into per-command segments at shell separators. */
function splitShellSegments(tokens: ShellToken[]): ShellToken[][] {
	const segments: ShellToken[][] = [];
	let current: ShellToken[] = [];
	for (const token of tokens) {
		if (!token.quoted && SHELL_SEPARATORS.has(token.value)) {
			if (current.length > 0) segments.push(current);
			current = [];
		} else {
			current.push(token);
		}
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

/**
 * #139: the directory relative tokens actually resolve against. Honors a
 * leading, repeatable `cd <dir> &&` chain and `git -C <dir>` before the
 * command word; falls back to the delegation cwd when neither is present.
 * Absolute out-of-scope tokens still resolve (and are still blocked) upstream.
 */
function computeEffectiveBaseDir(command: string, fallback: string): string {
	const tokens = tokenizeShell(command);
	const at = (idx: number): ShellToken | undefined => tokens[idx];
	let base = fallback;
	let i = 0;
	while (true) {
		const token = at(i);
		if (!token) break;
		// Leading env assignments (VAR=1 …) do not change the base dir
		if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) { i++; continue; }
		const next = at(i + 1);
		if (token.value === 'cd' && next && !SHELL_SEPARATORS.has(next.value)) {
			base = resolve(base, next.value);
			i += 2;
			continue;
		}
		if (token.value === 'git' && next?.value === '-C' && at(i + 2)) {
			base = resolve(base, at(i + 2)!.value);
			i += 3;
			continue;
		}
		if (!token.quoted && SHELL_SEPARATORS.has(token.value)) { i++; continue; }
		break;
	}
	return base;
}

/**
 * Locate the git invocation inside one shell segment, tolerating leading env
 * assignments (`VAR=1 git …`), a leading `cd <dir>`, and git global options
 * (`-C <dir>`, `-c name=value`). Returns the subcommand and its arguments.
 */
function findGitCommand(tokens: ShellToken[]): { subcmd: string; args: string[] } | undefined {
	const at = (idx: number): ShellToken | undefined => tokens[idx];
	let i = 0;
	while (true) {
		const token = at(i);
		if (!token) break;
		if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) { i++; continue; }
		break;
	}
	if (at(i)?.value === 'cd' && at(i + 1)) i += 2;
	if (at(i)?.value !== 'git') return undefined;
	i++;
	// Skip git global options; -C/-c/--git-dir/--work-tree/--namespace take a value.
	while (true) {
		const flag = at(i);
		if (!flag || !flag.value.startsWith('-')) break;
		if (flag.value === '-C' || flag.value === '-c' || flag.value === '--git-dir' || flag.value === '--work-tree' || flag.value === '--namespace') i += 2;
		else i += 1;
	}
	const subcmd = at(i);
	if (!subcmd || subcmd.quoted || SHELL_SEPARATORS.has(subcmd.value)) return undefined;
	return { subcmd: subcmd.value, args: tokens.slice(i + 1).map((t) => t.value) };
}

export function handleSubagentToolCall(event: any, fusionEnabled: boolean = true, ctx?: { cwd?: string; readOnly?: boolean }, subagentState?: SubagentState) {
	traceToolCallEntry('handleSubagentToolCall', event, ctx);
	if (!fusionEnabled && event.toolName === 'fusion') {
		return { block: true, reason: "Fusion is disabled. Enable it in .pi/fusion.json" };
	}
	if (subagentState && !subagentState.planParsed) {
		if (!readOnlyTools.has(event.toolName)) {
			return { block: true, reason: `[guard] Framework plan gate: call planSteps({ goal, steps }) before using ${event.toolName}. This notice is a framework prerequisite, not a plan step.` };
		}
	}
	if (subagentState) {
		// Defect A fix: resolve relative tool paths against the DELEGATION's own
		// working directory, recorded on the session at creation time, not against
		// the tool_call ctx.cwd (orchestrator/process cwd). Using the process cwd
		// resolved a subagent's relative path into the wrong tree and produced
		// spurious "File not in approved scope" blocks for legitimate in-scope work.
		const cwd = subagentState.cwd ?? ctx?.cwd ?? process.cwd();
		// Defect B fix: subagent enforcement resolves scope ONLY from this
		// delegation's per-delegation file. Opting out of the shared-file fallback
		// guarantees a stale/unrelated <cwd>/.pi/scope.json can never influence a
		// subagent's writes. A missing delegation id is therefore fail-closed.
		const guard = new ScopeGuard(cwd, subagentState.delegationId, { allowSharedFallback: false });
		// gh write command enforcement — runs for ALL subagents, even without scope
		if (event.toolName === 'bash') {
			const input = event.input || {};
			const command = input.command;
			if (command && command.startsWith('gh ') && isWriteCommand(command)) {
				return { block: true, reason: ghWriteBlockReason(command) };
			}
		}
		// FIX 1 (fail-closed): the scope block ALWAYS runs for subagent tool calls.
		// The previous `if (guard.isScopeValid())` gate skipped enforcement entirely when
		// no scope file existed, turning a documented fail-closed guard into a no-op.
		// Scope applies to write-class tools only: ScopeGuard.isPathAllowed() returns
		// { allowed: true } for operation === 'read', so read/grep/find/ls are never
		// blocked by this — no over-blocking of read-only tools.
		{
			const input = event.input || {};
			const filePaths: string[] = [];

			if (input.filePath) filePaths.push(input.filePath);
			if (input.path) filePaths.push(input.path);
			if (input.file) filePaths.push(input.file);
			tracePathsExtracted('scope-guard', input, filePaths);

			// #139: relative tokens resolve against the shell-effective base dir
			// (leading `cd <dir> &&` chains, `git -C <dir>`), not the raw delegation cwd.
			let effectiveBaseDir = cwd;
			if (event.toolName === 'bash' && input.command) {
				const cmd = input.command.trim();

				// Git commands that are safe (read-only or no file impact)
				const GIT_SAFE_COMMANDS = new Set([
					'status', 'log', 'diff', 'show', 'branch', 'remote',
					'fetch', 'pull', 'stash', 'tag', 'blame', 'describe',
					'reflog', 'rev-parse', 'rev-list', 'shortlog'
				]);

				// Git commands that write files
				const GIT_WRITE_COMMANDS = new Set([
					'add', 'rm', 'mv', 'checkout', 'restore', 'reset',
					'clean', 'merge', 'rebase', 'cherry-pick'
				]);

				// Git subcommands that are truly read-only (no side effects)
				const GIT_SKIP_SAFE = new Set([
					'fetch', 'pull', 'remote', 'branch', 'tag', 'log', 'status', 'reflog'
				]);
				// Git subcommands that mutate state but don't take file args
				const GIT_SKIP_WRITE = new Set([
					'commit', 'push', 'init', 'clone'
				]);

				effectiveBaseDir = computeEffectiveBaseDir(cmd, cwd);

				// #139: quote-aware, chain-aware segmentation. Quoted regions (commit
				// messages, sed scripts, grep patterns) are flagged by the tokenizer and
				// never path-scanned; segments split at &&, ||, ;, | so one command's
				// tokens can never leak into another's scope check.
				const TEST_RUNNER_PREFIXES = ['npx vitest', 'npx jest', 'npm test', 'npx playwright', 'npx mocha', 'npx cypress', 'yarn test', 'pnpm test', 'npx tsc', 'node --test'];
				const pathRegex = /(?:[\w./-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|txt|py|rb|go|rs|java))/g;

				for (const segment of splitShellSegments(tokenizeShell(cmd))) {
					const gitCmd = findGitCommand(segment);
					if (gitCmd) {
						const subcmd = gitCmd.subcmd;
						const args = gitCmd.args;

						// Handle multi-word stash subcommands: stash list/show are read-only, rest are writes
						if (subcmd === 'stash') {
							const safeStashSubs = new Set(['list', 'show']);
							const stashSub = args.find((arg: string) => !arg.startsWith('-'));
							// Bare "git stash" defaults to "stash list" (safe)
							if (stashSub && !safeStashSubs.has(stashSub)) {
								if (ctx?.readOnly) {
									return { block: true, reason: `⛔ Git write command blocked for read-only specialist: git stash ${stashSub}` };
								}
							}
						}

						// Skip path check for commands that don't take file args
						if (GIT_SKIP_SAFE.has(subcmd) || GIT_SAFE_COMMANDS.has(subcmd)) {
							// Truly read-only — allow
						} else if (GIT_SKIP_WRITE.has(subcmd)) {
							// Mutating but no file args — block in readOnly mode. Commit messages
							// and their quoted -m args are never scanned for path tokens (#139).
							if (ctx?.readOnly) {
								return { block: true, reason: `⛔ Git write command blocked for read-only specialist: git ${subcmd}` };
							}
							// Allow for non-readOnly (coder)
						} else if (GIT_WRITE_COMMANDS.has(subcmd)) {
							// Read-only specialist: block git write commands
							if (ctx?.readOnly) {
								return { block: true, reason: `⛔ Git write command blocked for read-only specialist. Command: git ${subcmd}` };
							}
							// Write commands — extract paths from positional args only, against
							// the effective base dir. Staging args are scope-checked but
							// deliberately NOT size-checked (#139): `git add` of a large
							// in-scope file is legitimate, while genuine bash writes (sed -i on
							// a >400-line file) still hit checkFileSize in the loop below.
							const paths = args.filter((arg: string) => !arg.startsWith('-') && !SHELL_SEPARATORS.has(arg));

							for (const rawPath of paths) {
								const expandedPath = rawPath.startsWith('~/') ? rawPath.replace(/^~/, os.homedir()) : rawPath;
								const absolutePath = resolve(effectiveBaseDir, expandedPath);
								const pathAllowed = guard.isPathAllowed(absolutePath, 'write');
								if (!pathAllowed.allowed) {
									if (subagentState) {
										subagentState.blockedCalls.push({
											tool: event.toolName || 'unknown',
											target: rawPath,
											reason: pathAllowed.reason || 'outside allowed scope',
											timestamp: Date.now(),
										});
									}
									return { block: true, reason: `Scope violation: ${rawPath} is outside the allowed scope` };
								}
							}
						} else {
							// Unknown git subcommand — fail-closed for readOnly, fail-open for others
							if (ctx?.readOnly) {
								return { block: true, reason: `⛔ Unknown git command blocked for read-only specialist: git ${subcmd}` };
							}
						}
					} else {
						// Read-only specialist: block write-modifying non-git bash commands
						const segmentCmd = segment.map((t) => t.value).join(' ');
						if (ctx?.readOnly && isWriteCommand(segmentCmd)) {
							return { block: true, reason: `⛔ Bash write command blocked for read-only specialist. Use the appropriate SDK tool instead.\nCommand: ${cmd}\nHint: For file reads, use read(). For code search, use grep(). For file listing, use find() or ls().` };
						}
						// Test runner and compiler commands are read-only — skip file path extraction
						const isTestRunner = TEST_RUNNER_PREFIXES.some(prefix => segmentCmd.startsWith(prefix));
						if (!isTestRunner) {
							// Extract file-like paths from the segment's tokens. Quoted regions are
							// never scanned, flag-like tokens are not paths, and values of flags
							// (e.g., find -name test.ts) are patterns — not file paths.
							for (let t = 0; t < segment.length; t++) {
								const token = segment[t];
								if (!token || token.quoted) continue;
								const value = token.value;
								if (value === '--' || value.startsWith('-')) continue;
								const prev = segment[t - 1];
								if (prev && prev.value.startsWith('-') && prev.value !== '--') continue;
								pathRegex.lastIndex = 0;
								for (const match of value.matchAll(pathRegex)) {
									// BUG-5: temp-scratch paths are exempt from scope checks — subagents
									// legitimately write findings/scratch files under /tmp
									if (match[0].startsWith('/tmp/') || match[0].startsWith('/private/tmp/')) continue;
									filePaths.push(match[0]);
								}
							}
						}
					}
				}
			}

			// Derive operation from tool name — reads always safe, writes require scope approval
				const operation = event.toolName === 'edit' ? 'edit'
					: readOnlyTools.has(event.toolName) ? 'read'
					: event.toolName === 'bash' && !isWriteCommand(input.command) ? 'read'
					: 'write'; // fail-closed: unknown tools treated as mutations

			// FIX 1 (fail-closed, defense in depth): a write-class operation with no
			// established scope is denied even when no concrete path could be extracted.
			// When a path IS extracted the per-path loop below emits the canonical
			// "Scope violation: <path> is outside the allowed scope" message instead.
			if (operation !== 'read' && !guard.isScopeValid() && filePaths.length === 0) {
				if (subagentState) {
					subagentState.blockedCalls.push({
						tool: event.toolName || 'unknown',
						target: '(unresolved)',
						reason: 'No scope file',
						timestamp: Date.now(),
					});
				}
				const noScope = { block: true as const, reason: 'Scope violation: no approved scope is established for this subagent' };
				traceDecision('handleSubagentToolCall/subagent', event, noScope);
				return noScope;
			}

			for (const rawPath of filePaths) {
				const expandedPath = rawPath.startsWith('~/') ? rawPath.replace(/^~/, os.homedir()) : rawPath;
				const absolutePath = resolve(effectiveBaseDir, expandedPath);
				tracePathResolved('scope-guard', rawPath, absolutePath, operation);
				const pathAllowed = guard.isPathAllowed(absolutePath, operation);
				traceScopeCheck('scope-guard', absolutePath, pathAllowed.allowed, pathAllowed.reason);
				if (!pathAllowed.allowed) {
					if (subagentState) {
						subagentState.blockedCalls.push({
							tool: event.toolName || 'unknown',
							target: rawPath,
							reason: pathAllowed.reason || 'outside allowed scope',
							timestamp: Date.now(),
						});
					}
					const expansion = guard.requestExpansion(rawPath);
					debugLog("scope-guard: expansion request", expansion);
					return { block: true, reason: `Scope violation: ${rawPath} is outside the allowed scope`, expansionRequest: expansion };
				}
				let fileContent = '';
				if (operation === 'write' && input.content) {
					// For write operations, check the NEW content size, not existing file
					fileContent = input.content;
				} else {
					try { fileContent = readFileSync(absolutePath, 'utf-8'); } catch {}
				}
				const sizeCheck = guard.checkFileSize(absolutePath, fileContent, operation);
				if (!sizeCheck.allowed) {
					return { block: true, reason: sizeCheck.reason || `File too large: ${rawPath}` };
				}
			}
		}
		// Bash-to-read enforcement for subagents
		const interception = checkBashInterception(event, event.input?.override === true);
		if (interception) { traceDecision('handleSubagentToolCall/subagent', event, interception); return interception; }
		traceDecision('handleSubagentToolCall/subagent', event, { block: false });
		return;
	}
	// Read-only bash enforcement (orchestrator context)
	if (event.toolName === 'bash') {
		const command = isToolCallEventType('bash', event) ? event.input.command : event.input?.command;
		if (command && command.startsWith('gh ') && isWriteCommand(command)) {
			const blockResult = { block: true, reason: ghWriteBlockReason(command) };
			traceDecision('handleSubagentToolCall', event, blockResult);
			return blockResult;
		}
		if (ctx?.readOnly && command && isWriteCommand(command)) {
			const blockResult = { block: true, reason: `⛔ Bash write command blocked for read-only specialist.\nCommand: ${command}\nHint: For file reads, use read(). For code search, use grep(). For file listing, use find() or ls().` };
			traceDecision('handleSubagentToolCall', event, blockResult);
			return blockResult;
		}
	}
	const interception = checkBashInterception(event, event.input?.override === true);
	if (interception) { traceDecision('handleSubagentToolCall', event, interception); return interception; }
	traceDecision('handleSubagentToolCall', event, { block: false });
}
