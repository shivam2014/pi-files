/**
 * Bash command classifier — determines if a command is write-modifying.
 * Uses simple string matching instead of regex for readability.
 */

import { basename } from "node:path";

// Commands that are always read-only
const READ_COMMANDS = new Set([
  "ls", "cat", "grep", "find", "head", "tail", "wc", "echo", "pwd", "date",
  "git status", "git log", "git diff", "git show", "git branch", "git remote",
  "git tag", "git blame", "git reflog", "git describe",
  // gh read-only commands
  "gh issue list", "gh issue view", "gh issue status",
  "gh pr list", "gh pr view", "gh pr status", "gh pr diff", "gh pr checks",
  "gh release list", "gh release view", "gh release download",
  "gh repo view", "gh repo list", "gh repo clone",
  "gh auth status",
  "gh secret list", "gh variable list",
  "gh label list",
  "gh workflow list", "gh workflow view",
  "gh run list", "gh run view", "gh run watch",
  "which", "whoami", "hostname", "uname", "env", "printenv",
  "python3", "node", "cd", "sort", "du", "df", "stat", "file", "man", "type",
  "readlink", "realpath", "dirname", "basename", "xargs", "awk", "sed", "jq",
  // Read-only process/tooling commands (read-only specialist false-positive
  // relief). Unknown commands still default to WRITE — this allowlist is the
  // only read allowance; do not blanket-flip the default.
  "ps", "rg",
  // Round 3: read-only inspection tools that were missing from the allowlist
  // (blocked as writes for read-only specialists): hashing, file comparison.
  "shasum", "diff", "cmp",
  // Round 5: process / open-file diagnostics (live reviewer FP: blocked as
  // writes). Base-token normalization (below) also covers `/usr/bin/pgrep` etc.
  "pgrep", "lsof",
  // Round 7: `read` is a shell builtin consuming stdin (never mutates) — needed
  // so `while read -r l; do …; done` loop conditions classify as reads.
  "read",
]);

/** Leading `VAR=value` env-assignment tokens inline a variable, not a command
 *  (commit b977b4b precedent: `CAPTURE_DIR=/tmp/x` names no path, runs no verb).
 *  The regex anchors on the NAME before `=`, so `${VAR:-default}`-valued and
 *  `$$`-containing values classify exactly like plain values. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Verified read-only helper scripts under ~/.pi. Scripts execute arbitrary
 *  code — only named helpers with a known read-only body are allowed, and only
 *  via a `~/.pi/`, `$HOME/.pi/` or absolute `…/.pi/` path form. `claim.sh` is
 *  deliberately absent: it WRITES .claimed-by and must stay blocked. */
const READ_ONLY_PI_SCRIPTS = new Set(["check-claim.sh"]);

/** True when a raw command token names a known read-only ~/.pi helper script. */
function isReadOnlyPiScript(rawCommand: string): boolean {
  if (!rawCommand || !READ_ONLY_PI_SCRIPTS.has(basename(rawCommand))) return false;
  if (rawCommand.startsWith("~/.pi/") || rawCommand.startsWith("$HOME/.pi/")) return true;
  return /^\/.*\/\.pi\/[^/]+$/.test(rawCommand);
}

// Commands that are always write-modifying
const WRITE_COMMANDS = new Set([
  "rm", "mv", "cp", "tee", "chmod", "chown", "mkdir", "touch", "ln",
  "git push", "git commit", "git checkout", "git reset", "git stash",
  "git merge", "git rebase", "git add", "git rm", "git mv",
  // gh write commands
  "gh issue create", "gh issue edit", "gh issue close", "gh issue reopen",
  "gh pr create", "gh pr merge", "gh pr close", "gh pr edit", "gh pr ready", "gh pr review",
  "gh release create", "gh release delete", "gh release edit",
  "gh repo create", "gh repo delete", "gh repo edit",
  "gh auth login", "gh auth logout", "gh auth refresh",
  "gh secret set", "gh secret delete",
  "gh variable set", "gh variable delete",
  "gh label create", "gh label edit", "gh label delete",
  "gh workflow run", "gh workflow enable", "gh workflow disable",
]);

/**
 * True when the command contains an UNQUOTED stdout redirect (>, >>, &>, 1>).
 * Character-wise scan with quote + backslash-escape tracking:
 *   - ` > ` inside quotes (e.g. git log --format="%h > %s", grep patterns) is
 *     data, not a redirect
 *   - stderr-only 2>/2>> redirects are noise suppression, not writes
 */
export function hasUnquotedRedirect(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') {
      // stderr-only: `2>` / `2>>` where the 2 starts a word
      if (command[i - 1] === '2') {
        const before = command[i - 2];
        if (before === undefined || /[\s;&|]/.test(before)) {
          if (command[i + 1] === '>') i++;
          continue;
        }
      }
      return true;
    }
  }
  return false;
}

