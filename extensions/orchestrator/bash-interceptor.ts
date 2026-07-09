/**
 * Bash interceptor — consolidated module.
 * Uses pi SDK tool_call event pattern with isWriteCommand classifier.
 */

import { basename } from "node:path";
import { isWriteCommand } from "./bash-classifier";

// ── Dangerous command patterns (regex-based) ──

/**
 * Check if a command is dangerous using proper parsing.
 * Splits on pipes/chains and checks each segment with regex.
 */
function isDangerousCommand(command: string): boolean {
  const segments = command.split(/[|;&]+/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Check for dangerous patterns
    if (/rm\s+-rf\s+[\/~-]/.test(trimmed)) return true;
    if (/git\s+push\s+(-f|--force)/.test(trimmed)) return true;
    if (/git\s+reset\s+--hard/.test(trimmed)) return true;
    if (/sudo\s+rm/.test(trimmed)) return true;
    if (/dd\s+if=/.test(trimmed)) return true;
    if (/mkfs/.test(trimmed)) return true;

    // Check for eval/perl/python subshells executing dangerous commands
    if (/eval\s+/.test(trimmed) && /rm\s+-rf/.test(trimmed)) return true;
    if (/perl\s+-e\s+/.test(trimmed) && /rm\s+-rf/.test(trimmed)) return true;
    if (/python[23]?\s+-c\s+/.test(trimmed) && /rm\s+-rf/.test(trimmed)) return true;
  }
  return false;
}

// ── createBashInterceptor (SDK tool_call event handler) ──

export interface BashInterceptorOptions {
  readOnly?: boolean;
  blockDangerous?: boolean;
}

export interface BashInterceptor {
  handler: (event: any, ctx: any) => Promise<{ block: boolean; reason: string } | undefined>;
}

export function createBashInterceptor(options: BashInterceptorOptions = {}): BashInterceptor {
  const { readOnly = false, blockDangerous = true } = options;

  return {
    handler: async (event: any, ctx: any) => {
      if (event.toolName !== "bash") {
        return undefined;
      }

      const command = event.input?.command || "";

      if (blockDangerous) {
        const dangerous = isDangerousCommand(command);
        if (dangerous) {
          ctx.ui?.notify?.(`⚠️ Blocked dangerous command: ${command}`, "warning");
          return { block: true, reason: "Dangerous command blocked" };
        }
      }

      if (readOnly && isWriteCommand(command)) {
        ctx.ui?.notify?.(`🚫 Blocked write command in read-only mode: ${command}`, "warning");
        return { block: true, reason: "Write command blocked in read-only mode" };
      }

      return undefined;
    },
  };
}

// ── getBashToolReplacement helpers ──

function firstCommandName(command: string): { name: string; rest: string } | null {
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

function hasFileWriteIndicator(text: string): boolean {
  return /\s>>?\s/.test(text) ||
    /\bopen\s*\([^)]*['"](w|a|x)['"]/i.test(text) ||
    /fs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/i.test(text) ||
    /\b(writeFile|appendFile)(Sync)?\s*\(/i.test(text);
}

function isMutatingEditor(name: string, text: string): boolean {
  if ((name === "sed" || name === "perl") && /(^|\s)-i/.test(text)) return true;
  return hasFileWriteIndicator(text);
}

function isBlockedRmRecursive(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed.startsWith("rm ") && !trimmed.startsWith("rm\t")) return false;
  return /-[^ ]*r[^ ]*f|-[^ ]*f[^ ]*r|--recursive.*--force|--force.*--recursive/.test(trimmed);
}

// ── Tool replacement ──

export interface BashReplacementResult {
  allowed: boolean;
  tool?: string;  // tool to use instead (if allowed and redirected)
  reason?: string; // why blocked (if not allowed)
}

/**
 * Determine if a bash command should be redirected to a native SDK tool.
 * Returns a structured result indicating whether the command is allowed,
 * what tool to use instead, or why it was blocked.
 */
export function getBashToolReplacement(command: string | undefined, override?: boolean): BashReplacementResult {
  if (!command) return { allowed: true };
  if (override) return { allowed: true };

  if (isBlockedRmRecursive(command)) {
    return {
      allowed: false,
      reason: "rm -rf is blocked. Set override:true in bash tool input to bypass. Use edit/write to modify files, or ask orchestrator for destructive operation approval."
    };
  }

  const cmd = firstCommandName(command);
  if (!cmd) return { allowed: true };
  const { name, rest } = cmd;
  const text = `${name} ${rest}`;
  switch (name) {
    case "cat": return { allowed: true, tool: "read" };
    case "grep":
    case "rg": return { allowed: true, tool: "grep" };
    case "find": return { allowed: true, tool: "find" };
    case "ls": return { allowed: true, tool: "ls" };
    case "sed":
    case "awk":
    case "perl":
      return isMutatingEditor(name, text) ? { allowed: true, tool: "edit" } : { allowed: true };
    case "mkdir":
    case "touch": return { allowed: true, tool: "write" };
    case "python":
    case "python3":
    case "node":
      return hasFileWriteIndicator(text) ? { allowed: true, tool: "edit" } : { allowed: true };
    default: return { allowed: true };
  }
}

// ── Classifier wrapper ──

/**
 * Check if a bash command performs file writes/mutations.
 * Thin wrapper around isWriteCommand from bash-classifier for backward compat.
 */
export function isWriteModifyingCommand(command: string | undefined): boolean {
  if (!command) return false;
  return isWriteCommand(command);
}
