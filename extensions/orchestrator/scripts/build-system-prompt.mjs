#!/usr/bin/env node
// @ts-nocheck — plain-JS CLI script (no type declarations); behaviour is covered by
// build-system-prompt.test.ts. tsc picks this file up through the test import.
/**
 * build-system-prompt.mjs — render the orchestrator extension's system prompt for a cwd, offline,
 * through real code paths: base = pi SDK idle session systemPrompt + bindExtensions (session_start,
 * resources_discover); transform = the live extension chain (the DEFAULT — byte-for-byte what the
 * provider receives) or, with --no-chain, buildOrchestratorPrompt() from ../prompt-builder.ts
 * (esbuild bundle in a temp dir) — this extension's own composition, without other extensions'
 * rewrites.
 * pi-root order: --pi-root → PROMPT_SIM_PI_ROOT → `pi` on PATH → .hermes global → extensions
 * node_modules. A pi older than MIN_PI_VERSION (1.3.0) is skipped (or aborts when forced/all-old)
 * unless --allow-old-pi — 0.80.3 rendered 38,655 chars vs the live 27,494.
 * Env hooks (tests): PROMPT_SIM_PI_ROOT, PROMPT_SIM_NO_SDK=1, PROMPT_SIM_NO_EXT=1, PI_AGENT_DIR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CaptureError, extractCaptureText, formatDiff } from "./unified-diff.mjs";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(SCRIPT_DIR, "..");
const PI_SPEC = "@earendil-works/pi-coding-agent";
export const MIN_PI_VERSION = "1.3.0";
const USAGE = `Usage: node scripts/build-system-prompt.mjs [--cwd DIR] [--json] [--base-only] [--skills] [--no-chain] [--diff CAPTURE.json] [--pi-root DIR] [--allow-old-pi]\n  --cwd DIR       render for DIR (default: process.cwd())\n  --json          emit { mode, cwd, piVersion, charCount, lineCount, systemPrompt, baseCharCount, source }\n  --base-only     print only pi's base prompt (starts "You are an expert coding assistant")\n  --skills        print the discovered skill names (one per line), the input the transform receives\n  --no-chain      print only this extension's own composition (buildOrchestratorPrompt) — NOT the live text\n  --chain         the default: full extension-chain result from the idle session (live-run equivalent);\n                  accepted explicitly as a no-op alias\n  --diff FILE     unified diff vs a prompt-dump capture's systemPrompt; exit 1 if they differ\n  --pi-root DIR   render from this pi install (must be ${PI_SPEC})\n  --allow-old-pi  permit rendering from a pi older than ${MIN_PI_VERSION} (blocks by default)\n`;
export class ResolutionError extends Error {}
export function parseArgs(argv) {
	// chain is the DEFAULT: the chain render is the text the provider actually receives. --no-chain
	// opts back into the extension-only composition; --chain stays an accepted no-op alias so existing
	// invocations (the committed gate) keep working unchanged.
	const opts = { cwd: process.cwd(), json: false, baseOnly: false, skillsOnly: false, chain: true, diff: null, piRoot: null, allowOldPi: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = (flag) => {
			const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
			if (!v) throw new ResolutionError(`${flag} requires a value`);
			return v;
		};
		if (a === "--cwd" || a.startsWith("--cwd=")) opts.cwd = path.resolve(val("--cwd"));
		else if (a === "--json") opts.json = true;
		else if (a === "--base-only") opts.baseOnly = true;
		else if (a === "--skills") opts.skillsOnly = true;
		else if (a === "--chain") opts.chain = true;
		else if (a === "--no-chain") opts.chain = false;
		else if (a === "--diff" || a.startsWith("--diff=")) opts.diff = path.resolve(val("--diff"));
		else if (a === "--pi-root" || a.startsWith("--pi-root=")) opts.piRoot = path.resolve(val("--pi-root"));
		else if (a === "--allow-old-pi") opts.allowOldPi = true;
		else if (a === "--help" || a === "-h") opts.help = true;
		else throw new ResolutionError(`unknown argument: ${a}`);
	}
	return opts;
}

export const agentDir = () => process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const attempt = (fn, fallback = null) => {
	try {
		return fn();
	} catch {
		return fallback;
	}
};const isPiRoot = (dir) => Boolean(dir) && attempt(() => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === PI_SPEC, false);
export const readPiVersion = (root) => attempt(() => {
	const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	return typeof version === "string" ? version : null;
});
/** Numeric dotted compare; missing segments count as 0. */
export function compareVersions(a, b) {
	const pa = String(a ?? "").split(".").map((n) => parseInt(n, 10) || 0);
	const pb = String(b ?? "").split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}
