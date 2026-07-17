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
const readOnlyTools = new Set(['read', 'grep', 'find', 'ls', 'git-read', 'head', 'tail', 'wc', 'file']);

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

export function handleSubagentToolCall(event: any, fusionEnabled: boolean = true, ctx?: { cwd?: string; readOnly?: boolean }, subagentState?: SubagentState) {
	traceToolCallEntry('handleSubagentToolCall', event, ctx);
	if (!fusionEnabled && event.toolName === 'fusion') {
		return { block: true, reason: "Fusion is disabled. Enable it in .pi/fusion.json" };
	}
	if (subagentState && !subagentState.planParsed) {
		if (event.toolName !== "planSteps") {
			return { block: true, reason: `Call planSteps({ goal, steps }) first before using ${event.toolName}.` };
		}
	}
	if (subagentState) {
		const cwd = ctx?.cwd ?? process.cwd();
		const guard = new ScopeGuard(cwd);
		// gh write command enforcement — runs for ALL subagents, even without scope
		if (event.toolName === 'bash') {
			const input = event.input || {};
			const command = input.command;
			if (command && command.startsWith('gh ') && isWriteCommand(command)) {
				return { block: true, reason: `\u26D4 gh write command blocked. Use the dedicated gh tool instead.\nCommand: ${command}\nHint: gh write operations (create, merge, delete, push) are not permitted via bash.` };
			}
		}
		if (guard.isScopeValid()) {
			const input = event.input || {};
			const filePaths: string[] = [];

			if (input.filePath) filePaths.push(input.filePath);
			if (input.path) filePaths.push(input.path);
			if (input.file) filePaths.push(input.file);
			tracePathsExtracted('scope-guard', input, filePaths);

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

				// Check if this is a git command (capture up to 2 subcommands for multi-word like "stash list")
				const gitMatch = cmd.match(/^git\s+(\w+)(?:\s+(\w+))?/);
				if (gitMatch) {
					const subcmd = gitMatch[1];
					const subcmd2 = gitMatch[2];

					// Handle multi-word stash subcommands: stash list/show are read-only, rest are writes
					if (subcmd === 'stash') {
						const safeStashSubs = new Set(['list', 'show']);
						// Bare "git stash" defaults to "stash list" (safe)
						if (subcmd2 && !safeStashSubs.has(subcmd2)) {
							if (ctx?.readOnly) {
								return { block: true, reason: `⛔ Git write command blocked for read-only specialist: git stash ${subcmd2}` };
							}
						}
					}

					// Skip path check for commands that don't take file args
					if (GIT_SKIP_SAFE.has(subcmd)) {
						// Truly read-only — allow
					} else if (GIT_SKIP_WRITE.has(subcmd)) {
						// Mutating but no file args — block in readOnly mode
						if (ctx?.readOnly) {
							return { block: true, reason: `⛔ Git write command blocked for read-only specialist: git ${subcmd}` };
						}
						// Allow for non-readOnly (coder)
					} else if (GIT_SAFE_COMMANDS.has(subcmd)) {
						// Safe read-only commands - allow without path check
					} else if (GIT_WRITE_COMMANDS.has(subcmd)) {
						// Read-only specialist: block git write commands
						if (ctx?.readOnly) {
							return { block: true, reason: `⛔ Git write command blocked for read-only specialist. Command: git ${subcmd}` };
						}
						// Write commands - extract paths from positional args only
						const args = cmd.split(/\s+/).slice(2);
						const paths = args.filter((arg: string) => !arg.startsWith('-'));

						for (const rawPath of paths) {
							const expandedPath = rawPath.startsWith('~/') ? rawPath.replace(/^~/, os.homedir()) : rawPath;
							const absolutePath = resolve(cwd, expandedPath);
							const pathAllowed = guard.isPathAllowed(absolutePath, 'write');
							if (!pathAllowed.allowed) {
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
					if (ctx?.readOnly && isWriteCommand(input.command)) {
						return { block: true, reason: `⛔ Bash write command blocked for read-only specialist. Use the appropriate SDK tool instead.\nCommand: ${cmd}\nHint: For file reads, use read(). For code search, use grep(). For file listing, use find() or ls().` };
					}
					// Test runner and compiler commands are read-only — skip file path extraction
					// Strip leading "cd <path> && " before checking test runner prefixes
					const TEST_RUNNER_PREFIXES = ['npx vitest', 'npx jest', 'npm test', 'npx playwright', 'npx mocha', 'npx cypress', 'yarn test', 'pnpm test', 'npx tsc', 'node --test'];
					const cmdForCheck = cmd.replace(/^cd\s+\S+\s*&&\s*/, '');
					const isTestRunner = TEST_RUNNER_PREFIXES.some(prefix => cmdForCheck.startsWith(prefix));
					if (!isTestRunner) {
						const pathMatches = input.command.match(/(?:[\w./-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|txt|py|rb|go|rs|java))/g);
						if (pathMatches) filePaths.push(...pathMatches);
					}
				}
			}

			// Derive operation from tool name — reads always safe, writes require scope approval
				const operation = event.toolName === 'edit' ? 'edit'
					: readOnlyTools.has(event.toolName) ? 'read'
					: 'write'; // fail-closed: unknown tools treated as mutations

			for (const rawPath of filePaths) {
				const expandedPath = rawPath.startsWith('~/') ? rawPath.replace(/^~/, os.homedir()) : rawPath;
				const absolutePath = resolve(cwd, expandedPath);
				tracePathResolved('scope-guard', rawPath, absolutePath, operation);
				const pathAllowed = guard.isPathAllowed(absolutePath, operation);
				traceScopeCheck('scope-guard', absolutePath, pathAllowed.allowed, pathAllowed.reason);
				if (!pathAllowed.allowed) {
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
			const blockResult = { block: true, reason: `⛔ gh write command blocked. Use the dedicated gh tool instead.\nCommand: ${command}\nHint: gh write operations (create, merge, delete, push) are not permitted via bash.` };
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
