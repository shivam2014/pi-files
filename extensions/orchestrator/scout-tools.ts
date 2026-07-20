/**
 * Scout custom tools — read-only git and gh operations.
 * Scout uses these instead of bash for git/gh tasks.
 */

import { spawnSync } from "node:child_process";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Read-only git subcommands ───────────────────────────────────────────
const GIT_READ_COMMANDS = new Set([
	"log", "diff", "status", "show", "branch", "remote",
	"ls-files", "describe", "shortlog", "blame",
	"rev-parse", "rev-list", "cat-file", "ls-tree",
	"for-each-ref", "merge-base", "name-rev",
	"help", "version", "var", "check-attr",
	"check-ignore", "check-mailmap", "count-objects",
	"tag", "worktree",
]);

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Parse a git command string into an array of git-safe arguments.
 * Handles quoted strings (single and double), strips shell redirects
 * (2>/dev/null, >/dev/null, &>/dev/null), and strips pipe + everything after.
 */
export function parseGitArgs(input: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	let current = "";
	let inSingle = false;
	let inDouble = false;

	while (i < input.length) {
		const ch = input[i];

		// Handle pipe — stop entirely
		if (ch === "|" && !inSingle && !inDouble) {
			if (current.trim()) tokens.push(current);
			break;
		}

		// Detect redirect start (>, digit+>, &>) — skip until whitespace
		if ((ch === ">" || (ch >= "0" && ch <= "9") || ch === "&") && !inSingle && !inDouble) {
			// Check if this is a redirect (>file, N>file, &>file)
			let isRedirect = false;
			let lookahead = i;
			// Consume digits for N> syntax
			while (lookahead < input.length && input[lookahead] >= "0" && input[lookahead] <= "9") {
				lookahead++;
			}
			if (lookahead < input.length && input[lookahead] === ">") {
				isRedirect = true;
			} else if (lookahead < input.length && input[lookahead] === "&" && lookahead + 1 < input.length && input[lookahead + 1] === ">") {
				isRedirect = true;
			}
			if (isRedirect) {
				if (current.trim()) tokens.push(current);
				current = "";
				// Skip the entire redirect token (e.g., "2>/dev/null", ">&1", "&>/dev/null")
				while (i < input.length && input[i] !== " " && input[i] !== "\t") {
					i++;
				}
				continue;
			}
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			i++;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			i++;
			continue;
		}

		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			i++;
			continue;
		}

		current += ch;
		i++;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Find the git subcommand by skipping over global git options (flags like
 * -C <path>, --git-dir=<path>, -c <name>=<value>, etc.) that precede it.
 * Returns null if no subcommand is found.
 */
function findGitSubcommand(tokens: string[]): string | null {
	const TAKES_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path"]);
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t === "--") break; // end of options marker
		if (!t.startsWith("-")) return t; // first non-flag token = subcommand
		if (TAKES_ARG.has(t)) {
			i += 2; // skip flag and its value
		} else if (t.includes("=")) {
			i += 1; // flag with embedded value, e.g. --git-dir=/path
		} else {
			i += 1; // boolean flag (--paginate, --no-pager, --bare, etc.)
		}
	}
	return null;
}

// ── git-read: Read-only git operations ──────────────────────────────────