/** Walk up from the `pi` executable's real path to its package root (pi bin: dist/bundle/cli.js). */
function piRootFromExecutable() {
	const bin = attempt(() => execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), "");
	if (!bin) return null;
	return attempt(() => {
		let dir = path.dirname(fs.realpathSync(bin));
		for (let i = 0; i < 10; i++) {
			if (isPiRoot(dir)) return dir;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return null;
	});
}
/** Resolve the pi install to render from: --pi-root → PROMPT_SIM_PI_ROOT → `pi` on PATH → hermes
 * global → extension-local node_modules (usually stale). Returns { root, version, origin, skipped }. */
export function resolvePi(opts = {}) {
	const rel = PI_SPEC.split("/");
	const forced = [];
	if (opts.piRoot) forced.push({ root: path.resolve(opts.piRoot), origin: "--pi-root" });
	if (process.env.PROMPT_SIM_PI_ROOT) forced.push({ root: process.env.PROMPT_SIM_PI_ROOT, origin: "PROMPT_SIM_PI_ROOT" });
	for (const c of forced) {
		if (!isPiRoot(c.root)) throw new ResolutionError(`${c.origin}=${c.root} is not a ${PI_SPEC} package directory`);
		const version = readPiVersion(c.root);
		if (!opts.allowOldPi && !(version && compareVersions(version, MIN_PI_VERSION) >= 0)) throw tooOldError([{ ...c, version }]);
		return { root: c.root, version, origin: c.origin, skipped: [] };
	}
	const candidates = [
		{ root: piRootFromExecutable(), origin: "pi executable on PATH" },
		{ root: path.join(os.homedir(), ".hermes", "node", "lib", "node_modules", ...rel), origin: "hermes global install" },
		{ root: path.join(EXT_DIR, "node_modules", ...rel), origin: "extension node_modules" },
		{ root: path.join(EXT_DIR, "..", "node_modules", ...rel), origin: "extensions parent node_modules" },
		{ root: path.join(agentDir(), "npm", "node_modules", ...rel), origin: "agent npm dir" },
		{ root: path.join(agentDir(), "node_modules", ...rel), origin: "agent node_modules" },
	].filter((c) => c.root);
	const skipped = [];
	for (const c of candidates) {
		if (!isPiRoot(c.root) || skipped.some((s) => s.root === c.root)) continue;
		const version = readPiVersion(c.root);
		if (opts.allowOldPi || (version && compareVersions(version, MIN_PI_VERSION) >= 0)) return { root: c.root, version, origin: c.origin, skipped };
		skipped.push({ ...c, version });
	}
	if (skipped.length) throw tooOldError(skipped);
	throw new ResolutionError(`cannot locate ${PI_SPEC}; tried:\n  ${candidates.map((c) => c.root).join("\n  ")}`);
}

