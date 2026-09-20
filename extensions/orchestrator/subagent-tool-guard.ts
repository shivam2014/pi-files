/**
 * Subagent tool call enforcement — blocks non-native tools, enforces scope.
 * Depends on BashInterceptor, ScopeGuard, and orchestrator state.
 */

import { getBashToolReplacement } from "./bash-interceptor.ts";
import { isWriteCommand } from "./bash-classifier.ts";
import { ScopeGuard } from "./scope-guard.ts";
import type { SubagentState } from "./subagent-sessions.ts";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { debugLog } from "./debug.ts";
import { traceToolCallEntry, tracePathsExtracted, tracePathResolved, traceScopeCheck, traceDecision } from "./debug-path-trace.ts";
import { resolve } from "node:path";
import * as os from 'os';

/** Tools that never modify state — always safe to allow */
const readOnlyTools = new Set(['read', 'grep', 'find', 'ls', 'git-read', 'head', 'tail', 'wc', 'file', 'web_search', 'fetch_content', 'read_skill', 'vision_query', 'glob', 'planSteps', 'advanceStep', 'reportFinding', 'ask_orchestrator']);

/**
 * Advisory-only replacements: read/grep/find/ls bash calls pass through — the
 * suggestion is a hint, not a block (a specialist may legitimately need bash
 * pipes/flags the native tool lacks). Mutating replacements (edit/write) remain
 * hard redirects. Keep in sync with ADVISORY_REPLACEMENT_TOOLS in bash-interceptor.ts.
 */
const ADVISORY_REPLACEMENT_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

// Keep in sync with hasScopedTempWrite() in bash-interceptor.ts (BUG-5).
const SCOPED_TEMP_PATH_RE = /(?:\/private)?\/tmp(?:\/|$)|\$\{?TMPDIR\}?(?:\/|$)/;
function isScopedTempWrite(text: string): boolean {
	if (!SCOPED_TEMP_PATH_RE.test(text)) return false;
	return /\s>>?\s|\b(mkdir|touch|tee|cp|mv|sed|perl|tar|unzip|gzip|gunzip|bzip2|xz|python|python3|node)\b/.test(text);
}

/** True for scratch paths under /tmp (or macOS's /private/tmp alias). */
function isTmpPath(p: string): boolean {
	return p.startsWith('/tmp/') || p.startsWith('/private/tmp/');
}

/**
 * W2: broadened file-like extension allowlist (+sh/json/yaml/md/env/csv/log/mjs/cjs…).
 * Round 2: hoisted to module scope so substitution-payload scanning can reuse it.
 * Limit: bare extensionless filenames without a `/` (Makefile, LICENSE) are only
 * caught via the per-segment write-op extensionless rule.
 */
const pathRegex = /[\w./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|yaml|yml|toml|txt|sh|bash|zsh|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sql|env|csv|tsv|log|xml|html|css|scss|sass|less|vue|svelte|lock|cfg|ini|conf|graphql|proto|tf|tfvars)/g;

/**
 * C2 (round 2): locate command substitutions (`$( … )` with a balanced-paren
 * best-effort scan, and backticks) ANYWHERE in a segment — including inside
 * double quotes, where the tokenizer otherwise leaves only opaque text.
 * Substitutions execute arbitrary code: the owning segment is write-class
 * (fail closed) and the payload is scanned for write-target paths.
 */
function extractCommandSubstitutions(text: string): string[] {
	const subs: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\\') { i++; continue; }
		if (ch === '$' && text[i + 1] === '(') {
			let depth = 1;
			let j = i + 2;
			while (j < text.length && depth > 0) {
				const c = text[j];
				if (c === '\\') { j++; }
				else if (c === '(') depth++;
				else if (c === ')') depth--;
				if (depth === 0) break;
				j++;
			}
			subs.push(text.slice(i + 2, j));
			i = j;
			continue;
		}
		if (ch === '`') {
			const end = text.indexOf('`', i + 1);
			if (end < 0) { subs.push(text.slice(i + 1)); break; }
			subs.push(text.slice(i + 1, end));
			i = end;
			continue;
		}
	}
	return subs;
}

