#!/usr/bin/env node
// @ts-nocheck — plain-JS CLI (no type declarations); behaviour is covered by build-system-prompt.test.ts.
/**
 * render-specialist-prompt.mjs — render the FULL prompt a named specialist subagent receives,
 * offline, through the real code paths the runner uses (subagent-runner.ts:1105-1146):
 *   - DefaultResourceLoader({ noSkills: true, additionalSkillPaths: <suggestedSkills ∩ disk>,
 *     systemPromptOverride: () => SPECIALISTS[name].systemPrompt, noContextFiles: true })
 *   - createAgentSession({ tools: specialist.tools + runner extras, excludeTools })
 *   - bindExtensions + emitBeforeAgentStart → the full extension chain (token-saver et al.)
 * plus optional delegation scope / budget sections, byte-copied from subagent-runner.ts:1121-1138.
 *
 * Usage: node scripts/render-specialist-prompt.mjs --specialist NAME [--cwd DIR] [--json]
 *        [--diff CAPTURE.json] [--scope-json FILE] [--budget-json FILE] [--pi-root DIR] [--allow-old-pi]
 *        node scripts/render-specialist-prompt.mjs --all [--cwd DIR]
 * Exit: 0 ok/identical, 1 diff found, 2 unresolved.
 * NOTE: pi's base prompt injects a <skills> section only when a skill-file-reading tool is
 * declared (core/system-prompt.js:101-109, readers = ["read","bash"]) — so read/bash-bearing
 * specialists get FULL skill descriptions while the orchestrator (no read/bash) does not.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentDir, loadExtensionModules, muteStreams, resolvePi, ResolutionError } from "./build-system-prompt.mjs";
import { CaptureError, extractCaptureText, formatDiff } from "./unified-diff.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(SCRIPT_DIR, "..");
export const EXTRA_TOOLS = ["planSteps", "advanceStep", "reportFinding", "ask_orchestrator", "read_skill", "vision_query", "glob"];
export const SUBAGENT_ENV_KEY = "PI_ORCHESTRATOR_SUBAGENT";
const USAGE = `Usage: node scripts/render-specialist-prompt.mjs --specialist NAME [--cwd DIR] [--json] [--diff CAPTURE.json] [--pi-root DIR] [--allow-old-pi]
       node scripts/render-specialist-prompt.mjs --all [--cwd DIR]
  --specialist NAME  render one specialist (e.g. coder, scout, reviewer, researcher, writer)
  --all              render every specialist in SPECIALISTS and print a compact table
  --cwd DIR          render for DIR (default: process.cwd())
  --json             emit { specialist, cwd, piVersion, tools, charCount, lineCount, skillsSectionPresent, prompt }
  --diff FILE        unified diff vs a prompt-dump capture's systemPrompt; exit 1 if they differ
  --scope-json FILE  JSON { filesToModify, filesToCreate, directories, maxFiles, requiresApprovalBeyondScope,
                     changeType, maxLinesPerFile, boundaries } → scope section (subagent-runner.ts:1121-1132)
  --budget-json FILE JSON { maxExplorationCalls, maxFiles, maxTurns } → delegation-budget override section
  --pack "a,b"       override the delegation's skills (defaults ∪ override, specialists.ts:649-653)
  --pi-root DIR      render from this pi install
  --allow-old-pi     permit rendering from a pi older than ${"1.3.0"} (blocks by default)
`;

export function parseArgs(argv) {
	const opts = { specialist: null, all: false, cwd: process.cwd(), json: false, diff: null, scopeJson: null, budgetJson: null, pack: null, piRoot: null, allowOldPi: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = (flag) => {
			const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
			if (!v) throw new ResolutionError(`${flag} requires a value`);
			return v;
		};
		if (a === "--specialist" || a.startsWith("--specialist=")) opts.specialist = val("--specialist");
		else if (a === "--all") opts.all = true;
		else if (a === "--cwd" || a.startsWith("--cwd=")) opts.cwd = path.resolve(val("--cwd"));
		else if (a === "--json") opts.json = true;
		else if (a === "--diff" || a.startsWith("--diff=")) opts.diff = path.resolve(val("--diff"));
		else if (a === "--scope-json" || a.startsWith("--scope-json=")) opts.scopeJson = path.resolve(val("--scope-json"));
		else if (a === "--budget-json" || a.startsWith("--budget-json=")) opts.budgetJson = path.resolve(val("--budget-json"));
		else if (a === "--pack" || a.startsWith("--pack=")) opts.pack = val("--pack").split(",").map((s) => s.trim()).filter(Boolean);
		else if (a === "--pi-root" || a.startsWith("--pi-root=")) opts.piRoot = path.resolve(val("--pi-root"));
		else if (a === "--allow-old-pi") opts.allowOldPi = true;
		else if (a === "--help" || a === "-h") opts.help = true;
		else throw new ResolutionError(`unknown argument: ${a}`);
	}
	return opts;
}

/** esbuild bundles each module under a namespace key (see NAMESPACES in build-system-prompt.mjs). */
function specialistsNamespace(modules) {
	return modules?.specialists ?? modules ?? {};
}

