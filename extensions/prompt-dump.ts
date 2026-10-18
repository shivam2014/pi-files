/**
 * Prompt Dump Extension
 *
 * Captures the EXACT request payload the provider receives, so the FORCED system prompt (returned
 * as `{ systemPrompt }` from `before_agent_start`) can be inspected. It is projected onto the
 * request only — the session JSONL stores pi's STRUCTURED BASE sections, so neither the session
 * file nor the extension source shows what the model gets. Hook: `before_provider_request`
 * (undocumented; wired as pi-ai's `onPayload`); its presence is asserted at load and logged loudly.
 * Writes: ${PI_PROMPT_DUMP_DIR:-/tmp/prompt-dump}/payload-<kind>-<ISO>-<n>.json — kind = orch
 * (system head has "You are an orchestrator") | sub; pruning keeps MAX_DUMP_FILES per kind, so a
 * burst of subagent captures can never evict orchestrator ones.  Command: /prompt-dump [on|off]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export const DEFAULT_DUMP_DIR = "/tmp/prompt-dump";
export const MAX_BASE64_CHARS = 2000;
export const MAX_DUMP_FILES = 10;
export const REDACTED = "<REDACTED>";
const FILE_PREFIX = "payload-";
const FILE_SUFFIX = ".json";
// ── Pure helpers (exported for tests) ──────────────────────────────────────
/** Kind label encoded in the dump filename, from the system head (task: kind decided by whether
 * the forced prompt contains `You are an orchestrator`). `undefined` = unknown (no getSystemPrompt). */
export type DumpKind = "orch" | "sub";
export function dumpKind(systemPrompt: string | null | undefined): DumpKind | undefined {
	if (typeof systemPrompt !== "string") return undefined;
	return systemPrompt.includes("You are an orchestrator") ? "orch" : "sub";
}
/** Parse the kind back out of a dump filename; legacy `payload-<ISO>-<n>.json` → undefined. */
export function parseDumpKind(fileName: string): DumpKind | undefined {
	const match = /^payload-(orch|sub)-/.exec(basename(fileName));
	return match ? (match[1] as DumpKind) : undefined;
}

export function resolveDumpDir(): string {
	const fromEnv = process.env.PI_PROMPT_DUMP_DIR;
	return fromEnv && fromEnv.trim().length > 0 ? fromEnv : DEFAULT_DUMP_DIR;
}

/** Replace base64-ish runs longer than `maxChars` with a readable marker. */
export function elideBase64(text: string, maxChars: number = MAX_BASE64_CHARS): string {
	if (!(maxChars > 0) || text.length <= maxChars) return text;
	// Base64 (incl. url-safe) runs: strictly longer than the limit is elided, exactly `maxChars` kept.
	const re = new RegExp(`[A-Za-z0-9+/_-]{${maxChars + 1},}={0,2}`, "g");
	return text.replace(re, (match) => `[base64 elided ${match.length} chars]`);
}

/** Scrub credentials from serialized JSON before it touches disk. */
export function redactSecrets(text: string): string {
	let out = text;
	// sk-… style keys
	out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, REDACTED);
	// Secret-bearing JSON / header fields: "x-api-key": "…", apiKey=…, authorization: Bearer …
	// (optional `Bearer ` scheme word is consumed with the value)
	out = out.replace(
		/(["']?(?:x-api-key|api[-_]?key|apikey|authorization|password|secret|auth[-_]?token|access[-_]?token)["']?\s*[:=]\s*)(["']?)(?:Bearer\s+)?([^"',\s}]{0,8192})\2/gi,
		(_m, head: string, quote: string) => `${head}${quote}${REDACTED}${quote}`,
	);
	// Standalone `Bearer <token>` with no recognisable field name in front of it
	out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{6,}=*/gi, `$1${REDACTED}`);
	return out;
}