// ── Round 7: shell loop constructs (`for` / `while` / `until`) ──
// A command that BEGINS with a loop keyword (after leading VAR=value
// assignments) runs its body; the header (`for <var> in …`, `while <cond>`) is
// not itself a command. Callers split commands at shell separators, which
// fragments a loop into `for …` / `do …` / `done` pieces whose fragments are
// not standalone commands — so the whole-text parse below is the only place
// that sees a loop intact.

/** Loop keywords: `for <var> in <list>`, `while <cond>`, `until <cond>`. */
const LOOP_KEYWORDS = new Set(["for", "while", "until"]);

/** One quote-aware token of splitLoopTokens: a word or a shell separator. */
interface LoopToken { value: string; sep: boolean; }

/** Quote-aware split into words and separator tokens (`;`, `&&`, `||`, `|`, `&`). */
function splitLoopTokens(text: string): LoopToken[] {
  const tokens: LoopToken[] = [];
  let current = '';
  let quote: string | null = null;
  const flush = () => {
    if (current.length > 0) tokens.push({ value: current, sep: false });
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < text.length) { current += text[i + 1]; i++; continue; }
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) { current += text[i + 1]; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if (ch === ';' || ch === '&' || ch === '|') {
      flush();
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) {
        tokens.push({ value: ch + ch, sep: true });
        i++;
      } else {
        tokens.push({ value: ch, sep: true });
      }
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

/** Drop `< file` / `<file` input redirects — sourcing stdin is a read. */
function stripInputRedirectTokens(words: string[]): string {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*<$/.test(w)) { i++; continue; }   // `< file` / `0< file`
    if (/^\d*<.+$/.test(w)) continue;         // `<file` / `0<file` / `<<EOF`
    kept.push(w);
  }
  return kept.join(' ');
}

/** Split tokens[start, end) into command segments at separators. Segments
 *  left empty after input-redirect stripping (e.g. `done < /tmp/in.txt` →
 *  nothing) are not commands and are skipped. */
function collectLoopSegments(tokens: LoopToken[], start: number, end: number): string[] {
  const segments: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = stripInputRedirectTokens(buf);
    if (text.trim().length > 0) segments.push(text);
    buf = [];
  };
  for (let i = start; i < end; i++) {
    if (tokens[i].sep) flush();
    else buf.push(tokens[i].value);
  }
  flush();
  return segments;
}

/**
 * Classify a shell loop construct (`for` / `while` / `until`).
 *
 * `for <var> in <list>`: the header/list tokens are DATA for later segments,
 * not a command — skipped. `while <cond>` / `until <cond>`: the condition is a
 * command list — classified. The body between `do` … `done`, plus any commands
 * after `done`, are split on shell separators and classified recursively.
 *
 * @returns true (write) / false (read-only); `undefined` when the command is
 * not a loop or is malformed (missing `do`/`done`) — callers fall back to the
 * unknown-command default (write). Read only when EVERY segment is read-class.
 */
export function classifyLoopCommand(command: string): boolean | undefined {
  const tokens = splitLoopTokens(command);
  let i = 0;
  while (i < tokens.length && !tokens[i].sep && ENV_ASSIGNMENT_RE.test(tokens[i].value)) i++;
  const keyword = tokens[i];
  if (!keyword || keyword.sep || !LOOP_KEYWORDS.has(keyword.value)) return undefined;
  const doIdx = tokens.findIndex((t, idx) => idx > i && !t.sep && t.value === 'do');
  if (doIdx < 0) return undefined; // malformed: no `do`
  let doneIdx = -1;
  for (let j = tokens.length - 1; j > doIdx; j--) {
    if (!tokens[j].sep && tokens[j].value === 'done') { doneIdx = j; break; }
  }
  if (doneIdx < 0) return undefined; // malformed: no `done`
  const segments: string[] = [];
  // while/until conditions are commands; `for` header/list is data.
  if (keyword.value !== 'for') segments.push(...collectLoopSegments(tokens, i + 1, doIdx));
  segments.push(...collectLoopSegments(tokens, doIdx + 1, doneIdx)); // body
  segments.push(...collectLoopSegments(tokens, doneIdx + 1, tokens.length)); // after done
  return segments.some((segment) => isWriteCommand(segment));
}

/**
 * Check if a bash command is write-modifying.
 * @param command - The bash command to classify
 * @returns true if the command modifies files, false if read-only
 */