/** Tool list the runner passes to the subagent session (subagent-runner.ts:1303). */
export function specialistTools(modules, name) {
	const ns = specialistsNamespace(modules);
	const spec = ns.SPECIALISTS?.[name];
	if (!spec) throw new ResolutionError(`unknown specialist "${name}"; known: ${Object.keys(ns.SPECIALISTS ?? {}).join(", ") || "(none)"}`);
	const all = [...(spec.tools || []), ...EXTRA_TOOLS];
	return ns.canUseBash(name) ? all : all.filter((t) => t !== "bash");
}

/** Scope section, byte-copied from subagent-runner.ts:1121-1132 (call site :1139-1141 loads skills). */
export function scopeSection(scope) {
	if (!scope) return "";
	const filesToModify = Array.isArray(scope.filesToModify) ? scope.filesToModify : [];
	const filesToCreate = Array.isArray(scope.filesToCreate) ? scope.filesToCreate : [];
	const modFiles = filesToModify.length > 0 ? filesToModify.map((f) => `  - ${f}`).join("\n") : "  - (none)";
	const createFiles = filesToCreate.length > 0 ? filesToCreate.map((f) => `  - ${f}`).join("\n") : "  - (none)";
	const dirs = Array.isArray(scope.directories) && scope.directories.length > 0 ? scope.directories.join(", ") : "(none)";
	let prompt = `\n\n## Scope Restrictions\nYou may ONLY modify/create files within this scope:\n- Files to modify:\n${modFiles}\n- Files to create:\n${createFiles}\n- Allowed directories: ${dirs}\n- Max files: ${scope.maxFiles ?? 10}\n- Changes beyond scope require approval: ${scope.requiresApprovalBeyondScope ?? true}\n`;
	if (scope.changeType) prompt += `- Change type: ${scope.changeType} (${scope.changeType === "single-file" ? "edit one file" : "may edit multiple files"})\n`;
	if (scope.maxLinesPerFile) prompt += `- Max lines per file: ${scope.maxLinesPerFile}\n`;
	if (scope.boundaries) prompt += `- Boundaries: ${scope.boundaries}\n`;
	return prompt;
}

export function budgetSection(budget) {
	if (!budget) return "";
	return `\n\n## Delegation Budget (override)\nThis delegation's counted budget is MORE THAN ${budget.maxExplorationCalls} exploration calls (read/grep/find/ls), MORE THAN ${budget.maxFiles} distinct files, or MORE THAN ${budget.maxTurns} turns. These numbers supersede the default budget above.\n`;
}

/** resolveSpecialistSkills semantics (specialists.ts:649-653): defaults, or defaults ∪ override. */
export function resolvePack(spec, override) {
	const defaults = spec?.suggestedSkills ?? [];
	if (override === undefined || override === null) return [...defaults];
	return [...new Set([...defaults, ...override])];
}

