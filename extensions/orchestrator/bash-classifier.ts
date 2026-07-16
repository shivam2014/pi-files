/**
 * Bash command classifier — determines if a command is write-modifying.
 * Uses simple string matching instead of regex for readability.
 */

// Commands that are always read-only
const READ_COMMANDS = new Set([
  "ls", "cat", "grep", "find", "head", "tail", "wc", "echo", "pwd", "date",
  "git status", "git log", "git diff", "git show", "git branch", "git remote",
  "git tag", "git blame", "git reflog", "git describe",
  "which", "whoami", "hostname", "uname", "env", "printenv",
  "python3", "node", "cd", "sort", "du", "df", "stat", "file", "man", "type",
  "readlink", "realpath", "dirname", "basename", "xargs", "awk", "sed", "jq",
]);

// Commands that are always write-modifying
const WRITE_COMMANDS = new Set([
  "rm", "mv", "cp", "tee", "chmod", "chown", "mkdir", "touch", "ln",
  "git push", "git commit", "git checkout", "git reset", "git stash",
  "git merge", "git rebase", "git add", "git rm", "git mv",
]);

/**
 * Check if a bash command is write-modifying.
 * @param command - The bash command to classify
 * @returns true if the command modifies files, false if read-only
 */
export function isWriteCommand(command: string): boolean {
  const trimmed = command.trim();
  
  // Strip stderr-only redirects (2> or 2>>) before checking for stdout redirects.
  // These suppress error noise, not redirect output to files.
  // After stripping, check for remaining stdout redirects (>, >>, &>, 1>) as write indicators.
  // "cmd > /dev/null 2>&1" → still write (stdout > remains after stripping 2>)
  // "cmd &> /dev/null" → still write (&> is not a 2> pattern)
  // "cmd 2>/dev/null" → not write (2> stripped, no stdout redirect remains)
  const withoutStderrRedirects = trimmed.replace(/\b2>>?/g, '');
  
  // Check for output redirection (always write)
  if (withoutStderrRedirects.includes(" > ") || withoutStderrRedirects.endsWith(">") || 
      withoutStderrRedirects.includes(" >> ") || withoutStderrRedirects.endsWith(">>") ||
      withoutStderrRedirects.includes(" &>") || withoutStderrRedirects.includes(" 1>")) {
    return true;
  }
  
  // Extract the base command (first word)
  const baseCommand = trimmed.split(/\s+/)[0];
  
  // Check if base command is a known write command
  if (WRITE_COMMANDS.has(baseCommand)) {
    return true;
  }
  
  // Check if base command is a known read command
  if (READ_COMMANDS.has(baseCommand)) {
    return false;
  }
  
  // Check for multi-word git subcommands first
  if (trimmed.startsWith("git stash list")) return false;
  
  // Check for git subcommands
  if (baseCommand === "git") {
    const subcommand = trimmed.split(/\s+/)[1];
    if (subcommand) {
      const gitCmd = `git ${subcommand}`;
      if (WRITE_COMMANDS.has(gitCmd)) return true;
      if (READ_COMMANDS.has(gitCmd)) return false;
    }
  }
  
  // Unknown commands — default to blocking (safe default)
  return true;
}