export function safeStringify(value: unknown, indent = 2): string {
	try {
		const text = JSON.stringify(
			value,
			(_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "function" ? `[function ${v.name || "anonymous"}]` : v),
			indent,
		);
		return typeof text === "string" ? text : String(text);
	} catch (e) {
		return JSON.stringify({ serializationError: String(e), fallback: String(value) }, null, indent);
	}
}
/** Which shape the payload uses, so a reader knows where the system prompt lives. */
export function describePayloadShape(payload: unknown): { keys: string[]; systemPromptLocation: string | null } {
	if (!payload || typeof payload !== "object") return { keys: [], systemPromptLocation: null };
	const obj = payload as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (typeof obj.system === "string" || Array.isArray(obj.system)) return { keys, systemPromptLocation: "payload.system" };
	const messages = obj.messages;
	if (Array.isArray(messages) && messages.length > 0) {
		const first = messages[0] as Record<string, unknown> | null;
		if (first && typeof first === "object") {
			if (first.role === "system" || first.role === "developer") return { keys, systemPromptLocation: "payload.messages[0]" };
			if (typeof first.content === "string" && first.role === "user") return { keys, systemPromptLocation: "payload.messages[0] (no explicit system block)" };
		}
	}
	return { keys, systemPromptLocation: null };
}

function extractSessionId(ctx: unknown): string | null {
	const sm = (ctx as { sessionManager?: Record<string, unknown> } | null)?.sessionManager;
	if (!sm || typeof sm !== "object") return null;
	const direct = (sm as Record<string, unknown>).sessionId ?? (sm as Record<string, unknown>).id;
	if (typeof direct === "string" && direct.length > 0) return direct;
	for (const method of ["getSessionId", "getId", "getSessionFile", "getSessionPath"]) {
		const fn = (sm as Record<string, unknown>)[method];
		if (typeof fn !== "function") continue;
		try {
			const value = (fn as () => unknown).call(sm);
			if (typeof value === "string" && value.length > 0) return value;
		} catch {
			// best effort only
		}
	}
	return null;
}

function modelRefFromPayload(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const m = (payload as Record<string, unknown>).model;
	return typeof m === "string" && m.length > 0 ? m : null;
}

export interface DumpInput {
	payload: unknown;
	systemPrompt: string | null;
	cwd: string | null;
	sessionId: string | null;
	model: string | null;
	provider: string | null;
	capturedAt: string;
	hookSupported?: boolean;
}

/** Serialize the inspectable dump record (redacted + elided). */
export function buildDumpRecord(input: DumpInput): string {
	const record = {
		capturedAt: input.capturedAt,
		cwd: input.cwd,
		sessionId: input.sessionId,
		model: input.model ?? modelRefFromPayload(input.payload),
		provider: input.provider,
		hookSupported: input.hookSupported ?? null,
		systemPrompt: input.systemPrompt,
		systemPromptLength: input.systemPrompt ? input.systemPrompt.length : null,
		payloadShape: describePayloadShape(input.payload),
		payload: input.payload,
	};
	return redactSecrets(elideBase64(safeStringify(record)));
}

function safeMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
/** All dump files, oldest first. */
export function listDumps(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
			.map((f) => join(dir, f))
			.map((p) => ({ p, m: safeMtime(p) }))
			.sort((a, b) => a.m - b.m || a.p.localeCompare(b.p))
			.map((e) => e.p);
	} catch {
		return [];
	}
}

export function newestDump(dir: string): string | null {
	const all = listDumps(dir);
	return all.length > 0 ? all[all.length - 1] : null;
}

/** Keep only the newest `keep` dump files PER KIND. Kind comes from the filename (`payload-orch-…`
 * / `payload-sub-…`); files with no kind in the name (legacy dumps) form their own pool and keep the
 * whole-directory behaviour. Returns the removed paths. */