/** Render one specialist's final prompt (the text the provider receives as the leading system prompt). */
export async function renderSpecialist(opts, name, preloaded) {
	const resolved = preloaded?.resolved ?? resolvePi(opts);
	const piRoot = resolved.root;
	const modules = preloaded?.modules ?? (await loadExtensionModules(piRoot)).modules;
	const ns = specialistsNamespace(modules);
	const spec = ns.SPECIALISTS?.[name];
	const tools = specialistTools(modules, name);
	const scope = opts.scopeJson ? JSON.parse(fs.readFileSync(opts.scopeJson, "utf8")) : null;
	const budget = opts.budgetJson ? JSON.parse(fs.readFileSync(opts.budgetJson, "utf8")) : null;
	const pack = resolvePack(spec, opts.pack);
	const skillsDir = path.join(agentDir(), "skills");
	const resolvedSkillPaths = pack.map((s) => path.join(skillsDir, s, "SKILL.md")).filter((p) => fs.existsSync(p));
	// subagent-runner.ts:1139-1141 appends the skill block whenever the resolved pack is non-empty.
	const skillSection = pack.length > 0 && typeof ns.buildSkillSection === "function" ? ns.buildSkillSection(name, pack) : "";

	// Emulate the subagent context. subagent-runner.ts:1113-1114 sets PI_ORCHESTRATOR_SUBAGENT=1
	// right before the child loader boots; index.ts:100 reads it as isSubagentLoad.
	// A standalone process cannot rely on that flag alone: index.ts:88-95 defensively DELETES it
	// when `subagentSessions.size === 0` (no in-process parent session), and the SDK loads every
	// .ts extension through its own jiti instance (dist/core/extensions/loader.js:477-481), so the
	// renderer cannot populate the parent's map. Loading every discovered extension EXCEPT the
	// orchestrator's index.ts is behaviorally identical for a subagent: its handlers return early
	// (index.ts:125,141,172) and its resources_discover registers nothing while isSubagentLoad.
	process.env[SUBAGENT_ENV_KEY] = "1";
	const pi = await import(pathToFileURL(path.join(piRoot, "dist", "index.js")).href);
	let discoveredPaths = [];
	{
		const restore = muteStreams();
		try {
			const probe = new pi.DefaultResourceLoader({ cwd: opts.cwd, agentDir: agentDir() });
			await probe.reload();
			discoveredPaths = (probe.getExtensions?.()?.extensions ?? []).map((e) => e.path).filter(Boolean);
		} finally {
			restore();
		}
	}
	// Discovery always walks the LIVE agent dir (`new pi.DefaultResourceLoader({ agentDir: agentDir() })`), so when
	// EXT_DIR is a repo copy the `path.join(EXT_DIR, "index.ts")` comparison never matches there and the
	// orchestrator extension leaks into the render. Exclude it by RESOLVED IDENTITY instead: the agent-dir path
	// (plus its realpath) alongside the EXT_DIR comparison, which stays for installs where the two agree.
	const orchestratorEntries = new Set(
		[path.join(EXT_DIR, "index.ts"), path.join(agentDir(), "extensions", "orchestrator", "index.ts")].flatMap((p) => {
			try {
				return [path.normalize(p), path.normalize(fs.realpathSync(p))];
			} catch {
				return [path.normalize(p)];
			}
		}),
	);
	const extensionPaths = discoveredPaths.filter((p) => {
		let real = p;
		try {
			real = fs.realpathSync(p);
		} catch {
			/* keep the literal discovered path */
		}
		return !orchestratorEntries.has(path.normalize(p)) && !orchestratorEntries.has(path.normalize(real));
	});

	const loader = new pi.DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: agentDir(),
		noExtensions: true,
		additionalExtensionPaths: extensionPaths,
		noSkills: true,
		additionalSkillPaths: resolvedSkillPaths,
		systemPromptOverride: () => spec.systemPrompt + scopeSection(scope) + budgetSection(budget) + skillSection,
		noContextFiles: true,
	});
	{
		const restore = muteStreams();
		try {
			await loader.reload();
		} finally {
			restore();
		}
	}
	const { session } = await pi.createAgentSession({
		sessionManager: pi.SessionManager.inMemory(),
		cwd: opts.cwd,
		agentDir: agentDir(),
		resourceLoader: loader,
		tools,
		...(ns.canUseBash(name) ? {} : { excludeTools: ["bash"] }),
	});
	try {
		await session?.bindExtensions?.({});
	} catch {
		/* keep the pre-bind prompt */
	}
	let prompt;
	try {
		const runner = session?._extensionRunner;
		if (runner?.emitBeforeAgentStart) {
			const { buildSystemPrompt } = await import(pathToFileURL(path.join(piRoot, "dist", "core", "system-prompt.js")).href);
			const result = await runner.emitBeforeAgentStart({ messageType: "print" }, session._baseSystemPromptOptions);
			prompt = buildSystemPrompt(result?.systemPromptOptions ?? session._baseSystemPromptOptions);
		}
	} catch {
		/* fall through to the structured prompt */
	}
	if (typeof prompt !== "string" || !prompt.length) prompt = session.systemPrompt;
	if (typeof prompt !== "string" || !prompt.length) throw new ResolutionError(`rendering "${name}" produced an empty prompt`);
	return { specialist: name, tools, charCount: prompt.length, lineCount: prompt.split("\n").length, skillsSectionPresent: prompt.includes("<skills>"), prompt, piVersion: resolved.version, cwd: opts.cwd, source: resolved.origin };
}

