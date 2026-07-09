/**
 * Bash command classifier — determines if a command is write-modifying.
 * Uses simple string matching instead of regex for readability.
 */

// Commands that are always read-only
const READ_COMMANDS = new Set([
  "ls", "cat", "grep", "find", "head", "tail", "wc", "echo", "pwd", "date",
  "git status", "git log", "git diff", "git show", "git branch", "git remote",
  "which", "whoami", "hostname", "uname", "env", "printenv",
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
  
  // Check for output redirection (always write)
  if (trimmed.includes(" > ") || trimmed.endsWith(">") || 
      trimmed.includes(" >> ") || trimmed.endsWith(">>") ||
      trimmed.includes(" 2>") || trimmed.includes(" 1>")) {
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