/** C2: write-target candidates inside a substitution payload (best-effort). */
function substitutionWritePaths(inner: string): string[] {
	const found: string[] = [];
	pathRegex.lastIndex = 0;
	for (const m of inner.matchAll(pathRegex)) found.push(m[0]);
	for (const word of inner.split(/\s+/)) {
		const cleaned = word.replace(/^[()"'`]+/, '').replace(/[)"'`;,&|]+$/, '');
		if (cleaned.length === 0 || cleaned.startsWith('-')) continue;
		if (!/[\/]/.test(cleaned)) continue;
		if (/^[a-z][a-z0-9+.-]*:\/\//.test(cleaned)) continue;
		if (!/(?:^|\/)[\w.-]+\/?$/.test(cleaned)) continue;
		if (!found.includes(cleaned)) found.push(cleaned);
	}
	return found;
}

/** Check if a bash call should be intercepted and replaced with a native tool. */
function checkBashInterception(
	event: any,
	override: boolean,
): { block: true; reason: string } | undefined {
	if (event.toolName !== 'bash') return undefined;
	const command = isToolCallEventType('bash', event) ? event.input.command : event.input?.command;
	const replacement = getBashToolReplacement(command, override) ?? { allowed: true };
	if (!replacement.allowed) {
		return {
			block: true,
			reason: replacement.reason || `Bash command blocked (command: ${command?.trim().split(/\s+/)[0]}). Set override:true to bypass.`,
		};
	}
	// Advisory: read-equivalent tool suggestions do NOT block.
	if (replacement.tool && !ADVISORY_REPLACEMENT_TOOLS.has(replacement.tool)) {
		return {
			block: true,
			reason: `Use ${replacement.tool} instead of bash (command: ${command?.trim().split(/\s+/)[0]}). Set override:true in tool input to force bash — e.g. bash({ command: 'your-cmd', override: true }).`,
		};
	}
	return undefined;
}

/**
 * gh write block reason. Truthful about tool availability: coder/reviewer/writer
 * have NO gh tool at all, and where gh exists (scout/researcher) it is
 * read-only (Allowed: list, view, status; `gh api` disallowed). The old wording
 * ("Use the dedicated gh tool instead") told callers to use a tool they lack
 * for a write the tool cannot do. gh writes must route through the orchestrator.
 */
function ghWriteBlockReason(command: string): string {
	return `\u26D4 gh write command blocked. Specialists have no gh write access — the gh tool (available only to scout/researcher) is read-only (list, view, status; gh api disallowed).\nCommand: ${command}\nHint: route the gh write request through the orchestrator instead.`;
}

/** One tokenized shell word. `quoted` marks tokens that contained quoted text. */
interface ShellToken {
	value: string;
	quoted: boolean;
}

/** Shell operators that separate commands on a command line. */
const SHELL_SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

/**
 * Quote-aware shell tokenizer (#139). Whitespace splits tokens; characters
 * inside single/double quotes stay in one token (the quote characters are
 * dropped); unquoted shell separators (&&, ||, ;, |, &) are emitted as
 * standalone tokens. Tokens that contained quoted text are flagged so callers
 * can treat quoted regions — commit messages, sed scripts, grep patterns — as
 * data when classifying and scanning for path-like tokens.
 *
 * C2: backslash escapes are honored — `\"`, `\;`, `\ ` are literal characters,
 * not quote delimiters or separators (`echo \" && rm -f x` still splits on &&).
 * C3: the quoted flag resets on EVERY flush — `rm '' /outside/x.ts` must not
 * leak the quote flag from the empty quoted token onto the next token.
 */
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
			// C2: inside double quotes, backslash escapes ", \\, `, $
			if (ch === '\\' && i + 1 < command.length && '"\\`$'.includes(command[i + 1])) {
				current += command[i + 1];
				i++;
				continue;
			}
			if (ch === '"') quote = null;
			else current += ch;
			continue;
		}
		// C2: outside quotes, backslash makes the next char literal
		// (including quotes and separators). Round 2: the escaped char also flags
		// the token as quoted so `\;` can never fake a segment split.
		if (ch === '\\' && i + 1 < command.length) {
			current += command[i + 1];
			currentQuoted = true;
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

/** A tokenized segment plus the separator token that preceded it (null for the first). */
interface ShellSegment {
	segment: ShellToken[];
	sep: string | null;
}

/** Split a tokenized command line into per-command segments at shell separators. */
function splitShellSegments(tokens: ShellToken[]): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let current: ShellToken[] = [];
	let sep: string | null = null;
	const push = () => {
		if (current.length > 0) segments.push({ segment: current, sep });
		current = [];
	};
	for (const token of tokens) {
		if (!token.quoted && SHELL_SEPARATORS.has(token.value)) {
			push();
			sep = token.value;
		} else {
			current.push(token);
		}
	}
	push();
	return segments;
}

/**
 * Index of the command word in a segment: skips env assignments (VAR=1) and
 * transparent prefixes (export, sudo, time, nohup, env) which do not change
 * the command being run.
 */
function firstCommandIndex(tokens: ShellToken[]): number {
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) { i++; continue; }
		if (token.value === 'export' || token.value === 'sudo' || token.value === 'time' || token.value === 'nohup' || token.value === 'env') { i++; continue; }
		break;
	}
	return i;
}

