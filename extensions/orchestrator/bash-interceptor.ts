/**
 * Bash command interception — determines when to redirect bash to native tools.
 * Pure functions, zero external dependencies.
 */

import { basename } from "node:path";

export function firstCommandName(command: string): { name: string; rest: string } | null {
	const segment = command.split(/[&|;]+/)[0]?.trim() ?? "";
	if (!segment) return null;
	const tokens = segment.split(/\s+/);
	let i = 0;
	while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === "export")) i++;
	const raw = tokens[i];
	if (!raw) return null;
	const name = basename(raw).toLowerCase();
	return { name, rest: tokens.slice(i + 1).join(" ") };
}

export function hasFileWriteIndicator(text: string): boolean {
	return /\s>>?\s/.test(text) ||
		/\bopen\s*\([^)]*['"](w|a|x)['"]/i.test(text) ||
		/fs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/i.test(text) ||
		/\b(writeFile|appendFile)(Sync)?\s*\(/i.test(text);
}

// DESIGN DECISION: We intentionally do NOT intercept sed/awk/perl file modifications
// beyond the -i flag. Shell command parsing via regex is inherently brittle —
// quotes, heredocs, subshells, and pipes create false positives/negatives.
// bash-interceptor is the primary tool-level gate for dangerous commands (rm -rf, sed -i).
// The prompt layer (_coderToolDoc, coder system prompt) is a secondary backstop for
// commands regex can't reliably detect (python/perl scripting, multi-command pipes).

function isBlockedRmRecursive(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed.startsWith('rm ') && !trimmed.startsWith('rm\t')) return false;
	return /-[^ ]*r[^ ]*f|-[^ ]*f[^ ]*r|--recursive.*--force|--force.*--recursive/.test(trimmed);
}

export function isMutatingEditor(name: string, text: string): boolean {
	if ((name === "sed" || name === "perl") && /(^|\s)-i/.test(text)) return true;
	return hasFileWriteIndicator(text);
}

export function getBashToolReplacement(command: string | undefined, override?: boolean): string | null {
	if (override || !command) return null;
	if (isBlockedRmRecursive(command)) {
		return "rm -rf is blocked. Set override:true in bash tool input to bypass. Use edit/write to modify files, or ask orchestrator for destructive operation approval.";
	}
	const cmd = firstCommandName(command);
	if (!cmd) return null;
	const { name, rest } = cmd;
	const text = `${name} ${rest}`;
	switch (name) {
		case "cat": return "read";
		case "grep":
		case "rg": return "grep";
		case "find": return "find";
		case "ls": return "ls";
		case "sed":
		case "awk":
		case "perl":
			return isMutatingEditor(name, text) ? "edit" : null;
		case "mkdir":
		case "touch": return "write";
		case "python":
		case "python3":
		case "node":
			return hasFileWriteIndicator(text) ? "edit" : null;
		default: return null;
	}
}
