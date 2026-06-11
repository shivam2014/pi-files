/**
 * SCOPE GUARD — tool-level write enforcement for orchestrator subagents.
 *
 * Reads .pi/scope.json (relative to cwd) and blocks write/edit tool calls
 * that target files outside the approved scope.
 *
 * No scope file = pass-through (invisible, 0 overhead).
 * Scope file present = only approved files can be modified/created.
 *
 * Design: ORCHESTRATION-REFACTOR.md §3 — Scope Handoff Flow
 * Template: lint-guard.ts (same tool_call + block pattern)
 * Zero coupling to orchestrator module.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Scope {
	filesToModify: string[];
	filesToCreate: string[];
	maxLinesPerFile: number;
}

/** Throttle re-reads: check file at most once per N ms */
const SCOPE_REFRESH_MS = 1000;
let _lastScopeRead = 0;
let _cachedScope: Scope | null = null;

function readScope(cwd: string): Scope | null {
	const now = Date.now();
	if (now - _lastScopeRead < SCOPE_REFRESH_MS) {
		return _cachedScope;
	}
	_lastScopeRead = now;

	const scopePath = join(cwd, ".pi", "scope.json");
	if (!existsSync(scopePath)) {
		_cachedScope = null;
		return null;
	}

	try {
		const raw = readFileSync(scopePath, "utf-8");
		const parsed = JSON.parse(raw) as Scope;
		_cachedScope = parsed;
		return _cachedScope;
	} catch {
		_cachedScope = null;
		return null;
	}
}

function isPathInScope(filePath: string, scope: Scope, cwd: string): boolean {
	const relPath = relative(cwd, filePath);
	const allApproved = [...scope.filesToModify, ...scope.filesToCreate];

	for (const approved of allApproved) {
		if (approved.endsWith("/*") && relPath.startsWith(approved.slice(0, -1))) return true;
		if (approved === relPath) return true;
		if (relPath.endsWith(`/${approved}`)) return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const scope = readScope(ctx.cwd);
		if (!scope) return; // No scope = pass-through

		const path = ((event.input as any)?.path || (event.input as any)?.file_path || "") as string;
		if (!path) return;

		// Check file is in approved scope
		if (!isPathInScope(path, scope, ctx.cwd)) {
			return {
				block: true,
				reason:
					`[scope-guard] File not in approved scope: ${path}\n` +
					`Approved to modify: ${scope.filesToModify.join(", ") || "(none)"}\n` +
					`Approved to create: ${scope.filesToCreate.join(", ") || "(none)"}\n` +
					`Request scope expansion if needed.`,
			};
		}

		// Check line count limit for write
		if (event.toolName === "write" && scope.maxLinesPerFile > 0) {
			const content = ((event.input as any)?.content || "") as string;
			const lines = content.split("\n").length;
			if (lines > scope.maxLinesPerFile) {
				return {
					block: true,
					reason:
						`[scope-guard] File exceeds line limit: ${path} (${lines} lines, max ${scope.maxLinesPerFile})\n` +
						`Split into multiple files or reduce complexity.`,
				};
			}
		}
	});
}
