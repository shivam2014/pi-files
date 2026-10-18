/**
 * Tests for ../prompt-dump.ts
 *
 * Lives in orchestrator/ (not the extensions root) because pi's extension loader
 * auto-loads every top-level `*.ts` in ~/.pi/agent/extensions and would try to
 * boot this vitest file as an extension. Subdirectories are not auto-loaded —
 * same convention as the sibling orchestrator suites.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptDump, {
	REDACTED,
	__resetStateForTests,
	buildDumpRecord,
	captureRequest,
	describePayloadShape,
	detectHookSupport,
	dumpKind,
	elideBase64,
	listDumps,
	newestDump,
	parseDumpKind,
	pruneDumps,
	redactSecrets,
} from "../prompt-dump.ts";

const NEWEST_BASE64 = "A".repeat(2001);
let dirs: string[] = [];
let savedEnv: string | undefined;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prompt-dump-test-"));
	dirs.push(dir);
	return dir;
}

function writeDumpFile(dir: string, index: number, seconds: number): string {
	const path = join(dir, `payload-2026-01-01T00-00-00-000Z-${index}.json`);
	writeFileSync(path, "{}", "utf-8");
	const date = new Date(seconds * 1000);
	utimesSync(path, date, date);
	return path;
}

interface FakePi {
	api: any;
	handlers: Record<string, Array<(...args: any[]) => any>>;
	commands: Map<string, any>;
	trigger: (event: string, ...args: any[]) => any[];
}

function makePi(): FakePi {
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const commands = new Map<string, any>();
	const api = {
		on: (event: string, handler: (...args: any[]) => any) => {
			handlers[event] = handlers[event] ?? [];
			handlers[event].push(handler);
		},
		registerCommand: (name: string, spec: any) => {
			commands.set(name, spec);
		},
	};
	const trigger = (event: string, ...args: any[]) => (handlers[event] ?? []).map((h) => h(...args));
	return { api, handlers, commands, trigger };
}

function ctxFor(prompt: string): any {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSystemPrompt: () => prompt,
		sessionManager: { sessionId: "sess-test-1" },
		model: { id: "claude-sonnet-4-5", provider: "anthropic" },
	};
}

beforeEach(() => {
	savedEnv = process.env.PI_PROMPT_DUMP_DIR;
	delete process.env.PI_PROMPT_DUMP_OFF;
	__resetStateForTests();
});

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
	if (savedEnv === undefined) delete process.env.PI_PROMPT_DUMP_DIR;
	else process.env.PI_PROMPT_DUMP_DIR = savedEnv;
	vi.restoreAllMocks();
});

describe("redactSecrets", () => {
	it("redacts sk- style keys", () => {
		const out = redactSecrets('{"apiKey":"sk-live-abcdef123456"}');
		expect(out).toContain(REDACTED);
		expect(out).not.toContain("sk-live-abcdef123456");
	});

	it("redacts Bearer tokens (header and JSON forms)", () => {
		const header = redactSecrets("authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
		expect(header).toBe(`authorization: ${REDACTED}`);
		expect(header).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
		const json = redactSecrets('{"Authorization":"Bearer abcdef123456"}');
		expect(json).toBe(`{"Authorization":"${REDACTED}"}`);
		expect(json).not.toContain("abcdef123456");
		// no recognisable field name in front of the scheme word
		const bare = redactSecrets('{"some-header":"Bearer eyJhbGciOiJIUzI1NiJ9"}');
		expect(bare).toContain(`Bearer ${REDACTED}`);
		expect(bare).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	});

	it("redacts x-api-key, apiKey and authorization values, leaving the keys intact", () => {
		const out = redactSecrets('{"x-api-key":"xyz-secret-value","api_key":"another-secret","authorization":"tok_123"}');
		expect(out).toContain('"x-api-key":"<REDACTED>"');
		expect(out).toContain('"api_key":"<REDACTED>"');
		expect(out).toContain('"authorization":"<REDACTED>"');
		expect(out).not.toContain("xyz-secret-value");
		expect(out).not.toContain("another-secret");
		expect(out).not.toContain("tok_123");
	});

	it("is idempotent and leaves non-secret content untouched", () => {
		const clean = '{"model":"gpt-4","prompt":"hello world"}';
		expect(redactSecrets(clean)).toBe(clean);
		expect(redactSecrets(redactSecrets('{"apiKey":"sk-abcdefghijk"}'))).toContain(REDACTED);
	});
});

describe("elideBase64 (2000-char boundary)", () => {
	it("keeps a run of exactly 2000 chars", () => {
		expect(elideBase64(NEWEST_BASE64.slice(0, 2000))).toBe("A".repeat(2000));
	});

	it("elides a run of 2001 chars with a marker", () => {
		expect(elideBase64(NEWEST_BASE64)).toBe("[base64 elided 2001 chars]");
	});

	it("elides a data-URI image blob but preserves the prefix", () => {
		const out = elideBase64(`{"url":"data:image/png;base64,${"B".repeat(4000)}"}`);
		expect(out).toContain("data:image/png;base64,[base64 elided 4000 chars]");
		expect(out.length).toBeLessThan(200);
	});

	it("leaves short strings and prose untouched", () => {
		const prose = "Specialist roster: implement, tdd, code-review\n".repeat(20);
		expect(elideBase64(prose)).toBe(prose);
	});
});

describe("pruneDumps", () => {
	it("keeps the newest 10 and removes the rest", () => {
		const dir = tempDir();
		const paths = Array.from({ length: 13 }, (_, i) => writeDumpFile(dir, i, 1_700_000_000 + i));
		const removed = pruneDumps(dir, 10);
		expect(removed).toHaveLength(3);
		expect(removed).toEqual(paths.slice(0, 3));
		const remaining = listDumps(dir);
		expect(remaining).toHaveLength(10);
		expect(remaining).toEqual(paths.slice(3));
		expect(existsSync(paths[0])).toBe(false);
		expect(existsSync(paths[12])).toBe(true);
	});

	it("is a no-op under the limit and tolerates a missing directory", () => {
		const dir = tempDir();
		writeDumpFile(dir, 0, 1_700_000_000);
		expect(pruneDumps(dir, 10)).toEqual([]);
		expect(pruneDumps(join(dir, "nope"), 10)).toEqual([]);
		expect(newestDump(join(dir, "nope"))).toBeNull();
	});
});

describe("per-kind dumps (orch vs sub)", () => {
	function writeKindDump(dir: string, kind: "orch" | "sub", index: number, seconds: number): string {
		const path = join(dir, `payload-${kind}-2026-01-01T00-00-00-000Z-${index}.json`);
		writeFileSync(path, "{}", "utf-8");
		const date = new Date(seconds * 1000);
		utimesSync(path, date, date);
		return path;
	}

	it("dumpKind decides from the system head; null/unavailable → undefined", () => {
		expect(dumpKind("You are an orchestrator. Delegate only.\n...")).toBe("orch");
		expect(dumpKind("You are an implementation specialist.")).toBe("sub");
		expect(dumpKind(null)).toBeUndefined();
		expect(dumpKind(undefined)).toBeUndefined();
	});

	it("parseDumpKind reads the filename; legacy names are undefined", () => {
		expect(parseDumpKind("/tmp/x/payload-orch-2026-01-01T00-00-00-000Z-1.json")).toBe("orch");
		expect(parseDumpKind("payload-sub-2026-01-01T00-00-00-000Z-1.json")).toBe("sub");
		expect(parseDumpKind("payload-2026-01-01T00-00-00-000Z-1.json")).toBeUndefined();
	});

	it("names captures by kind (orch/sub) and keeps the legacy name when the prompt is unknown", () => {
		const dir = tempDir();
		const orch = captureRequest({ payload: {} }, ctxFor("You are an orchestrator. Delegate only."), { dir });
		expect(parseDumpKind(orch.file as string)).toBe("orch");
		const sub = captureRequest({ payload: {} }, ctxFor("You are an implementation specialist."), { dir });
		expect(parseDumpKind(sub.file as string)).toBe("sub");
		const legacy = captureRequest({ payload: {} }, { cwd: "/tmp" }, { dir });
		expect(parseDumpKind(legacy.file as string)).toBeUndefined();
	});

	it("prunes 10 per kind: an orchestrator capture survives 15 subagent captures", () => {
		const dir = tempDir();
		const orch = writeKindDump(dir, "orch", 0, 1_700_000_000);
		const subs = Array.from({ length: 15 }, (_, i) => writeKindDump(dir, "sub", i, 1_700_000_001 + i));
		const removed = pruneDumps(dir, 10);
		expect(existsSync(orch)).toBe(true);
		expect(listDumps(dir).filter((p) => parseDumpKind(p) === "orch")).toEqual([orch]);
		const survivingSubs = listDumps(dir).filter((p) => parseDumpKind(p) === "sub");
		expect(survivingSubs).toHaveLength(10);
		expect(survivingSubs).toEqual(subs.slice(5));
		expect(removed).toEqual(subs.slice(0, 5));
	});

	it("keeps legacy (kind-less) files as their own whole-directory pool", () => {
		const dir = tempDir();
		const legacy = Array.from({ length: 13 }, (_, i) => writeDumpFile(dir, i, 1_700_000_000 + i));
		writeKindDump(dir, "orch", 99, 1_700_000_500);
		const removed = pruneDumps(dir, 10);
		expect(removed).toEqual(legacy.slice(0, 3));
		expect(listDumps(dir)).toHaveLength(11);
	});
});

describe("captureRequest", () => {
	it("writes one JSON file per request with the expected fields", () => {
		const dir = tempDir();
		process.env.PI_PROMPT_DUMP_DIR = dir;
		const payload = { model: "claude-sonnet-4-5", system: "SYS PROMPT", messages: [{ role: "user", content: "hi" }] };
		const result = captureRequest({ payload }, ctxFor("FORCED PROMPT"), { capturedAt: "2026-01-01T00:00:00.000Z" });
		expect(result.ok).toBe(true);
		expect(result.file).toBeDefined();
		const record = JSON.parse(readFileSync(result.file as string, "utf-8"));
		expect(record.capturedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(record.cwd).toBe("/tmp");
		expect(record.sessionId).toBe("sess-test-1");
		expect(record.model).toBe("claude-sonnet-4-5");
		expect(record.provider).toBe("anthropic");
		expect(record.systemPrompt).toBe("FORCED PROMPT");
		expect(record.systemPromptLength).toBe("FORCED PROMPT".length);
		expect(record.payloadShape.systemPromptLocation).toBe("payload.system");
		expect(record.payload.system).toBe("SYS PROMPT");
	});

	it("redacts secrets and elides huge blobs inside the payload", () => {
		const dir = tempDir();
		const payload = { apiKey: "sk-live-abcdefghijkl", messages: [{ role: "user", content: [{ type: "image", data: "C".repeat(3000) }] }] };
		const result = captureRequest({ payload }, ctxFor("p"), { dir });
		const text = readFileSync(result.file as string, "utf-8");
		expect(text).not.toContain("sk-live-abcdefghijkl");
		expect(text).toContain(REDACTED);
		expect(text).toContain("[base64 elided 3000 chars]");
	});

	it("never writes more than 10 files", () => {
		const dir = tempDir();
		let seconds = 1_700_000_000;
		for (let i = 0; i < 12; i += 1) {
			const result = captureRequest({ payload: { i } }, ctxFor("p"), { dir, capturedAt: new Date(seconds * 1000).toISOString() });
			expect(result.ok).toBe(true);
			const date = new Date(seconds * 1000);
			utimesSync(result.file as string, date, date);
			seconds += 1;
		}
		const files = listDumps(dir);
		expect(files).toHaveLength(10);
		expect(files[9]).toBe(newestDump(dir));
	});

	it("returns ok:false instead of throwing when the write fails", () => {
		const dir = tempDir();
		const filePath = join(dir, "not-a-dir");
		writeFileSync(filePath, "x", "utf-8");
		let result: ReturnType<typeof captureRequest>;
		expect(() => {
			result = captureRequest({ payload: {} }, ctxFor("p"), { dir: join(filePath, "sub") });
		}).not.toThrow();
		expect(result!.ok).toBe(false);
		expect(result!.error).toBeTruthy();
	});

	it("survives a ctx without getSystemPrompt", () => {
		const dir = tempDir();
		const result = captureRequest({ payload: {} }, { cwd: "/tmp" }, { dir });
		expect(result.ok).toBe(true);
		expect(JSON.parse(readFileSync(result.file as string, "utf-8")).systemPrompt).toBeNull();
	});
});

describe("buildDumpRecord / describePayloadShape", () => {
	it("detects the openai-completions head shape (system inside messages[0])", () => {
		const payload = { messages: [{ role: "system", content: "S" }, { role: "user", content: "u" }] };
		expect(describePayloadShape(payload).systemPromptLocation).toBe("payload.messages[0]");
	});

	it("detects the anthropic-messages shape (payload.system)", () => {
		expect(describePayloadShape({ system: "S", messages: [] }).systemPromptLocation).toBe("payload.system");
	});

	it("reports no location for unknown shapes without throwing", () => {
		expect(describePayloadShape(null).systemPromptLocation).toBeNull();
		expect(describePayloadShape("string").systemPromptLocation).toBeNull();
		expect(describePayloadShape({ tools: [] }).systemPromptLocation).toBeNull();
	});

	it("serializes circular-safe values without throwing", () => {
		const circular: any = { a: 1 };
		circular.self = circular;
		expect(() => buildDumpRecord({ payload: circular, systemPrompt: null, cwd: null, sessionId: null, model: null, provider: null, capturedAt: "t" })).not.toThrow();
	});
});

describe("default export (handler contract)", () => {
	it("registers before_provider_request and the /prompt-dump command", () => {
		const pi = makePi();
		promptDump(pi.api);
		expect(Object.keys(pi.handlers)).toContain("before_provider_request");
		expect(pi.commands.has("prompt-dump")).toBe(true);
	});

	it("asserts the hook exists in the installed pi build", () => {
		const hook = detectHookSupport();
		expect(hook.checked).toBe(true);
		expect(hook.supported).toBe(true);
		expect(hook.detail).toContain("runner.js");
	});

	it("writes a dump and returns undefined (payload untouched)", () => {
		const dir = tempDir();
		process.env.PI_PROMPT_DUMP_DIR = dir;
		const pi = makePi();
		promptDump(pi.api);
		const event = { type: "before_provider_request", payload: { system: "CAPTURED", messages: [] } };
		const results = pi.trigger("before_provider_request", event, ctxFor("FORCED DURING RUN"));
		expect(results[0]).toBeUndefined();
		const files = listDumps(dir);
		expect(files).toHaveLength(1);
		const record = JSON.parse(readFileSync(files[0], "utf-8"));
		expect(record.systemPrompt).toBe("FORCED DURING RUN");
		expect(record.payload).toEqual({ system: "CAPTURED", messages: [] });
		expect(event.payload).toEqual({ system: "CAPTURED", messages: [] });
	});

	it("stops capturing after /prompt-dump off and resumes after on", async () => {
		const dir = tempDir();
		process.env.PI_PROMPT_DUMP_DIR = dir;
		const pi = makePi();
		promptDump(pi.api);
		const command = pi.commands.get("prompt-dump");
		const event = { type: "before_provider_request", payload: { system: "S" } };
		await command.handler("off", ctxFor("p"));
		expect(pi.trigger("before_provider_request", event, ctxFor("p"))[0]).toBeUndefined();
		expect(listDumps(dir)).toHaveLength(0);
		await command.handler("on", ctxFor("p"));
		pi.trigger("before_provider_request", event, ctxFor("p"));
		expect(listDumps(dir)).toHaveLength(1);
		await command.handler("", ctxFor("p"));
	});

	it("logs to stderr at most once when writes fail, and never throws into the request", () => {
		const dir = tempDir();
		const filePath = join(dir, "not-a-dir");
		writeFileSync(filePath, "x", "utf-8");
		process.env.PI_PROMPT_DUMP_DIR = join(filePath, "sub");
		const pi = makePi();
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		promptDump(pi.api);
		spy.mockClear();
		const event = { type: "before_provider_request", payload: { system: "S" } };
		expect(pi.trigger("before_provider_request", event, ctxFor("p"))[0]).toBeUndefined();
		expect(pi.trigger("before_provider_request", event, ctxFor("p"))[0]).toBeUndefined();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("warns loudly when the hook is absent from the installed build", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = (support: { checked: boolean; supported: boolean; detail: string }) => {
			if (support.checked && !support.supported) console.error(`[prompt-dump] WARNING: hook not found in ${support.detail}`);
		};
		warn({ checked: true, supported: false, detail: "runner.js" });
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
	});

	it("starts disabled when PI_PROMPT_DUMP_OFF=1", () => {
		const dir = tempDir();
		process.env.PI_PROMPT_DUMP_DIR = dir;
		process.env.PI_PROMPT_DUMP_OFF = "1";
		const pi = makePi();
		promptDump(pi.api);
		pi.trigger("before_provider_request", { type: "before_provider_request", payload: {} }, ctxFor("p"));
		expect(readdirSync(dir)).toHaveLength(0);
	});
});