/**
 * Segment text for the classifier. Quoted tokens become `""` so a quoted `>`
 * (commit message, `--format="%h > %s"`, grep pattern) cannot classify the
 * segment as a write, while unquoted redirects still can.
 */
function classifierText(segment: ShellToken[]): string {
	return segment.map((t) => (t.quoted ? '""' : t.value)).join(' ');
}

const EMPTY_VALUE_FLAGS: ReadonlySet<string> = new Set();

/**
 * W1: flags KNOWN to consume a following value, per command. Only these
 * swallow their operand; boolean flags (-f for rm, -n for grep, …) never do —
 * `rm -f /outside/x.ts` must keep scanning the path after -f.
 */
const VALUE_FLAGS_BY_CMD: Record<string, ReadonlySet<string>> = {
	sed: new Set(['-e', '-f', '--expression', '--file']),
	grep: new Set(['-e', '-f', '--regexp', '--file', '-A', '-B', '-C', '-m', '--max-count', '--include', '--exclude']),
	rg: new Set(['-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '--max-count', '--glob', '--type']),
	git: new Set(['-C', '-c', '-m', '--message', '--git-dir', '--work-tree', '--namespace']),
	find: new Set(['-name', '-iname', '-path', '-type', '-maxdepth', '-mindepth', '-newer']),
	awk: new Set(['-F', '-v', '-f']),
	xargs: new Set(['-n', '-s', '-P', '-I', '-i', '-E', '-d']),
	// C4 (round 2): cp/mv/install `-t`/`--target-directory` are DELIBERATELY
	// omitted — their operand is a write TARGET, not a value to swallow.
	// (Leaving them here skipped the destination: `cp -t /outside src` only
	// checked `src`.)
};

/**
 * C1: wrapper commands that execute a write-classified payload even though the
 * wrapper itself is read-listed — python3 -c / node -e run arbitrary code;
 * xargs <write cmd>; find -exec/-delete. Round 2: script-file operands and
 * inline-code flags for node/python3, and `awk -i inplace`.
 */
function wrapperWrites(tokens: ShellToken[], cmdIdx: number): boolean {
	const word = tokens[cmdIdx]?.value;
	const rest = tokens.slice(cmdIdx + 1);
	const values = rest.map((t) => t.value);
	if (word === 'python' || word === 'python3') {
		// Round 2: -c / -m execute arbitrary code; any non-flag operand is a
		// script file (or heredoc marker) — all write-class.
		if (values.includes('-c') || values.includes('-m')) return true;
		return rest.some((t) => !t.value.startsWith('-'));
	}
	if (word === 'node') {
		// Round 2: -e/--eval/-p/--print execute inline code; any non-flag operand
		// is a script file (or heredoc marker). `node --test …` stays read-class.
		if (values.includes('-e') || values.includes('--eval') || values.includes('-p') || values.includes('--print')) return true;
		if (values.includes('--test')) return false;
		return rest.some((t) => !t.value.startsWith('-'));
	}
	if (word === 'perl') {
		return values.includes('-e') || values.includes('-E');
	}
	if (word === 'awk') {
		// Round 2: `awk -i inplace …` edits files in place.
		return values.includes('-i') || values.includes('-iinplace');
	}
	if (word === 'xargs') {
		let j = 0;
		while (j < rest.length && !rest[j].quoted && rest[j].value.startsWith('-')) j++;
		const inner = rest.slice(j).map((t) => t.value).join(' ');
		return inner.length > 0 && isWriteCommand(inner);
	}
	if (word === 'find') {
		if (values.includes('-delete')) return true;
		const execIdx = values.indexOf('-exec');
		if (execIdx >= 0) {
			const inner = values.slice(execIdx + 1).join(' ');
			return isWriteCommand(inner);
		}
	}
	return false;
}

/**
 * Locate the git invocation inside one shell segment, tolerating leading env
 * assignments (`VAR=1 git …`), a leading `cd <dir>`, and git global options
 * (`-C <dir>`, `-c name=value`). Returns the subcommand, its arguments, and
 * the `git -C <dir>` target (C5) if present.
 */
function findGitCommand(tokens: ShellToken[]): { subcmd: string; args: string[]; cDir?: string } | undefined {
	const at = (idx: number): ShellToken | undefined => tokens[idx];
	let i = 0;
	while (true) {
		const token = at(i);
		if (!token) break;
		if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) { i++; continue; }
		break;
	}
	if (at(i)?.value === 'cd' && at(i + 1)) i += 2;
	if (at(i)?.value !== 'git') return undefined;
	i++;
	// Skip git global options; -C/-c/--git-dir/--work-tree/--namespace take a value.
	let cDir: string | undefined;
	while (true) {
		const flag = at(i);
		if (!flag || !flag.value.startsWith('-')) break;
		if (flag.value === '-C') { cDir = at(i + 1)?.value; i += 2; }
		else if (flag.value === '-c' || flag.value === '--git-dir' || flag.value === '--work-tree' || flag.value === '--namespace') i += 2;
		else i += 1;
	}
	const subcmd = at(i);
	if (!subcmd || subcmd.quoted || SHELL_SEPARATORS.has(subcmd.value)) return undefined;
	return { subcmd: subcmd.value, args: tokens.slice(i + 1).map((t) => t.value), cDir };
}

export function handleSubagentToolCall(event: any, fusionEnabled: boolean = true, ctx?: { cwd?: string; readOnly?: boolean }, subagentState?: SubagentState) {
	traceToolCallEntry('handleSubagentToolCall', event, ctx);
	if (!fusionEnabled && event.toolName === 'fusion') {
		return { block: true, reason: "Fusion is disabled. Enable it in .pi/fusion.json" };
	}
	if (subagentState && !subagentState.planParsed) {
		// Force-plan for ALL tools: read-only children must register their plan too.
		// planSteps itself is NEVER gated — nothing could be planned otherwise
		// (deadlock guard). Update handled in lockstep with the child's first call.
		if (event.toolName !== 'planSteps') {
			return { block: true, reason: `[guard] Framework plan gate: call planSteps({ goal, steps }) before using ${event.toolName}. This notice is a framework prerequisite, not a plan step.` };
		}
	}
	if (subagentState) {
		// Defect A fix: resolve relative tool paths against the DELEGATION's own
		// working directory, recorded on the session at creation time, not against
		// the tool_call ctx.cwd (orchestrator/process cwd). Using the process cwd
		// resolved a subagent's relative path into the wrong tree and produced
		// spurious "File not in approved scope" blocks for legitimate in-scope work.
		const cwd = subagentState.cwd ?? ctx?.cwd ?? process.cwd();
		// Defect B fix: subagent enforcement resolves scope ONLY from this
		// delegation's per-delegation file. Opting out of the shared-file fallback
		// guarantees a stale/unrelated <cwd>/.pi/scope.json can never influence a
		// subagent's writes. A missing delegation id is therefore fail-closed.
		const guard = new ScopeGuard(cwd, subagentState.delegationId, { allowSharedFallback: false });
		// gh write command enforcement — runs for ALL subagents, even without scope
		if (event.toolName === 'bash') {
			const input = event.input || {};
			const command = input.command;
			if (command && command.startsWith('gh ') && isWriteCommand(command)) {
				return { block: true, reason: ghWriteBlockReason(command) };
			}
		}
		// FIX 1 (fail-closed): the scope block ALWAYS runs for subagent tool calls.
		// The previous `if (guard.isScopeValid())` gate skipped enforcement entirely when
		// no scope file existed, turning a documented fail-closed guard into a no-op.
		// Scope applies to write-class tools only: ScopeGuard.isPathAllowed() returns
		// { allowed: true } for operation === 'read', so read/grep/find/ls are never
		// blocked by this — no over-blocking of read-only tools.
		{
			const input = event.input || {};
			// Per-path operation: bash entries carry their own segment-level op (C1);
			// text-tool inputs inherit the tool's operation.
			const filePaths: { raw: string; base: string; op: 'read' | 'write' | 'edit' }[] = [];
			const textOp = event.toolName === 'edit' ? 'edit' : readOnlyTools.has(event.toolName) ? 'read' : 'write';

			if (input.filePath) filePaths.push({ raw: input.filePath, base: cwd, op: textOp });
			if (input.path) filePaths.push({ raw: input.path, base: cwd, op: textOp });
			if (input.file) filePaths.push({ raw: input.file, base: cwd, op: textOp });
			tracePathsExtracted('scope-guard', input, filePaths.map((p) => p.raw));

			// C5: relative tokens resolve against the shell-effective base dir, folded
			// segment by segment (`cd <dir>` anywhere in the chain, `git -C <dir>`),
			// not just a leading chain and not the raw delegation cwd.
			let bashWriteOp = false;
			if (event.toolName === 'bash' && input.command) {
				const cmd = input.command.trim();

				// Git commands that are safe (read-only or no file impact)
				const GIT_SAFE_COMMANDS = new Set([
					'status', 'log', 'diff', 'show', 'branch', 'remote',
					'fetch', 'pull', 'stash', 'tag', 'blame', 'describe',
					'reflog', 'rev-parse', 'rev-list', 'shortlog'
				]);

				// Git commands that write files
				const GIT_WRITE_COMMANDS = new Set([
					'add', 'rm', 'mv', 'checkout', 'restore', 'reset',
					'clean', 'merge', 'rebase', 'cherry-pick'
				]);

				// Git subcommands that are truly read-only (no side effects)
				const GIT_SKIP_SAFE = new Set([
					'fetch', 'pull', 'remote', 'branch', 'tag', 'log', 'status', 'reflog'
				]);
				// Git subcommands that mutate state but don't take file args
				const GIT_SKIP_WRITE = new Set([
					'commit', 'push', 'init', 'clone'
				]);

				// #139: quote-aware, chain-aware segmentation. Quoted regions (commit
				// messages, sed scripts, grep patterns) are flagged by the tokenizer;
				// segments split at &&, ||, ;, | so one command's tokens can never leak
				// into another's scope check.
				const TEST_RUNNER_PREFIXES = ['npx vitest', 'npx jest', 'npm test', 'npx playwright', 'npx mocha', 'npx cypress', 'yarn test', 'pnpm test', 'npx tsc', 'node --test'];
				// W2: file-like token matcher is hoisted to module scope (pathRegex) so
				// substitution-payload scanning can reuse it.

				// C5: fold `cd <dir>` / `git -C <dir>` while walking segments so a
				// mid-chain cd (`true && cd /outside && git add x.ts`) rebases later paths.
				let baseDir = cwd;
				// C5 (round 2): where the current pipeline's filePaths entries begin —
				// used to re-escalate read ops when a downstream xargs is write-class.
				let pipelineEntryStart = 0;
				for (const { segment, sep } of splitShellSegments(tokenizeShell(cmd))) {
					if (sep !== '|') pipelineEntryStart = filePaths.length;
					const segmentEntryStart = filePaths.length;
					const cmdIdx = firstCommandIndex(segment);
					const cmdWord = segment[cmdIdx]?.value;

					// Pure `cd <dir>` segment: rebase every later segment.
					if (cmdWord === 'cd') {
						const target = segment[cmdIdx + 1];
						if (target && !SHELL_SEPARATORS.has(target.value)) {
							baseDir = resolve(baseDir, target.value);
						}
						continue;
					}

					const gitCmd = findGitCommand(segment);
					if (gitCmd) {
						const subcmd = gitCmd.subcmd;
						const args = gitCmd.args;
						// C5: `git -C <dir>` rebases this segment's args only.
						const segBase = gitCmd.cDir ? resolve(baseDir, gitCmd.cDir) : baseDir;

						// Handle multi-word stash subcommands: stash list/show are read-only, rest are writes
						if (subcmd === 'stash') {
							const safeStashSubs = new Set(['list', 'show']);
							const stashSub = args.find((arg: string) => !arg.startsWith('-'));
							// Bare "git stash" defaults to "stash list" (safe)
							if (stashSub && !safeStashSubs.has(stashSub)) {
								// C3 (round 2): stash pop/apply/drop mutate — write-class, so the
								// no-scope fail-closed gate below cannot be skipped.
								bashWriteOp = true;
								if (ctx?.readOnly) {
									return { block: true, reason: `⛔ Git write command blocked for read-only specialist: git stash ${stashSub}` };
								}
							}
						}

						// Skip path check for commands that don't take file args
						if (GIT_SKIP_SAFE.has(subcmd) || GIT_SAFE_COMMANDS.has(subcmd)) {
							// Truly read-only — allow
						} else if (GIT_SKIP_WRITE.has(subcmd)) {
							bashWriteOp = true;
							// Mutating but no file args — block in readOnly mode.
							if (ctx?.readOnly) {
								return { block: true, reason: `⛔ Git write command blocked for read-only specialist: git ${subcmd}` };
							}
							// C4: commit messages are exempt by ARGUMENT POSITION — tokens after
							// -m/--message are messages, everything else may name files. Quoted
							// args are scanned too: a quoted path is still a path.
							// Round 2 (W-b): -F/--file and --author take values too, and a
							// combined short bundle embedding m (`-am …`) takes the message as
							// its next operand.
							let skipNext = false;
							for (const arg of args) {
								if (skipNext) { skipNext = false; continue; }
								if (arg === '-m' || arg === '--message' || arg === '-F' || arg === '--file' || arg === '--author') { skipNext = true; continue; }
								if (arg.startsWith('--message=') || arg.startsWith('--file=') || arg.startsWith('--author=')) continue;
								if (/^-[A-Za-z]*m[A-Za-z]*$/.test(arg)) { skipNext = true; continue; }
								if (arg.startsWith('-')) continue;
								pathRegex.lastIndex = 0;
								for (const match of arg.matchAll(pathRegex)) {
									if (isTmpPath(match[0])) continue;
									filePaths.push({ raw: match[0], base: segBase, op: 'write' });
								}
							}
						} else if (GIT_WRITE_COMMANDS.has(subcmd)) {
							// C3 (round 2): write-class even when no path is extractable
							// (`git add -A`, `git reset --hard`, `git clean -fdx`) — feeds the
							// no-scope fail-closed gate and the readOnly gate.
							bashWriteOp = true;
							// Read-only specialist: block git write commands
							if (ctx?.readOnly) {
								return { block: true, reason: `⛔ Git write command blocked for read-only specialist. Command: git ${subcmd}` };
							}
							// Write commands — extract paths from positional args only, against
							// the effective base dir. Staging args are scope-checked but
							// deliberately NOT size-checked (#139): `git add` of a large
							// in-scope file is legitimate, while genuine bash writes (sed -i on
							// a >400-line file) still hit checkFileSize in the loop below.
							const paths = args.filter((arg: string) => !arg.startsWith('-') && !SHELL_SEPARATORS.has(arg));

							for (const rawPath of paths) {
								const expandedPath = rawPath.startsWith('~/') ? rawPath.replace(/^~/, os.homedir()) : rawPath;
								const absolutePath = resolve(segBase, expandedPath);
								const pathAllowed = guard.isPathAllowed(absolutePath, 'write');
								if (!pathAllowed.allowed) {
									if (subagentState) {
										subagentState.blockedCalls.push({
											tool: event.toolName || 'unknown',
											target: rawPath,
											reason: pathAllowed.reason || 'outside allowed scope',
											timestamp: Date.now(),
										});
									}
									return { block: true, reason: `Scope violation: ${rawPath} is outside the allowed scope` };
								}
							}
						} else {
							// Unknown git subcommand — fail-closed for readOnly, fail-open for others
							bashWriteOp = true;
							if (ctx?.readOnly) {
								return { block: true, reason: `⛔ Unknown git command blocked for read-only specialist: git ${subcmd}` };
							}
						}
					} else {
						// C1: per-segment write classification. classifierText neutralizes
						// quoted tokens so a quoted `>` cannot classify the segment as a write,
						// while unquoted redirects still do. Wrapper forms (python3 -c, node -e,
						// xargs <write cmd>, find -exec/-delete) are write-op by construction.
						// Round 2: (a) re-classify the cmdIdx-anchored slice so transparent
						// prefixes (`env X=1 rm …`) cannot mask a write behind the read-listed
						// `env`; (b) any command substitution is opaque write-class.
						const classifierSegment = classifierText(segment);
						const anchoredText = cmdIdx > 0 && cmdIdx < segment.length ? classifierText(segment.slice(cmdIdx)) : undefined;
						const substitutionInners = extractCommandSubstitutions(segment.map((t) => t.value).join(' '));
						const segmentWrite =
							isWriteCommand(classifierSegment)
							|| (anchoredText !== undefined && isWriteCommand(anchoredText))
							|| wrapperWrites(segment, cmdIdx)
							|| substitutionInners.length > 0;
						if (segmentWrite) bashWriteOp = true;

						// Path extraction happens BEFORE the readOnly gate: the /tmp
						// scratch exemption (W-d, round 2) is target-aware and needs the
						// segment's write targets.
						const segEntries: { raw: string; op: 'read' | 'write' }[] = [];
						// Test runner and compiler commands are read-only — skip file path extraction
						const isTestRunner = TEST_RUNNER_PREFIXES.some(prefix => classifierSegment.startsWith(prefix));
						if (!isTestRunner) {
							// Extract file-like paths from the segment's tokens. C4: quoted
							// tokens are scanned too — a quoted path is still a path. W1: only
							// flags KNOWN to consume a value swallow their operand; boolean
							// flags (-f, -n, …) never do. W2: extensionless candidates count
							// as paths for write ops (round 2: quoted included too).
							const valueFlags = VALUE_FLAGS_BY_CMD[cmdWord ?? ''] ?? EMPTY_VALUE_FLAGS;
							for (let t = 0; t < segment.length; t++) {
								const token = segment[t];
								if (!token) continue;
								const value = token.value;
								if (value === '' || value === '--') continue;
								const prev = segment[t - 1];
								if (prev && !prev.quoted && valueFlags.has(prev.value)) continue;
								const candidates: string[] = [];
								if (value.startsWith('-')) {
									// Attached value form: --output=/outside/x.ts
									const eq = value.indexOf('=');
									if (eq >= 0 && eq < value.length - 1) candidates.push(value.slice(eq + 1));
								} else {
									candidates.push(value);
								}
								for (const candidate of candidates) {
									pathRegex.lastIndex = 0;
									const matches = [...candidate.matchAll(pathRegex)].map((m) => m[0]);
									if (
										matches.length === 0 &&
										segmentWrite &&
										!candidate.startsWith('-') &&
										/[\/]/.test(candidate) &&
										/(?:^|\/)[\w.-]+\/?$/.test(candidate) &&
										!/^[a-z][a-z0-9+.-]*:\/\//.test(candidate) &&
										!(cmdWord === 'sed' && /^s[\/|#@!].*[\/|#@!]/.test(candidate))
									) {
										matches.push(candidate);
									}
									if (matches.length === 0 && /(?:^|\/)\.env(?:\.[\w-]+)?$/.test(candidate)) {
										matches.push(candidate);
									}
									for (const match of matches) {
										segEntries.push({ raw: match, op: segmentWrite ? 'write' : 'read' });
									}
								}
							}
							// C2: substitution payload paths are write targets (best-effort).
							for (const inner of substitutionInners) {
								for (const p of substitutionWritePaths(inner)) {
									segEntries.push({ raw: p, op: 'write' });
								}
							}
						}
						// W-d: the /tmp scratch exemption (BUG-5) is TARGET-aware — a
						// readOnly write is exempt only when every write TARGET is /tmp
						// scratch. For a pure-redirect write (`cat src > /tmp/x`) only the
						// redirect target decides; when the command itself is write-class
						// (`mv <in-scope-src> /tmp/x`) its non-tmp path operands are
						// mutations and must not be waved through.
						const redirectTargets: string[] = [];
						const baseTokens: ShellToken[] = [];
						for (let t = 0; t < segment.length; t++) {
							const token = segment[t];
							if (!token) continue;
							if (!token.quoted && (token.value === '>' || token.value === '>>')) {
								const next = segment[t + 1];
								if (next && !SHELL_SEPARATORS.has(next.value)) {
									redirectTargets.push(next.value);
									t++;
								}
								continue;
							}
							if (!token.quoted && token.value.startsWith('>') && token.value.length > 1) {
								redirectTargets.push(token.value.startsWith('>>') ? token.value.slice(2) : token.value.slice(1));
								continue;
							}
							baseTokens.push(token);
						}
						const baseCmdIdx = firstCommandIndex(baseTokens);
						const baseAnchored = baseCmdIdx > 0 && baseCmdIdx < baseTokens.length ? classifierText(baseTokens.slice(baseCmdIdx)) : undefined;
						const baseWrite =
							redirectTargets.length > 0
								? isWriteCommand(classifierText(baseTokens)) || (baseAnchored !== undefined && isWriteCommand(baseAnchored)) || wrapperWrites(baseTokens, baseCmdIdx)
								: segmentWrite;
						const nonTmpWriteSeen = baseWrite
							? segEntries.some((e) => e.op === 'write' && !isTmpPath(e.raw))
							: redirectTargets.some((t) => !isTmpPath(t));
						if (ctx?.readOnly && segmentWrite && !(isScopedTempWrite(classifierSegment) && !nonTmpWriteSeen)) {
							return { block: true, reason: `⛔ Bash write command blocked for read-only specialist. Use the appropriate SDK tool instead.\nCommand: ${cmd}\nHint: For file reads, use read(). For code search, use grep(). For file listing, use find() or ls().` };
						}
						// Commit entries; /tmp scratch paths stay exempt from scope checks.
						for (const e of segEntries) {
							if (isTmpPath(e.raw)) continue;
							filePaths.push({ raw: e.raw, base: baseDir, op: e.op });
						}
						// C5 (round 2): a write-class xargs bridges stdin into file mutation —
						// re-escalate prior read ops from the same pipeline so
						// `echo /outside/x.ts | xargs rm -f` is write-checked.
						if (cmdWord === 'xargs' && segmentWrite) {
							for (let e = pipelineEntryStart; e < segmentEntryStart; e++) {
								if (filePaths[e].op === 'read') filePaths[e].op = 'write';
							}
						}
					}
				}
			}

			// Derive operation from tool name — reads always safe, writes require scope approval.
			// C1: for bash, per-segment classification decides — any segment that is
			// write-classified (or carries an unquoted redirect) makes bash write-class.
			const operation = event.toolName === 'edit' ? 'edit'
				: readOnlyTools.has(event.toolName) ? 'read'
				: event.toolName === 'bash' ? (bashWriteOp ? 'write' : 'read')
				: 'write'; // fail-closed: unknown tools treated as mutations

			// FIX 1 (fail-closed, defense in depth): a write-class operation with no
			// established scope is denied even when no concrete path could be extracted.
			// When a path IS extracted the per-path loop below emits the canonical
			// "Scope violation: <path> is outside the allowed scope" message instead.
			if (operation !== 'read' && !guard.isScopeValid() && filePaths.length === 0) {
				if (subagentState) {
					subagentState.blockedCalls.push({
						tool: event.toolName || 'unknown',
						target: '(unresolved)',
						reason: 'No scope file',
						timestamp: Date.now(),
					});
				}
				const noScope = { block: true as const, reason: 'Scope violation: no approved scope is established for this subagent' };
				traceDecision('handleSubagentToolCall/subagent', event, noScope);
				return noScope;
			}

			for (const entry of filePaths) {
				const rawPath = entry.raw;
				const expandedPath = rawPath.startsWith('~/') ? rawPath.replace(/^~/, os.homedir()) : rawPath;
				const absolutePath = resolve(entry.base, expandedPath);
				tracePathResolved('scope-guard', rawPath, absolutePath, entry.op);
				const pathAllowed = guard.isPathAllowed(absolutePath, entry.op);
				traceScopeCheck('scope-guard', absolutePath, pathAllowed.allowed, pathAllowed.reason);
				if (!pathAllowed.allowed) {
					if (subagentState) {
						subagentState.blockedCalls.push({
							tool: event.toolName || 'unknown',
							target: rawPath,
							reason: pathAllowed.reason || 'outside allowed scope',
							timestamp: Date.now(),
						});
					}
					const expansion = guard.requestExpansion(rawPath);
					debugLog("scope-guard: expansion request", expansion);
					return { block: true, reason: `Scope violation: ${rawPath} is outside the allowed scope`, expansionRequest: expansion };
				}
				let fileContent = '';
				if (entry.op === 'write' && input.content) {
					// For write operations, check the NEW content size, not existing file
					fileContent = input.content;
				} else {
					try { fileContent = readFileSync(absolutePath, 'utf-8'); } catch {}
				}
				const sizeCheck = guard.checkFileSize(absolutePath, fileContent, entry.op);
				if (!sizeCheck.allowed) {
					return { block: true, reason: sizeCheck.reason || `File too large: ${rawPath}` };
				}
			}
		}
		// Bash-to-read enforcement for subagents
		const interception = checkBashInterception(event, event.input?.override === true);
		if (interception) { traceDecision('handleSubagentToolCall/subagent', event, interception); return interception; }
		traceDecision('handleSubagentToolCall/subagent', event, { block: false });
		return;
	}
	// Read-only bash enforcement (orchestrator context)
	if (event.toolName === 'bash') {
		const command = isToolCallEventType('bash', event) ? event.input.command : event.input?.command;
		if (command && command.startsWith('gh ') && isWriteCommand(command)) {
			const blockResult = { block: true, reason: ghWriteBlockReason(command) };
			traceDecision('handleSubagentToolCall', event, blockResult);
			return blockResult;
		}
		// Ordering: the scoped /tmp scratch exemption applies before the read-only
		// write block, mirroring bash-interceptor.ts BUG-5 semantics —
		// `cat f > /tmp/out.txt` passes for read-only specialists.
		if (ctx?.readOnly && command && isWriteCommand(command) && !isScopedTempWrite(command)) {
			const blockResult = { block: true, reason: `⛔ Bash write command blocked for read-only specialist.\nCommand: ${command}\nHint: For file reads, use read(). For code search, use grep(). For file listing, use find() or ls().` };
			traceDecision('handleSubagentToolCall', event, blockResult);
			return blockResult;
		}
	}
	const interception = checkBashInterception(event, event.input?.override === true);
	if (interception) { traceDecision('handleSubagentToolCall', event, interception); return interception; }
	traceDecision('handleSubagentToolCall', event, { block: false });
}
