/**
 * Bash command classifier — determines if a command is write-modifying.
 * Uses simple string matching instead of regex for readability.
 */

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
]);

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

  const parts = trimmed.split(/\s+/);
  const baseCommand = parts[0] ?? '';

  // Check if base command is a known write command
  if (WRITE_COMMANDS.has(baseCommand)) {
    return true;
  }

  // sed -i edits files in place (incl. combined forms: -ni, -i.bak)
  if (baseCommand === 'sed' && /(^|\s)-[a-zA-Z]*i(?:[.\s]|$)/.test(trimmed)) return true;

  // Shell wrappers run their payload: classify the wrapped command. `-c`
  // payloads are opaque (arbitrary code) — fail closed to write.
  if (baseCommand === 'bash' || baseCommand === 'sh' || baseCommand === 'zsh') {
    const wrapped = parts.slice(1);
    if (wrapped.length === 0 || wrapped[0] === '-c') return true;
    return isWriteCommand(wrapped.join(' '));
  }

  // Check if base command is a known read command
  if (READ_COMMANDS.has(baseCommand)) {
    return false;
  }

  // Check for multi-word git subcommands first
  if (trimmed.startsWith("git stash list")) return false;

  // Check for git subcommands
  if (baseCommand === "git") {
    const subcommand = parts[1];
    if (subcommand === '--version' || subcommand === 'version') return false;
    if (subcommand) {
      const gitCmd = `git ${subcommand}`;
      if (WRITE_COMMANDS.has(gitCmd)) return true;
      if (READ_COMMANDS.has(gitCmd)) return false;
    }
  }

  // Check for gh subcommands (typically 3-word: gh <resource> <action>)
  if (baseCommand === "gh") {
    const ghCmd = parts.slice(0, 3).join(" ");
    if (READ_COMMANDS.has(ghCmd)) return false;
    if (WRITE_COMMANDS.has(ghCmd)) return true;
    // Unknown gh subcommands default to write (safe default)
    return true;
  }

  // Check for test runner and type-check commands via package managers
  if (baseCommand === 'npx' || baseCommand === 'npm' || baseCommand === 'yarn' || baseCommand === 'pnpm' || baseCommand === 'bun') {
    const secondWord = parts[1];
    const readOnlySubcommands = new Set(['test', 'vitest', 'jest', 'mocha', 'cypress', 'playwright', 'tsc', 'typecheck', 'type-check', 'lint', 'eslint', 'prettier', '--version', '-v', '--help', '-h']);
    const readOnlyScripts = new Set(['test', 'test:unit', 'test:integration', 'typecheck', 'type-check', 'lint', 'typecheck:watch']);
    if (readOnlySubcommands.has(secondWord)) return false;
    if ((baseCommand === 'npm' || baseCommand === 'pnpm' || baseCommand === 'yarn') && secondWord === 'run') {
      const scriptName = parts[2];
      if (readOnlyScripts.has(scriptName)) return false;
    }
    if (baseCommand === 'yarn' && readOnlyScripts.has(secondWord)) return false;
  }

  // Unknown commands — default to blocking (safe default)
  return true;
}