function tooOldError(rejected) {
	const running = piRootFromExecutable();
	const runningLabel = running && !rejected.some((r) => r.root === running) ? `${running} (pi ${readPiVersion(running) ?? "unknown"})` : "no newer pi found on PATH";
	return new ResolutionError(
		`${rejected.map((r) => `pi ${r.version ?? "unknown"} at ${r.root} (${r.origin})`).join("; ")} — older than the supported minimum ${MIN_PI_VERSION}; ` +
			`the running pi resolves to ${runningLabel}. Refusing to render from an older build — pass --allow-old-pi to override.`,
	);
}
/** Create an idle AgentSession against one pi install, crossing API vintages: legacy (<1.3) takes
 * { sessionManager, authStorage, modelRegistry, additionalExtensionPaths }; modern (>=1.3, no
 * AuthStorage) takes extensions through a DefaultResourceLoader (resource-loader.js:258 —
 * createAgentSession itself does not take additionalExtensionPaths, sdk.js:69-120). */
async function createIdleSession(pi, cwd, loadExtension) {
	if (typeof pi.AuthStorage?.create === "function") {
		const authStorage = pi.AuthStorage.create();
		return pi.createAgentSession({ sessionManager: pi.SessionManager.inMemory(), authStorage, modelRegistry: pi.ModelRegistry.create(authStorage), cwd, ...(loadExtension ? { additionalExtensionPaths: [path.join(EXT_DIR, "index.ts")] } : {}) });
	}
	const options = { sessionManager: pi.SessionManager.inMemory(), cwd, agentDir: agentDir() };
	if (typeof pi.DefaultResourceLoader === "function") {
		const loader = new pi.DefaultResourceLoader(loadExtension ? { cwd, agentDir: agentDir(), additionalExtensionPaths: [path.join(EXT_DIR, "index.ts")] } : { cwd, agentDir: agentDir(), noExtensions: true });
		await loader.reload();
		options.resourceLoader = loader;
	}
	return pi.createAgentSession(options);
}
/** Swallow library chatter (extension banners) while a real code path loads. */
export function muteStreams() {
	const out = process.stdout.write.bind(process.stdout);
	const err = process.stderr.write.bind(process.stderr);
	process.stdout.write = () => true;
	process.stderr.write = () => true;
	return () => {
		process.stdout.write = out;
		process.stderr.write = err;
	};
}
const loadPiIndex = (piRoot) => import(pathToFileURL(path.join(piRoot, "dist", "index.js")).href);
/** Fallback when the SDK cannot build an idle session: buildSystemPrompt() with the same option set
 * agent-session.js builds (skills/contextFiles/customPrompt/appendSystemPrompt from pi's
 * DefaultResourceLoader for the same cwd+agentDir; tool snippets/guidelines need a live registry). */
async function buildBaseDirectly(piRoot, cwd) {
	const pi = await loadPiIndex(piRoot);
	const { buildSystemPrompt } = await import(pathToFileURL(path.join(piRoot, "dist", "core", "system-prompt.js")).href);
	if (typeof buildSystemPrompt !== "function") throw new ResolutionError("pi core/system-prompt.js exports no buildSystemPrompt");
	const loader = new pi.DefaultResourceLoader({ cwd, agentDir: agentDir() });
	const skills = (loader.getSkills?.().skills ?? []).filter((s) => s && typeof s.name === "string");
	const appendSystemPrompt = loader.getAppendSystemPrompt?.() ?? [];
	const text = buildSystemPrompt({ cwd, skills, contextFiles: loader.getAgentsFiles?.().agentsFiles ?? [], customPrompt: loader.getSystemPrompt?.(), appendSystemPrompt: appendSystemPrompt.length ? appendSystemPrompt.join("\n\n") : undefined, selectedTools: [], toolSnippets: {}, promptGuidelines: [] });
	if (typeof text !== "string" || !text.length) throw new ResolutionError("pi buildSystemPrompt() returned an empty prompt");
	return { text, skills };
}