export function isWriteCommand(command: string): boolean {
  const trimmed = command.trim();

  // Output redirection (quote-aware): ` > ` inside quotes is data; stderr-only
  // 2>/2>> redirects stay ignored. "cmd > /dev/null 2>&1" → write;
  // "cmd 2>/dev/null" → not write; 'git log --format="%h > %s"' → not write.
  if (hasUnquotedRedirect(trimmed)) {
    return true;
  }

  // Round 5: leading env assignments (`VAR=value`, incl. `${VAR:-default}`
  // values) name no command — skip them. Path-qualified binaries classify by
  // BASENAME (`/bin/echo` is `echo`), so absolute/relative read tools are not
  // misread as unknown-command writes.
  const parts = trimmed.split(/\s+/);
  let cmdIndex = 0;
  while (cmdIndex < parts.length && ENV_ASSIGNMENT_RE.test(parts[cmdIndex])) cmdIndex++;
  const rawCommand = parts[cmdIndex] ?? '';
  const baseCommand = rawCommand.includes('/') ? basename(rawCommand) : rawCommand;

  // Round 7: a command BEGINNING with a loop keyword (after leading VAR=value
  // assignments) is a loop construct — classify the whole loop (header/list is
  // data, condition + body are commands). Malformed loops (no `do`/`done`)
  // fall through to the unknown-command default below (write).
  if (LOOP_KEYWORDS.has(baseCommand)) {
    const loopVerdict = classifyLoopCommand(trimmed);
    if (loopVerdict !== undefined) return loopVerdict;
  }

  // Check if base command is a known write command
  if (WRITE_COMMANDS.has(baseCommand)) {
    return true;
  }

  // sed -i edits files in place (incl. combined forms: -ni, -i.bak)
  if (baseCommand === 'sed' && /(^|\s)-[a-zA-Z]*i(?:[.\s]|$)/.test(trimmed)) return true;

  // Shell wrappers run their payload: classify the wrapped command. `-c`
  // payloads are opaque (arbitrary code) — fail closed to write.
  if (baseCommand === 'bash' || baseCommand === 'sh' || baseCommand === 'zsh') {
    const wrapped = parts.slice(cmdIndex + 1);
    // Round 6: `-n`/`--noexec` only syntax-check the script — pure reads, never
    // blocked by design. `-c` payloads are opaque executable code: write-class.
    if (wrapped[0] === '-n' || wrapped[0] === '--noexec') return false;
    if (wrapped.length === 0 || wrapped[0] === '-c') return true;
    return isWriteCommand(wrapped.join(' '));
  }

  // Round 5: verified read-only ~/.pi helper scripts. Checked BEFORE the read
  // allowlist so the raw token keeps its path form for the trust check.
  if (isReadOnlyPiScript(rawCommand)) {
    return false;
  }

  // Check if base command is a known read command
  if (READ_COMMANDS.has(baseCommand)) {
    return false;
  }

  // Check for multi-word git subcommands first
  if (trimmed.startsWith("git stash list")) return false;

  // Check for git subcommands
  if (baseCommand === "git") {
    const subcommand = parts[cmdIndex + 1];
    if (subcommand === '--version' || subcommand === 'version') return false;
    if (subcommand) {
      const gitCmd = `git ${subcommand}`;
      if (WRITE_COMMANDS.has(gitCmd)) return true;
      if (READ_COMMANDS.has(gitCmd)) return false;
    }
  }

  // Check for gh subcommands (typically 3-word: gh <resource> <action>)
  if (baseCommand === "gh") {
    const ghCmd = parts.slice(cmdIndex, cmdIndex + 3).join(" ");
    if (READ_COMMANDS.has(ghCmd)) return false;
    if (WRITE_COMMANDS.has(ghCmd)) return true;
    // Unknown gh subcommands default to write (safe default)
    return true;
  }

  // Check for test runner and type-check commands via package managers
  if (baseCommand === 'npx' || baseCommand === 'npm' || baseCommand === 'yarn' || baseCommand === 'pnpm' || baseCommand === 'bun') {
    const secondWord = parts[cmdIndex + 1];
    const readOnlySubcommands = new Set(['test', 'vitest', 'jest', 'mocha', 'cypress', 'playwright', 'tsc', 'typecheck', 'type-check', 'lint', 'eslint', 'prettier', '--version', '-v', '--help', '-h']);
    const readOnlyScripts = new Set(['test', 'test:unit', 'test:integration', 'typecheck', 'type-check', 'lint', 'typecheck:watch']);
    if (readOnlySubcommands.has(secondWord)) return false;
    if ((baseCommand === 'npm' || baseCommand === 'pnpm' || baseCommand === 'yarn') && secondWord === 'run') {
      const scriptName = parts[cmdIndex + 2];
      if (readOnlyScripts.has(scriptName)) return false;
    }
    if (baseCommand === 'yarn' && readOnlyScripts.has(secondWord)) return false;
  }

  // Unknown commands — default to blocking (safe default)
  return true;
}