export function pruneDumps(dir: string, keep: number = MAX_DUMP_FILES): string[] {
	const groups = new Map<string, string[]>();
	for (const path of listDumps(dir)) {
		const kind = parseDumpKind(path) ?? "";
		const group = groups.get(kind) ?? [];
		group.push(path);
		groups.set(kind, group);
	}
	const removed: string[] = [];
	for (const group of groups.values()) {
		for (const path of group.slice(0, Math.max(0, group.length - keep))) {
			try {
				rmSync(path);
				removed.push(path);
			} catch {
				// ignore — pruning must never break capture
			}
		}
	}
	return removed;
}

export interface CaptureResult {
	ok: boolean;
	file?: string;
	removed?: string[];
	error?: string;
}

let writeSequence = 0;
function nextDumpPath(dir: string, capturedAt: string, kind?: DumpKind): string {
	const stamp = capturedAt.replace(/[:.]/g, "-");
	const base = `${FILE_PREFIX}${kind ? `${kind}-` : ""}${stamp}`;
	for (let i = 0; i < 50; i += 1) {
		const candidate = join(dir, `${base}-${writeSequence + i}${FILE_SUFFIX}`);
		if (!existsSync(candidate)) {
			writeSequence += i + 1;
			return candidate;
		}
	}
	writeSequence += 50;
	return join(dir, `${base}-${writeSequence}${FILE_SUFFIX}`);
}
export interface CaptureOptions {
	dir?: string;
	keep?: number;
	capturedAt?: string;
	hookSupported?: boolean;
}

