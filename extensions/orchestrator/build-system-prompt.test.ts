/**
 * Tests for scripts/build-system-prompt.mjs — the standalone offline renderer of the
 * orchestrator system prompt.
 *
 * Unit tests import the module directly (parseArgs/mergeSkills are exported; main() only runs
 * when the file is executed). CLI tests spawn the real script, which builds an idle pi session
 * (no network) and bundles prompt-builder.ts with esbuild — each spawn takes ~1-3s.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The scripts are plain .mjs with @ts-nocheck (no type declarations); behaviour is covered by the
// CLI tests below, so the imports are intentionally untyped (@ts-ignore, not @ts-expect-error:
// tsc reports TS7016 only when it treats the .mjs as untyped, which depends on incremental state).
// @ts-ignore TS7016: untyped .mjs module
import { MIN_PI_VERSION, agentDir, compareVersions, mergeSkills, parseArgs, resolvePi } from "./scripts/build-system-prompt.mjs";
// @ts-ignore TS7016: untyped .mjs module
import { diffOps, extractCaptureText, formatDiff } from "./scripts/unified-diff.mjs";
// @ts-ignore TS7016: untyped .mjs module
import { resolvePack, scopeSection, specialistTools } from "./scripts/render-specialist-prompt.mjs";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "scripts", "build-system-prompt.mjs");
const SPECIALIST_SCRIPT = path.join(EXT_DIR, "scripts", "render-specialist-prompt.mjs");
const STALE_PI_ROOT = path.join(EXT_DIR, "node_modules", "@earendil-works", "pi-coding-agent");
const TIMEOUT = 120_000;

function runCli(args: string[], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		cwd: EXT_DIR,
		encoding: "utf8",
		timeout: TIMEOUT,
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, ...env },
	});
}

function runSpecialistCli(args: string[], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [SPECIALIST_SCRIPT, ...args], {
		cwd: EXT_DIR,
		encoding: "utf8",
		timeout: TIMEOUT,
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, ...env },
	});
}

function tmpFile(name: string, content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-sim-test-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
}

describe("argument parsing", () => {
	it("defaults to process.cwd() with the chain render on (the live text)", () => {
		const opts = parseArgs([]);
		expect(opts.cwd).toBe(process.cwd());
		expect(opts.json).toBe(false);
		expect(opts.baseOnly).toBe(false);
		expect(opts.skillsOnly).toBe(false);
		expect(opts.chain).toBe(true);
		expect(opts.diff).toBe(null);
	});

	it("--no-chain opts out of the chain render; --chain stays an accepted no-op alias", () => {
		expect(parseArgs([]).chain).toBe(true);
		expect(parseArgs(["--chain"]).chain).toBe(true);
		expect(parseArgs(["--no-chain"]).chain).toBe(false);
		// last flag wins, so an explicit --chain can undo --no-chain in a scripted command line
		expect(parseArgs(["--chain", "--no-chain"]).chain).toBe(false);
		expect(parseArgs(["--no-chain", "--chain"]).chain).toBe(true);
	});

	it("parses --cwd (space and = forms) and resolves it", () => {
		expect(parseArgs(["--cwd", "relative/dir"]).cwd).toBe(path.resolve("relative/dir"));
		expect(parseArgs(["--cwd=/tmp"]).cwd).toBe(path.resolve("/tmp"));
	});

	it("parses the output flags", () => {
		const opts = parseArgs(["--json", "--base-only", "--skills", "--chain", "--diff", "cap.json"]);
		expect(opts.json && opts.baseOnly && opts.skillsOnly && opts.chain).toBe(true);
		expect(opts.diff).toBe(path.resolve("cap.json"));
	});

	it("throws on unknown arguments and on missing values", () => {
		expect(() => parseArgs(["--nope"])).toThrow(/unknown argument: --nope/);
		expect(() => parseArgs(["--cwd"])).toThrow(/--cwd requires a value/);
	});
});

describe("skills merge rule (index.ts:171-186 equivalent)", () => {
	it("keeps pi's skills, adds specialist-declared ones that exist on disk, dedups", () => {
		const realSkill = fs
			.readdirSync(path.join(agentDir(), "skills"))
			.find((name) => fs.existsSync(path.join(agentDir(), "skills", name, "SKILL.md")));
		expect(realSkill, "expected at least one installed skill under the agent dir").toBeTruthy();
		const modules = { SPECIALISTS: { coder: { suggestedSkills: [realSkill, "definitely-not-installed-xyz"] } } };
		const { skills, extra } = mergeSkills([{ name: "existing" }], modules);
		expect(skills.map((s: { name: string }) => s.name)).toContain("existing");
		expect(extra).toContain(realSkill);
		expect(skills.map((s: { name: string }) => s.name)).not.toContain("definitely-not-installed-xyz");
		expect(new Set(skills.map((s: { name: string }) => s.name)).size).toBe(skills.length);
	});
});

describe("pi-root resolution + version guard", () => {
	it("compareVersions orders dotted versions numerically", () => {
		expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
		expect(compareVersions("0.80.3", "1.3.0")).toBeLessThan(0);
		expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.3", "1.3.0")).toBe(0);
	});

	it("rejects a forced --pi-root that is not a pi package", () => {
		expect(() => resolvePi({ piRoot: path.join(os.tmpdir(), "definitely-not-a-pi-package") })).toThrow(/is not a @earendil-works\/pi-coding-agent package/);
	});

	it("resolves the running pi (>= 1.3.0), never the stale extension copy", () => {
		const resolved = resolvePi({});
		expect(compareVersions(resolved.version, MIN_PI_VERSION)).toBeGreaterThanOrEqual(0);
		expect(resolved.root).not.toBe(STALE_PI_ROOT);
		expect(path.resolve(resolved.root)).toBe(resolved.root);
	});

	it("refuses an older build by name unless allowOldPi", () => {
		if (!fs.existsSync(path.join(STALE_PI_ROOT, "package.json"))) return; // stale copy absent — nothing to guard
		expect(() => resolvePi({ piRoot: STALE_PI_ROOT })).toThrow(/older than the supported minimum 1\.3\.0/);
		const allowed = resolvePi({ piRoot: STALE_PI_ROOT, allowOldPi: true });
		expect(allowed.root).toBe(STALE_PI_ROOT);
	});
});

describe("specialist prompt helpers", () => {
	it("specialistTools appends the runner extras and drops bash for non-bash specialists", () => {
		const modules = { specialists: { SPECIALISTS: { coder: { tools: ["read", "bash", "edit", "write"] }, scout: { tools: ["read"] } }, canUseBash: (n: string) => n === "coder" } };
		const coder = specialistTools(modules, "coder");
		expect(coder).toContain("planSteps");
		expect(coder).toContain("bash");
		expect(specialistTools(modules, "scout")).not.toContain("bash");
		expect(() => specialistTools(modules, "nope")).toThrow(/unknown specialist/);
	});

	it("resolvePack mirrors defaults ∪ override (specialists.ts:649-653)", () => {
		const spec = { suggestedSkills: ["implement", "tdd"] };
		expect(resolvePack(spec, null)).toEqual(["implement", "tdd"]);
		expect(resolvePack(spec, ["tdd", "diagnosing-bugs"])).toEqual(["implement", "tdd", "diagnosing-bugs"]);
	});

	it("scopeSection reproduces subagent-runner.ts:1121-1132 verbatim", () => {
		const section = scopeSection({ filesToModify: ["a.ts"], filesToCreate: [], directories: ["/x"], maxFiles: 7, changeType: "multi-file", maxLinesPerFile: 400, boundaries: "no node_modules" });
		expect(section).toBe("\n\n## Scope Restrictions\nYou may ONLY modify/create files within this scope:\n- Files to modify:\n  - a.ts\n- Files to create:\n  - (none)\n- Allowed directories: /x\n- Max files: 7\n- Changes beyond scope require approval: true\n- Change type: multi-file (may edit multiple files)\n- Max lines per file: 400\n- Boundaries: no node_modules\n");
	});
});

describe("unified diff engine", () => {
	it("emits only headers for identical input", () => {
		expect(formatDiff(["a", "b"], ["a", "b"], "a", "b")).toBe("--- a\n+++ b");
	});

	it("marks removals and additions with a hunk header", () => {
		const diff = formatDiff(["one", "two"], ["one", "TWO"], "a", "b");
		expect(diff).toContain("@@ -1,2 +1,2 @@");
		expect(diff).toContain("-two");
		expect(diff).toContain("+TWO");
	});

	it("diffOps counts match the inputs", () => {
		const ops = diffOps(["x", "y"], ["x", "z"]);
		expect(ops.filter((o: { t: string }) => o.t === " ").length).toBe(1);
		expect(ops.filter((o: { t: string }) => o.t === "-").length).toBe(1);
		expect(ops.filter((o: { t: string }) => o.t === "+").length).toBe(1);
	});

	it("extractCaptureText reads { systemPrompt } and rejects other shapes", () => {
		const file = tmpFile("cap.json", JSON.stringify({ systemPrompt: "hello" }));
		expect(extractCaptureText(file, fs.readFileSync)).toBe("hello");
		const bad = tmpFile("bad.json", JSON.stringify({ nope: true }));
		expect(() => extractCaptureText(bad, fs.readFileSync)).toThrow(/no systemPrompt field/);
	});
});

describe("CLI", () => {
	it("--json emits the documented record and a real orchestrator prompt", { timeout: TIMEOUT }, () => {
		const res = runCli(["--cwd", EXT_DIR, "--json"]);
		expect(res.status).toBe(0);
		const record = JSON.parse(res.stdout);
		expect(Object.keys(record).sort()).toEqual(["baseCharCount", "charCount", "cwd", "lineCount", "mode", "piVersion", "source", "systemPrompt"]);
		expect(record.mode).toBe("chain");
		expect(record.piVersion).toMatch(/^\d+\.\d+\.\d+/);
		expect(record.cwd).toBe(EXT_DIR);
		expect(record.charCount).toBe(record.systemPrompt.length);
		expect(record.lineCount).toBe(record.systemPrompt.split("\n").length);
		expect(record.baseCharCount).toBeGreaterThan(0);
		expect(record.charCount).toBeGreaterThan(record.baseCharCount);
		expect(record.systemPrompt).toContain("You are an orchestrator");
		expect(record.source).toMatch(/^pi-(sdk|sdk:idle-session|buildSystemPrompt)|^pi-sdk/);
	});

	it("the default render IS the chain render (what the provider receives)", { timeout: TIMEOUT }, () => {
		const byDefault = runCli(["--cwd", EXT_DIR]);
		const explicit = runCli(["--cwd", EXT_DIR, "--chain"]);
		expect(byDefault.status).toBe(0);
		expect(explicit.status).toBe(0);
		expect(byDefault.stdout).toBe(explicit.stdout);
		expect(byDefault.stdout).toContain("You are an orchestrator");
	});

	it("--no-chain prints the shorter extension-only composition, not the live text", { timeout: TIMEOUT }, () => {
		const compose = runCli(["--cwd", EXT_DIR, "--no-chain"]);
		const byDefault = runCli(["--cwd", EXT_DIR]);
		expect(compose.status).toBe(0);
		expect(compose.stdout).toContain("You are an orchestrator");
		expect(compose.stdout).not.toBe(byDefault.stdout);
		expect(compose.stdout.length).toBeLessThan(byDefault.stdout.length);
	});

	it("--json names the mode that produced the record", { timeout: TIMEOUT }, () => {
		expect(JSON.parse(runCli(["--cwd", EXT_DIR, "--json"]).stdout).mode).toBe("chain");
		expect(JSON.parse(runCli(["--cwd", EXT_DIR, "--no-chain", "--json"]).stdout).mode).toBe("compose");
		expect(JSON.parse(runCli(["--cwd", EXT_DIR, "--base-only", "--json"]).stdout).mode).toBe("base");
	});

	it("--base-only prints pi's base prompt, never the orchestrator prompt", { timeout: TIMEOUT }, () => {
		const res = runCli(["--cwd", EXT_DIR, "--base-only"]);
		expect(res.status).toBe(0);
		expect(res.stdout.startsWith("You are an expert coding assistant")).toBe(true);
		expect(res.stdout).not.toContain("You are an orchestrator");
	});

	it("--diff exits 0 for an identical capture", { timeout: TIMEOUT }, () => {
		const prompt = runCli(["--cwd", EXT_DIR]).stdout;
		const capture = tmpFile("capture.json", JSON.stringify({ cwd: EXT_DIR, systemPrompt: prompt }));
		const res = runCli(["--cwd", EXT_DIR, "--diff", capture]);
		expect(res.status).toBe(0);
		expect(res.stdout).toMatch(/no differences: \d+ lines \/ \d+ chars identical/);
	});

	it("--diff exits 1 and prints a unified diff when the capture differs", { timeout: TIMEOUT }, () => {
		const lines = runCli(["--cwd", EXT_DIR]).stdout.split("\n");
		lines[5] = "MUTATED FOR TEST";
		const capture = tmpFile("capture.json", JSON.stringify({ systemPrompt: lines.join("\n") }));
		const res = runCli(["--cwd", EXT_DIR, "--diff", capture]);
		expect(res.status).toBe(1);
		expect(res.stdout).toContain("--- capture:");
		expect(res.stdout).toContain("+++ script");
		expect(res.stdout).toContain("-MUTATED FOR TEST");
		expect(res.stderr).toMatch(/prompt differs from capture/);
	});

	it("--diff exits 2 with a clear error when the capture has no systemPrompt", { timeout: TIMEOUT }, () => {
		const capture = tmpFile("capture.json", JSON.stringify({ nope: 1 }));
		const res = runCli(["--cwd", EXT_DIR, "--diff", capture]);
		expect(res.status).toBe(2);
		expect(res.stderr).toMatch(/no systemPrompt field/);
	});

	it("fails loudly (exit 2, no base prompt on stdout) when pi cannot be resolved", { timeout: TIMEOUT }, () => {
		const missing = path.join(os.tmpdir(), "definitely-not-a-pi-package");
		const res = runCli(["--cwd", EXT_DIR], { PROMPT_SIM_PI_ROOT: missing });
		expect(res.status).toBe(2);
		expect(res.stderr).toMatch(/is not a @earendil-works\/pi-coding-agent package/);
		expect(res.stdout).toBe("");
	});

	it("exits 2 on usage errors", () => {
		const res = runCli(["--bogus"]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("unknown argument: --bogus");
		expect(res.stderr).toContain("Usage:");
	});

	it("--pi-root at the stale extension copy exits 2 naming both paths/versions, unless --allow-old-pi", { timeout: TIMEOUT }, () => {
		if (!fs.existsSync(path.join(STALE_PI_ROOT, "package.json"))) return;
		const blocked = runCli(["--pi-root", STALE_PI_ROOT, "--json"]);
		expect(blocked.status).toBe(2);
		expect(blocked.stdout).toBe("");
		expect(blocked.stderr).toMatch(/older than the supported minimum 1\.3\.0/);
		expect(blocked.stderr).toContain(STALE_PI_ROOT);
		expect(blocked.stderr).toMatch(/--allow-old-pi/);
		const allowed = runCli(["--pi-root", STALE_PI_ROOT, "--allow-old-pi", "--json"]);
		expect(allowed.status).toBe(0);
		const record = JSON.parse(allowed.stdout);
		expect(record.piVersion).toMatch(/^0\./);
	});

	it("prints the resolved pi version to stderr and renders the orchestrator prompt", { timeout: TIMEOUT }, () => {
		const res = runCli(["--cwd", EXT_DIR]);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("You are an orchestrator");
		expect(res.stderr).toMatch(/build-system-prompt: pi \d+\.\d+\.\d+/);
	});
});

describe("specialist renderer CLI", () => {
	it("--specialist coder --json reports tools + the skills section", { timeout: TIMEOUT }, () => {
		const res = runSpecialistCli(["--specialist", "coder", "--cwd", EXT_DIR, "--json"]);
		expect(res.status).toBe(0);
		const record = JSON.parse(res.stdout);
		expect(record.specialist).toBe("coder");
		expect(record.tools).toContain("read");
		expect(record.tools).toContain("bash");
		expect(record.tools).toContain("planSteps");
		expect(record.charCount).toBe(record.prompt.length);
		expect(record.lineCount).toBe(record.prompt.split("\n").length);
		expect(record.skillsSectionPresent).toBe(true); // coder declares read/bash → skills section injected
		expect(record.prompt).toContain("You are an implementation specialist");
		expect(record.prompt).not.toContain("You are an orchestrator");
	});

	it("--all prints one row per specialist with a skills flag", { timeout: TIMEOUT }, () => {
		const res = runSpecialistCli(["--all", "--cwd", EXT_DIR]);
		expect(res.status).toBe(0);
		const rows = res.stdout.trim().split("\n");
		expect(rows.length).toBeGreaterThanOrEqual(5);
		for (const row of rows) expect(row).toMatch(/^\S+\s*\|\s*\d+ tools\s*\|\s*\d+ chars\s*\|\s*skills:(yes|no)\s*\|/);
	});

	it("unknown specialist exits 2 listing the roster", { timeout: TIMEOUT }, () => {
		const res = runSpecialistCli(["--specialist", "nope", "--cwd", EXT_DIR]);
		expect(res.status).toBe(2);
		expect(res.stderr).toMatch(/unknown specialist "nope"; known: /);
	});
});