async function getBasePrompt(piRoot, cwd) {
	if (process.env.PROMPT_SIM_NO_SDK !== "1") {
		const withExtension = process.env.PROMPT_SIM_NO_EXT !== "1";
		for (const loadExtension of withExtension ? [true, false] : [false]) {
			try {
				const pi = await loadPiIndex(piRoot);
				const restore = muteStreams();
				let result;
				try {
					result = await createIdleSession(pi, cwd, loadExtension);
				} finally {
					restore();
				}
				const session = result?.session;
				// pi >= 1.3 boots a session through bindExtensions: it emits session_start (the orchestrator
				// freezes its tool set there, index.ts:125-137) and runs resources_discover → extendResources
				// → _rebuildSystemPrompt with the skill set (agent-session.js:2649-2653, 2672-2692). Without
				// it the idle prompt is the pre-session_start one. Older builds lack the method — best effort.
				try {
					await session?.bindExtensions?.({});
				} catch {
					/* keep the pre-bind prompt rather than failing the whole render */
				}
				const text = session?.systemPrompt;
				if (typeof text === "string" && text.length) {
					const options = session._baseSystemPromptOptions ?? {};
					const via = loadExtension ? "pi-sdk:idle-session+orchestrator-ext" : "pi-sdk:idle-session";
					return { text, skills: Array.isArray(options.skills) ? options.skills : [], source: `${via}@${path.join(piRoot, "dist")}`, session: loadExtension ? session : undefined, options };
				}
			} catch {
				/* try the next source, finally the direct buildSystemPrompt path */
			}
		}
	}
	return { ...(await buildBaseDirectly(piRoot, cwd)), source: `pi:buildSystemPrompt@${path.join(piRoot, "dist")}` };
}
const NAMESPACES = { "prompt-builder": "promptBuilder", specialists: "specialists", "fusion-tool": "fusionTool", "registration-hub": "registrationHub" };
const TOOL_MODULES = ["prompt-builder", "specialists", "fusion-tool", "registration-hub"];
/** Bundle the extension's TS modules with esbuild (full graph first; degrade only if unbundleable).
 * Returns { modules, level }. */
export async function loadExtensionModules(piRoot) {
	let esbuildEntry;
	try {
		esbuildEntry = createRequire(path.join(EXT_DIR, "package.json")).resolve("esbuild");
	} catch {
		throw new ResolutionError(`esbuild is not installed next to ${EXT_DIR}; cannot load prompt-builder.ts`);
	}
	const esbuildMod = await import(pathToFileURL(esbuildEntry).href);
	const build = esbuildMod.build ?? esbuildMod.default?.build;
	if (typeof build !== "function") throw new ResolutionError("esbuild module exposes no build()");
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-prompt-sim-"));
	const nodePaths = [path.join(EXT_DIR, "node_modules"), path.join(EXT_DIR, "..", "node_modules"), path.join(agentDir(), "npm", "node_modules")];
	const levels = [TOOL_MODULES, TOOL_MODULES.slice(0, 3), TOOL_MODULES.slice(0, 2)];
	let lastError;
	for (const level of levels) {
		const entryFile = path.join(outDir, "entry.ts");
		fs.writeFileSync(entryFile, level.map((n) => `export * as ${NAMESPACES[n]} from ${JSON.stringify(path.join(EXT_DIR, `${n}.ts`))};`).join("\n") + "\n");
		const outfile = path.join(outDir, "bundle.mjs");
		try {
			const restore = muteStreams();
			try {
				await build({ entryPoints: [entryFile], absWorkingDir: EXT_DIR, bundle: true, format: "esm", platform: "node", target: "node22", outfile, logLevel: "silent", external: [PI_SPEC], nodePaths });
			} finally {
				restore();
			}
			const scopeDir = path.join(outDir, "node_modules", "@earendil-works");
			fs.mkdirSync(scopeDir, { recursive: true });
			const link = path.join(scopeDir, "pi-coding-agent");
			if (!fs.existsSync(link)) fs.symlinkSync(piRoot, link, "dir");
			process.on("exit", () => attempt(() => fs.rmSync(outDir, { recursive: true, force: true })));
			return { modules: await import(pathToFileURL(outfile).href), level: level.join("+") };
		} catch (err) {
			lastError = err;
		}
	}
	throw new ResolutionError(`cannot load ${path.join(EXT_DIR, "prompt-builder.ts")} through esbuild: ${lastError?.message ?? lastError}`);
}