/** Never throws: returns { ok: false, error } on any failure. */
export function captureRequest(event: { payload?: unknown }, ctx: unknown, options: CaptureOptions = {}): CaptureResult {
	try {
		const dir = options.dir ?? resolveDumpDir();
		const keep = options.keep ?? MAX_DUMP_FILES;
		const capturedAt = options.capturedAt ?? new Date().toISOString();
		const c = (ctx ?? {}) as { getSystemPrompt?: () => string; cwd?: string; model?: Record<string, unknown> };
		let systemPrompt: string | null = null;
		try {
			if (typeof c.getSystemPrompt === "function") systemPrompt = c.getSystemPrompt();
		} catch {
			systemPrompt = null;
		}
		const model = c.model && typeof c.model === "object" ? ((c.model.id ?? c.model.modelId ?? c.model.name) as string | undefined) ?? null : null;
		const provider = c.model && typeof c.model === "object" ? ((c.model.provider as string | undefined) ?? null) : null;
		let text = buildDumpRecord({
			payload: event?.payload,
			systemPrompt,
			cwd: typeof c.cwd === "string" ? c.cwd : null,
			sessionId: extractSessionId(ctx),
			model,
			provider,
			capturedAt,
			hookSupported: options.hookSupported,
		});
		mkdirSync(dir, { recursive: true });
		const file = nextDumpPath(dir, capturedAt, dumpKind(systemPrompt));
		writeFileSync(file, text, "utf-8");
		return { ok: true, file, removed: pruneDumps(dir, keep) };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
// ── Hook presence assertion ────────────────────────────────────────────────
export interface HookSupport {
	checked: boolean;
	supported: boolean;
	detail: string;
}

/** npm `exports` maps here have no "." entry, so walk node_modules manually. */
function findPiPackageDirs(): string[] {
	const dirs: string[] = [];
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i += 1) {
		dirs.push(join(dir, "node_modules", "@earendil-works", "pi-coding-agent"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function pickEntry(exportsField: unknown): string | null {
	const root = exportsField && typeof exportsField === "object" ? ((exportsField as Record<string, unknown>)["."] ?? exportsField) : exportsField;
	if (typeof root === "string") return root;
	if (root && typeof root === "object") {
		for (const key of ["import", "require", "default", "types"]) {
			const value = (root as Record<string, unknown>)[key];
			if (typeof value === "string") return value;
		}
	}
	return null;
}

function resolveDistDir(pkgDir: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as { main?: string; exports?: unknown };
		return dirname(join(pkgDir, pickEntry(pkg.exports) ?? pkg.main ?? "dist/index.js"));
	} catch {
		return join(pkgDir, "dist");
	}
}

/** Assert `before_provider_request` exists in the installed pi build. */
export function detectHookSupport(): HookSupport {
	try {
		for (const pkgDir of findPiPackageDirs()) {
			if (!existsSync(pkgDir)) continue;
			const dist = resolveDistDir(pkgDir);
			const candidates = [
				join(dist, "core", "extensions", "runner.js"),
				join(dist, "core", "extensions", "runner.cjs"),
				join(dist, "core", "extensions", "types.d.ts"),
				join(dist, "index.js"),
			];
			for (const candidate of candidates) {
				if (!existsSync(candidate)) continue;
				const text = readFileSync(candidate, "utf-8");
				return { checked: true, supported: text.includes("before_provider_request"), detail: candidate };
			}
			return { checked: false, supported: false, detail: `no hook-bearing file under ${dist}` };
		}
		return { checked: false, supported: false, detail: "installed pi package not found" };
	} catch (e) {
		return { checked: false, supported: false, detail: e instanceof Error ? e.message : String(e) };
	}
}
// ── Extension ──────────────────────────────────────────────────────────────
let loggedWriteError = false;
export function __resetStateForTests(): void {
	loggedWriteError = false;
	writeSequence = 0;
}
export default function (pi: ExtensionAPI): void {
	let enabled = process.env.PI_PROMPT_DUMP_OFF !== "1";

	const hook = detectHookSupport();
	if (hook.checked && !hook.supported) {
		console.error(`[prompt-dump] WARNING: hook "before_provider_request" NOT FOUND in ${hook.detail} — capture will not fire.`);
	} else if (!hook.checked) {
		console.error(`[prompt-dump] WARNING: could not verify hook "before_provider_request" (${hook.detail}) — capture may not fire.`);
	}

	pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
		if (!enabled) return undefined;
		try {
			const result = captureRequest(event, ctx, { hookSupported: hook.supported });
			if (!result.ok && !loggedWriteError) {
				loggedWriteError = true;
				console.error(`[prompt-dump] capture failed (logged once): ${result.error}`);
			}
		} catch (e) {
			if (!loggedWriteError) {
				loggedWriteError = true;
				console.error("[prompt-dump] capture threw (logged once):", e);
			}
		}
		// Return nothing so the payload passes through unchanged.
		return undefined;
	});

	pi.registerCommand("prompt-dump", {
		description: "Show prompt-dump capture directory / toggle capture (on|off)",
		handler: async (args: string, ctx: unknown) => {
			const dir = resolveDumpDir();
			const newest = newestDump(dir);
			const trimmed = (args ?? "").trim().toLowerCase();
			const notify = (msg: string, type: string): void => {
				try {
					(ctx as { ui?: { notify?: (m: string, t: string) => void } })?.ui?.notify?.(msg, type);
				} catch {
					// UI unavailable (print/json mode) — message still logged below
				}
				if (!(ctx as { hasUI?: boolean })?.hasUI) console.log(msg);
			};

			if (trimmed === "off") {
				enabled = false;
				notify("prompt-dump: capture OFF", "info");
				return;
			}
			if (trimmed === "on") {
				enabled = true;
				notify(`prompt-dump: capture ON → ${dir}`, "info");
				return;
			}
			const count = listDumps(dir).length;
			notify(
				[
					`prompt-dump: capture ${enabled ? "ON" : "OFF"}`,
					`dir: ${dir}`,
					`newest: ${newest ?? "(no dumps yet)"}`,
					`files: ${count}`,
					hook.checked && !hook.supported
						? `hook: MISSING in ${hook.detail}`
						: `hook: ${hook.checked ? "verified" : `unverified (${hook.detail})`}`,
				].join("\n"),
				"info",
			);
		},
	});
}
