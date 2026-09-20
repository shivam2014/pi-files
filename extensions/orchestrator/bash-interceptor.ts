/**
 * Bash interceptor — consolidated module.
 * Uses pi SDK tool_call event pattern with isWriteCommand classifier.
 */

import { basename } from "node:path";
import { isWriteCommand } from "./bash-classifier";

// ── Local quote-aware tokenizer ──
// Mirrors the tokenizer in subagent-tool-guard.ts. Duplicated deliberately:
// partially-mocked test files replace bash-classifier.ts wholesale, so this
// module must not gain new cross-module imports.

interface ShellToken { value: string; quoted: boolean }

/** Shell operators that separate commands on a command line. */
const SHELL_SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let currentQuoted = false;
  let quote: string | null = null;
  const flush = () => {
    if (current) tokens.push({ value: current, quoted: currentQuoted });
    current = '';
    currentQuoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length && '"\\`$'.includes(command[i + 1])) {
        current += command[i + 1];
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      i++;
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

// ── Dangerous command patterns (tokenizer-aware) ──

/** Commands whose quoted payload is EXECUTED, so quoted content is scanned too. */
const EXEC_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'eval', 'python', 'python3', 'perl', 'ruby', 'node']);

function matchesDangerPattern(text: string): boolean {
  if (/rm\s+-rf\s+[\/~-]/.test(text)) return true;
  if (/git\s+push\s+(-f|--force)/.test(text)) return true;
  if (/git\s+reset\s+--hard/.test(text)) return true;
  if (/sudo\s+rm/.test(text)) return true;
  if (/dd\s+if=/.test(text)) return true;
  if (/mkfs/.test(text)) return true;
  return false;
}

/**
 * Check if a command is dangerous, tokenizer-aware.
 * Quoted literals are DATA, not execution: `grep -rn "rm -rf /" docs/` or
 * `echo "rm -rf /"` must not trip the hard block. The exception is exec-wrapper
 * payloads (bash -c "…", eval "…", sh -c '…', python -c "…"): those execute
 * their quoted argument, so they are scanned and stay override-proof.
 * Real unquoted `rm -rf /` still matches and hard-blocks even with override.
 */
function isDangerousCommand(command: string): boolean {
  for (const segment of splitShellSegments(tokenizeShell(command))) {
    if (segment.length === 0) continue;
    // Neutralize quoted tokens so quoted literals cannot trip substring patterns.
    const neutral = segment.map((t) => (t.quoted ? '""' : t.value)).join(' ');
    if (matchesDangerPattern(neutral)) return true;

    // Exec-wrapper payloads execute their quoted argument — scan quoted values too.
    let i = 0;
    while (i < segment.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i].value) || segment[i].value === 'export')) i++;
    const word = segment[i]?.value;
    if (word && EXEC_WRAPPERS.has(word)) {
      const payload = segment.slice(i + 1).map((t) => t.value).join(' ');
      if (/rm\s+-rf/.test(payload) || matchesDangerPattern(payload)) return true;
    }
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

      // Scoped /tmp scratch writes are exempt (BUG-5): `cat f > /tmp/out.txt` is a
      // workspace write, not a code mutation. Ordering: exemption before the block.
      if (readOnly && isWriteCommand(command) && !hasScopedTempWrite(command)) {
        ctx.ui?.notify?.(`🚫 Blocked write command in read-only mode: ${command}`, "warning");
        return { block: true, reason: "Write command blocked in read-only mode" };
      }

      return undefined;
    },
  };
}

// ── getBashToolReplacement helpers ──

function firstCommandName(command: string): { name: string; rest: string } | null {
  const first = splitShellSegments(tokenizeShell(command))[0];
  if (!first || first.length === 0) return null;
  let i = 0;
  while (i < first.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first[i].value) || first[i].value === "export")) i++;
  const raw = first[i]?.value;
  if (!raw) return null;
  const name = basename(raw).toLowerCase();
  return { name, rest: first.slice(i + 1).map((t) => t.value).join(" ") };
}