/** index.ts:171-186 registers `<agentDir>/skills/<skill>/SKILL.md` for every SPECIALISTS[*]
 * .suggestedSkills entry via resources_discover; pi loads those and hands the union to
 * before_agent_start as systemPromptOptions.skills (index.ts:161). Add any skill the idle session missed. */
export function mergeSkills(piSkills, modules) {
	const skills = piSkills.filter((s) => s && typeof s.name === "string").map((s) => ({ name: s.name, description: s.description }));
	const have = new Set(skills.map((s) => s.name));
	const extra = [];
	const skillsDir = path.join(agentDir(), "skills");
	// esbuild bundles each module under a namespace (NAMESPACES above); accept the flat shape too.
	const SPECIALISTS = modules?.specialists?.SPECIALISTS ?? modules?.SPECIALISTS ?? {};
	for (const spec of Object.values(SPECIALISTS)) {
		for (const name of spec?.suggestedSkills ?? []) {
			if (!have.has(name) && fs.existsSync(path.join(skillsDir, name, "SKILL.md"))) {
				skills.push({ name });
				have.add(name);
				extra.push(name);
			}
		}
	}
	return { skills, extra };
}

/** Stub ExtensionAPI so the real tool registry can be rebuilt. */
export function makeStubPi(modules, cwd) {
	const tools = [];
	const known = {
		registerTool: (tool) => tools.push(tool), getAllTools: () => tools, getToolDefinition: () => undefined,
		on: () => () => {}, registerCommand: () => {}, registerShortcut: () => {}, registerProvider: () => {},
		getAgentDir: () => agentDir(), setActiveTools: () => {}, log: () => {},
	};
	const api = new Proxy(known, { get: (t, k) => (k in t ? t[k] : () => {}) });
	try {
		// Bundled namespaces: registration-hub exports registerAllTools (registration-hub.ts:84).
		const registerAllTools = modules?.registrationHub?.registerAllTools ?? modules?.registerAllTools;
		registerAllTools?.(api, cwd);
	} catch {
		/* partial registry is fine: generateToolDocumentation filters by name */
	}
	return api;
}

export const readFusionEnabled = (modules, cwd) => attempt(() => Boolean(modules?.loadFusionConfig?.(cwd)?.enabled), false);