function fail(err) {
	process.stderr.write(`render-specialist-prompt: ${err instanceof Error ? err.message : String(err)}\n`);
}

async function main(argv) {
	let opts;
	try {
		opts = parseArgs(argv);
	} catch (err) {
		fail(err);
		process.stderr.write(USAGE);
		return 2;
	}
	if (opts.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	try {
		const resolved = resolvePi(opts);
		const { modules } = await loadExtensionModules(resolved.root);
		const ns = specialistsNamespace(modules);
		const names = opts.all ? Object.keys(ns.SPECIALISTS ?? {}) : [opts.specialist];
		if (!names[0]) throw new ResolutionError("--specialist NAME or --all is required");
		const rendered = [];
		for (const name of names) rendered.push(await renderSpecialist(opts, name, { resolved, modules }));
		const skippedNote = resolved.skipped?.length ? ` [skipped older: ${resolved.skipped.map((s) => `pi ${s.version} at ${s.root}`).join("; ")}]` : "";
		process.stderr.write(`render-specialist-prompt: pi ${resolved.version ?? "unknown"} (${resolved.origin}: ${resolved.root})${skippedNote}\n`);
		if (opts.all) {
			for (const r of rendered) {
				const firstLine = r.prompt.split("\n").find((l) => l.trim().length > 0) ?? "";
				process.stdout.write(`${r.specialist.padEnd(12)}| ${String(r.tools.length).padStart(2)} tools | ${String(r.charCount).padStart(6)} chars | skills:${r.skillsSectionPresent ? "yes" : "no "} | ${firstLine.slice(0, 60)}\n`);
			}
			return 0;
		}
		const r = rendered[0];
		if (opts.diff) {
			const captured = extractCaptureText(opts.diff, fs.readFileSync);
			if (captured === r.prompt) {
				process.stdout.write(`no differences: ${r.lineCount} lines / ${r.charCount} chars identical to ${path.basename(opts.diff)}\n`);
				return 0;
			}
			process.stdout.write(`${formatDiff(captured.split("\n"), r.prompt.split("\n"), `capture:${path.basename(opts.diff)}`, "script")}\n`);
			process.stderr.write(`render-specialist-prompt: prompt differs from capture (capture ${captured.length} chars, script ${r.prompt.length} chars)\n`);
			return 1;
		}
		if (opts.json) {
			const { prompt, ...meta } = r;
			process.stdout.write(`${JSON.stringify({ ...meta, prompt }, null, 2)}\n`);
			return 0;
		}
		process.stdout.write(r.prompt);
		return 0;
	} catch (err) {
		fail(err);
		if (err instanceof CaptureError) return 2;
		return 2;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			fail(err);
			process.exitCode = 2;
		},
	);
}