function hasFileWriteIndicator(text: string): boolean {
  return /\s>>?\s/.test(text) ||
    /\bopen\s*\([^)]*['"](w|a|x)['"]/i.test(text) ||
    /fs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/i.test(text) ||
    /\b(writeFile|appendFile)(Sync)?\s*\(/i.test(text);
}

// Design rationale: We intercept at the *mutation boundary*, not at the command
// usage boundary. `sed -i` and `perl -i` write edits back to files on disk — that
// is the mutation, and it warrants routing through the edit tool. By contrast,
// stream-processing sed/awk/perl (piping stdin→stdout without `-i`) perform a
// read-only transformation: data flows through the process but never touches a
// file. Blocking those would choke legitimate one-liners that just filter text.
// hasFileWriteIndicator() catches the same boundary for Python/Node scripts that
// open files for writing. The principle: if the command can reach the filesystem,
// intercept; if it only touches the stream, let it through.
function isMutatingEditor(name: string, text: string): boolean {
  if ((name === "sed" || name === "perl") && /(^|\s)-i/.test(text)) return true;
  return hasFileWriteIndicator(text);
}

function isBlockedRmRecursive(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed.startsWith("rm ") && !trimmed.startsWith("rm\t")) return false;
  return /-[^ ]*r[^ ]*f|-[^ ]*f[^ ]*r|--recursive.*--force|--force.*--recursive/.test(trimmed);
}

// ── Scoped /tmp exemptions (BUG-5) ──
// Subagents legitimately write to scratch dirs (/tmp, /private/tmp, $TMPDIR):
// `mkdir -p /tmp/orchestrator-debug`, `grep foo f > /tmp/results.txt`,
// `cat > /tmp/findings.md`. These are workspace writes, not code mutations —
// redirecting them to edit/write/grep tools produced false positives.
// Dangerous-command blocks (rm -rf, git push -f, ...) still apply first.
const TEMP_PATH_RE = /(?:\/private)?\/tmp(?:\/|$)|\$\{?TMPDIR\}?(?:\/|$)/;

/**
 * True when the command targets a temp scratch dir AND performs a write
 * (redirection or write verb). Pure reads from /tmp still redirect to SDK tools.
 */
export function hasScopedTempWrite(command: string): boolean {
  if (!TEMP_PATH_RE.test(command)) return false;
  return /\s>>?\s|\b(mkdir|touch|tee|cp|mv|sed|perl|tar|unzip|gzip|gunzip|bzip2|xz|python|python3|node)\b/.test(command);
}

/**
 * Tool suggestions that are ADVISORY only: read/grep/find/ls bash calls pass
 * through (a specialist may legitimately need bash pipes/flags the native tool
 * lacks). Mutating replacements (edit/write) remain hard redirects.
 * Keep in sync with ADVISORY_REPLACEMENT_TOOLS in subagent-tool-guard.ts.
 */
export const ADVISORY_REPLACEMENT_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

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

	// ALWAYS check dangerous commands first, even with override
	if (isDangerousCommand(command)) {
		return {
			allowed: false,
			reason: "Dangerous command blocked. This command cannot be executed even with override:true.",
		};
	}

	// Override bypasses tool redirection (but not dangerous commands)
	if (override) return { allowed: true };

	// Block rm -rf even if not caught by dangerous command check
	if (isBlockedRmRecursive(command)) {
		return {
			allowed: false,
			reason: "rm -rf is blocked. Set override:true in bash tool input to bypass. Use edit/write to modify files, or ask orchestrator for destructive operation approval."
		};
	}

	// BUG-5: scoped /tmp scratch writes don't need tool redirection
	if (hasScopedTempWrite(command)) return { allowed: true };


  const cmd = firstCommandName(command);
  if (!cmd) return { allowed: true };
  const { name, rest } = cmd;
  const text = `${name} ${rest}`;
  switch (name) {
    case "cat":
    case "head":
    case "tail":
    case "wc": return { allowed: true, tool: "read" };
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