export async function render(opts) {
	const resolved = resolvePi(opts);
	const piRoot = resolved.root;
	const loaded = await loadExtensionModules(piRoot);
	const modules = loaded.modules;
	const base = await getBasePrompt(piRoot, opts.cwd);
	const { skills, extra } = mergeSkills(base.skills, modules);
	const meta = { base, skills, extraSkills: extra, source: base.source, bundleLevel: loaded.level, piVersion: resolved.version, piRoot, piOrigin: resolved.origin, skippedPi: resolved.skipped ?? [] };
	if (opts.baseOnly) return { ...meta, mode: "base", text: base.text };
	const checkOrchestrator = (candidate, origin) => {
		if (typeof candidate !== "string" || !(candidate.includes("You are an orchestrator") || candidate.includes("## Orchestrator Mode"))) {
			throw new ResolutionError(`${origin} produced no orchestrator prompt — refusing to print the base prompt as the final prompt`);
		}
		return candidate;
	};
	if (opts.chain) {
		const runner = base.session?._extensionRunner;
		if (!runner?.emitBeforeAgentStart) throw new ResolutionError("the chain render (the default) needs the extension-loaded idle session (do not set PROMPT_SIM_NO_EXT/PROMPT_SIM_NO_SDK)");
		let chainText;
		try {
			if (runner.emitBeforeAgentStart.length >= 2) {
				// pi >= 1.3 (runner.js:1121): (trigger, systemPromptOptions) → { messages, systemPromptOptions }.
				// The forced prompt lands in systemPromptOptions.forceSystemPrompt (runner.js:1149-1151);
				// buildSystemPrompt() returns it verbatim (system-prompt.js:132-134) — the same text
				// ctx.getSystemPrompt() reports to prompt-dump.
				const result = await runner.emitBeforeAgentStart({ messageType: "print" }, base.options);
				const { buildSystemPrompt } = await import(pathToFileURL(path.join(piRoot, "dist", "core", "system-prompt.js")).href);
				chainText = buildSystemPrompt(result?.systemPromptOptions ?? base.options);
			} else {
				// pi < 1.3: emitBeforeAgentStart(trigger, messages, systemPrompt, options) → string | { systemPrompt }
				const chainResult = await runner.emitBeforeAgentStart("", [], base.text, base.options);
				chainText = typeof chainResult === "string" ? chainResult : chainResult?.systemPrompt;
			}
		} catch (err) {
			throw new ResolutionError(`extension chain failed: ${err?.message ?? err}`);
		}
		return { ...meta, mode: "chain", text: checkOrchestrator(chainText, "extension chain (emitBeforeAgentStart)") };
	}
	let text;
	try {
		text = modules.promptBuilder.buildOrchestratorPrompt({ basePrompt: base.text, skills, fusionEnabled: readFusionEnabled(modules, opts.cwd), pi: makeStubPi(modules, opts.cwd) }).systemPrompt;
	} catch (err) {
		throw new ResolutionError(`buildOrchestratorPrompt() failed: ${err?.message ?? err}`);
	}
	return { ...meta, mode: "compose", text: checkOrchestrator(text, "buildOrchestratorPrompt()") };
}
function runDiff(file, text) {
	const captured = extractCaptureText(file, fs.readFileSync);
	if (captured === text) {
		process.stdout.write(`no differences: ${captured.split("\n").length} lines / ${captured.length} chars identical to ${path.basename(file)}\n`);
		return 0;
	}
	process.stdout.write(`${formatDiff(captured.split("\n"), text.split("\n"), `capture:${path.basename(file)}`, "script")}\n`);
	process.stderr.write(`build-system-prompt: prompt differs from capture (capture ${captured.length} chars, script ${text.length} chars)\n`);
	return 1;
}
const fail = (err) => process.stderr.write(`build-system-prompt: ${err instanceof Error ? err.message : String(err)}\n`);
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
	let rendered;
	try {
		rendered = await render(opts);
	} catch (err) {
		fail(err);
		return 2;
	}
	if (opts.skillsOnly) {
		process.stdout.write(rendered.skills.map((s) => s.name).sort().join("\n") + "\n");
		return 0;
	}
	if (opts.json) {
		const record = { mode: rendered.mode, cwd: opts.cwd, piVersion: rendered.piVersion, charCount: rendered.text.length, lineCount: rendered.text.split("\n").length, systemPrompt: rendered.text, baseCharCount: rendered.base.text.length, source: rendered.source };
		process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
		return 0;
	}
	const skippedNote = rendered.skippedPi?.length ? ` [skipped older: ${rendered.skippedPi.map((s) => `pi ${s.version} at ${s.root}`).join("; ")}]` : "";
	process.stderr.write(`build-system-prompt: pi ${rendered.piVersion ?? "unknown"} (${rendered.piOrigin}: ${rendered.piRoot})${skippedNote}\n`);
	if (opts.diff) {
		if (!opts.chain) process.stderr.write("build-system-prompt: --diff with --no-chain compares this extension's own composition, not the live text — drop --no-chain to diff what the provider receives\n");
		try {
			return runDiff(opts.diff, rendered.text);
		} catch (err) {
			if (!(err instanceof CaptureError)) throw err;
			fail(err);
			return 2;
		}
	}
	process.stdout.write(rendered.text);
	return 0;
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