export const gitReadTool = defineTool({
	name: "git-read",
	label: "Git Read",
	description: "Run read-only git operations (log, diff, status, show, branch, remote, etc.)",
	promptSnippet: "Run read-only git commands",
	promptGuidelines: [
		"Use for viewing git history, diffs, status, branches, remotes",
		"Only read-only git subcommands are allowed",
		"Do not use for writing, committing, pushing, or modifying the repo",
	],
	parameters: Type.Object({
		args: Type.String({
			description: "Git arguments (e.g., 'log --oneline -5', 'diff HEAD~1', 'status', 'branch -a'). Supports git global flags like '-C <path>' and '--git-dir=<path>'.",
		}),
	}),
	execute: async (_toolCallId, params) => {
		const args = params.args.trim();
		if (!args) {
			return {
				content: [{ type: "text", text: "Error: no arguments provided" }],
				details: { exitCode: null },
			};
		}
		const tokens = parseGitArgs(args);
		const subcommand = findGitSubcommand(tokens);
		if (!subcommand || !GIT_READ_COMMANDS.has(subcommand)) {
			const allowed = [...GIT_READ_COMMANDS].sort().join(", ");
			const shown = subcommand ? `'git ${subcommand}'` : "the given arguments";
			return {
				content: [{ type: "text", text: `Error: ${shown} is not a read-only command.\nAllowed: ${allowed}` }],
				details: { exitCode: null },
			};
		}
		try {
			const result = spawnSync("git", tokens, {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				timeout: 15000,
			});
			const output = (result.stdout || "") + (result.stderr || "");
			return {
				content: [{ type: "text", text: output || "(no output)" }],
				details: { exitCode: result.status },
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Error running git: ${err}` }],
				details: { exitCode: null },
			};
		}
	},
});

// ── gh: Read-only GitHub operations ─────────────────────────────────────

const GH_READ_COMMANDS = new Set([
	"repo", "issue", "pr", "search", "release", "auth", "status",
]);

const GH_SEARCH_SUBCOMMANDS = new Set(["issues", "prs", "repos", "code", "commits"]);
const GH_REPO_SUBCOMMANDS = new Set(["view", "list"]);
const GH_ISSUE_SUBCOMMANDS = new Set(["list", "view", "status"]);
const GH_PR_SUBCOMMANDS = new Set(["list", "view", "status", "diff", "checks"]);
const GH_RELEASE_SUBCOMMANDS = new Set(["list", "view"]);
const GH_AUTH_SUBCOMMANDS = new Set(["status"]);

export const ghTool = defineTool({
	name: "gh",
	label: "GitHub CLI",
	description: "Run read-only GitHub operations (repo view, issue list, pr list, search, etc.)",
	promptSnippet: "Run read-only GitHub CLI commands",
	promptGuidelines: [
		"Use for viewing repos, issues, PRs, releases, searching",
		"Only read-only operations are allowed (view, list, status, search)",
		"Do not use for creating, editing, or deleting GitHub resources",
	],
	parameters: Type.Object({
		args: Type.String({
			description: "GitHub CLI arguments (e.g., 'repo view', 'issue list -L 5', 'pr list --state open')",
		}),
	}),
	execute: async (_toolCallId, params) => {
		const args = params.args.trim();
		if (!args) {
			return {
				content: [{ type: "text", text: "Error: no arguments provided" }],
				details: { exitCode: null },
			};
		}
		const tokens = args.split(/\s+/);
		const firstWord = tokens[0];
		const secondWord = tokens[1] || "";

		if (!GH_READ_COMMANDS.has(firstWord)) {
			const allowed = [...GH_READ_COMMANDS].sort().join(", ");
			return {
				content: [{ type: "text", text: `Error: 'gh ${firstWord}' is not allowed.\nAllowed: ${allowed}` }],
				details: { exitCode: null },
			};
		}

		if (firstWord === "repo" && secondWord && !GH_REPO_SUBCOMMANDS.has(secondWord)) {
			return { content: [{ type: "text", text: `Error: 'gh repo ${secondWord}' is not read-only. Allowed: ${[...GH_REPO_SUBCOMMANDS].join(", ")}` }], details: { exitCode: null } };
		}
		if (firstWord === "issue" && secondWord && !GH_ISSUE_SUBCOMMANDS.has(secondWord)) {
			return { content: [{ type: "text", text: `Error: 'gh issue ${secondWord}' is not read-only. Allowed: ${[...GH_ISSUE_SUBCOMMANDS].join(", ")}` }], details: { exitCode: null } };
		}
		if (firstWord === "pr" && secondWord && !GH_PR_SUBCOMMANDS.has(secondWord)) {
			return { content: [{ type: "text", text: `Error: 'gh pr ${secondWord}' is not read-only. Allowed: ${[...GH_PR_SUBCOMMANDS].join(", ")}` }], details: { exitCode: null } };
		}
		if (firstWord === "release" && secondWord && !GH_RELEASE_SUBCOMMANDS.has(secondWord)) {
			return { content: [{ type: "text", text: `Error: 'gh release ${secondWord}' is not read-only. Allowed: ${[...GH_RELEASE_SUBCOMMANDS].join(", ")}` }], details: { exitCode: null } };
		}
		if (firstWord === "auth" && secondWord && !GH_AUTH_SUBCOMMANDS.has(secondWord)) {
			return { content: [{ type: "text", text: `Error: 'gh auth ${secondWord}' is not allowed. Allowed: ${[...GH_AUTH_SUBCOMMANDS].join(", ")}` }], details: { exitCode: null } };
		}
		if (firstWord === "search" && secondWord && !GH_SEARCH_SUBCOMMANDS.has(secondWord)) {
			return { content: [{ type: "text", text: `Error: 'gh search ${secondWord}' is not supported. Allowed: ${[...GH_SEARCH_SUBCOMMANDS].join(", ")}` }], details: { exitCode: null } };
		}

		try {
			const result = spawnSync("gh", tokens, {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				timeout: 15000,
			});
			const output = (result.stdout || "") + (result.stderr || "");
			return {
				content: [{ type: "text", text: output || "(no output)" }],
				details: { exitCode: result.status },
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Error running gh: ${err}` }],
				details: { exitCode: null },
			};
		}
	},
});
