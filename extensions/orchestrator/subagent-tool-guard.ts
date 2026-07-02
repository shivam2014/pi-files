/**
 * Subagent tool call enforcement — blocks non-native tools, enforces scope.
 * Depends on BashInterceptor, ScopeGuard, and orchestrator state.
 */

import { getBashToolReplacement } from "./bash-interceptor.ts";
import { ScopeGuard } from "./scope-guard.ts";
import { _batchLoadSubagent, isPlanParsed } from "./subagent-runner.ts";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { debugLog } from "./debug.ts";
import { resolve } from "node:path";

export function handleSubagentToolCall(event: any, fusionEnabled: boolean = true, ctx?: { cwd?: string }) {
	if (!fusionEnabled && event.toolName === 'fusion') {
		return { block: true, reason: "Fusion is disabled. Enable it in .pi/fusion.json" };
	}
	if (_batchLoadSubagent > 0 && !isPlanParsed()) {
		if (event.toolName !== "planSteps") {
			return { block: true, reason: `Call planSteps({ goal, steps }) first before using ${event.toolName}.` };
		}
	}
	if (_batchLoadSubagent > 0) {
		const cwd = ctx?.cwd ?? process.cwd();
		const guard = new ScopeGuard(cwd);
		if (guard.isScopeValid()) {
			const input = event.input || {};
			const filePaths: string[] = [];

			if (input.filePath) filePaths.push(input.filePath);
			if (input.path) filePaths.push(input.path);
			if (input.file) filePaths.push(input.file);

			if (event.toolName === 'bash' && input.command) {
				const pathMatches = input.command.match(/(?:[\w./-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|txt|py|rb|go|rs|java))/g);
				if (pathMatches) filePaths.push(...pathMatches);
			}

			// Derive operation from tool name — reads always safe, writes require scope approval
			const readOnlyTools = new Set(['read', 'grep', 'find', 'ls', 'git-read', 'head', 'tail', 'wc', 'file']);
			const writeTools = new Set(['edit', 'write']);
			const operation = writeTools.has(event.toolName) ? 'write'
				: readOnlyTools.has(event.toolName) ? 'read'
				: 'write'; // fail-closed: unknown tools treated as mutations

			for (const rawPath of filePaths) {
				const absolutePath = resolve(cwd, rawPath);
				const pathAllowed = guard.isPathAllowed(absolutePath, operation);
				if (!pathAllowed.allowed) {
					const expansion = guard.requestExpansion(rawPath);
					debugLog("scope-guard: expansion request", expansion);
					return { block: true, reason: `Scope violation: ${rawPath} is outside the allowed scope` };
				}
				let fileContent = '';
				try { fileContent = readFileSync(absolutePath, 'utf-8'); } catch {}
				const sizeCheck = guard.checkFileSize(absolutePath, fileContent);
				if (!sizeCheck.allowed) {
					return { block: true, reason: sizeCheck.reason || `File too large: ${rawPath}` };
				}
			}
		}
		return;
	}
	if (event.toolName !== "bash") return;
	const command = isToolCallEventType("bash", event) ? event.input.command : event.input?.command;
	const override = event.input?.override === true;
	const replacement = getBashToolReplacement(command, override);
	if (replacement) {
		return { block: true, reason: `Use ${replacement} instead of bash (${command?.trim().split(/\s+/)[0]}). Set override:true to force bash.` };
	}
}
