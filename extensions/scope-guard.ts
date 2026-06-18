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
import { join, relative, isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Normalize a file path against a working directory.
 * Returns a relative path with forward slashes.
 * Returns null if the path escapes the working directory.
 */
function normalizePath(filePath: string, cwd: string): string | null {
	const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const rel = relative(cwd, absolute);
	// If relative starts with '..', the path escapes cwd
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.replace(/\\/g, "/");
}

interface Scope {
	filesToModify: string[];
	filesToCreate: string[];
	directories: string[];
	maxFiles: number;
	requiresApprovalBeyondScope: boolean;
	changeType?: "single-file" | "multi-file";
	maxLinesPerFile: number;
	gateMode?: "strict" | "relaxed";
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
		const hash = createHash("md5").update(raw).digest("hex");
		if (hash !== _lastScopeHash) {
			_touchedFiles.length = 0;
			_lastScopeHash = hash;
		}
		const parsed = JSON.parse(raw) as Scope;
		_cachedScope = parsed;
		return _cachedScope;
	} catch {
		_cachedScope = null;
		return null;
	}
}

/** Track files touched during this session for directory-level count enforcement */
const _touchedFiles: string[] = [];
let _lastScopeHash = "";

function isPathInScope(filePath: string, scope: Scope, cwd: string): boolean {
	const relPath = normalizePath(filePath, cwd);
	if (!relPath) return false;
	const allApproved = [...scope.filesToModify, ...scope.filesToCreate];

	for (const approved of allApproved) {
		// Normalize: if approved is absolute, convert to relative
		const approvedRel = isAbsolute(approved) ? normalizePath(approved, cwd) : approved;
		if (!approvedRel) continue;

		if (approvedRel.endsWith("/*") && relPath.startsWith(approvedRel.slice(0, -1))) return true;
		if (approvedRel === relPath) return true;
		if (relPath.endsWith(`/${approvedRel}`)) return true;
	}
	return false;
}

function isPathAllowed(path: string, scope: Scope, touchedFiles: string[], cwd: string): boolean {
	const normalized = normalizePath(path, cwd);
	if (!normalized) return false;

	// Direct file allowlist check
	if (scope.filesToModify.includes(normalized)) return true;
	if (scope.filesToCreate.includes(normalized)) return true;

	// Directory-level check
	for (const dir of scope.directories) {
		const normalizedDir = dir.replace(/\/$/, "") + "/";
		if (normalized.startsWith(normalizedDir) || normalized === dir) {
			const touchedCount = touchedFiles.filter(f => normalizePath(f, cwd)?.startsWith(normalizedDir)).length;
			if (touchedCount < scope.maxFiles) return true;
		}
	}
	return false;
}

export function resetTouchedFiles(): void {
	_touchedFiles.length = 0;
	_lastScopeRead = 0;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const scope = readScope(ctx.cwd);
		if (!scope) return; // No scope = pass-through

		const path = ((event.input as any)?.path || (event.input as any)?.file_path || "") as string;
		if (!path) return;

		// Check file is in approved scope (both direct file-list and directory-level)
		const inScope = isPathInScope(path, scope, ctx.cwd);
		const allowed = inScope || isPathAllowed(path, scope, _touchedFiles, ctx.cwd);

		if (!allowed) {
			return {
				block: true,
				reason:
					`[scope-guard] File not in approved scope: ${path}\n` +
					`Approved to modify: ${scope.filesToModify.join(", ") || "(none)"}\n` +
					`Approved to create: ${scope.filesToCreate.join(", ") || "(none)"}\n` +
					`Directories allowed: ${scope.directories.join(", ") || "(none)"}\n` +
					`Max files per directory: ${scope.maxFiles}\n` +
					`Request scope expansion if needed.`,
			};
		}

		// Track touched files for directory-level count enforcement
		if (!_touchedFiles.includes(path)) {
			_touchedFiles.push(path);
		}

		// Check line count limit for write (skip in relaxed mode)
		if (event.toolName === "write" && scope.maxLinesPerFile > 0 && scope.gateMode !== "relaxed") {
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
