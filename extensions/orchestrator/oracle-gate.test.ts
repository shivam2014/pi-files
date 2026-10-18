/**
 * oracle-gate.test.ts — regression gate for the prompt oracle.
 *
 * The prompt oracle has two entrypoints:
 *   scripts/build-system-prompt.mjs       → the orchestrator system prompt
 *   scripts/render-specialist-prompt.mjs  → any specialist system prompt
 *
 * Both can diff a fresh render against a preserved prompt-dump capture
 * (`--diff <capture>.json`). These tests pin that behaviour against three
 * independent live captures checked in as fixtures:
 *   scripts/__fixtures__/orchestrator-prompt.json        (26,578 chars, cwd /private/tmp)
 *   scripts/__fixtures__/orchestrator-prompt-resume.json (31,926 chars, cwd …/Documents/Resume)
 *   scripts/__fixtures__/coder-prompt.json               (12,725 chars, cwd …/Documents/Resume)
 *   scripts/__fixtures__/coder-scope.json                (the delegation scope the coder pass ran with)
 *
 * The fixtures hold prompt TEXT ONLY — no messages, no conversation, no payload.
 * A render that drifts from a live capture means the oracle no longer describes
 * the running codebase, which is exactly the failure this gate exists to catch.
 *
 * Spawns are bounded (15s each) and every failure prints the child's stderr, so a
 * red result is diagnosable without re-running anything by hand.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join("scripts", "__fixtures__");
const ORCHESTRATOR_FIXTURE = path.join(FIXTURES, "orchestrator-prompt.json");
const ORCHESTRATOR_RESUME_FIXTURE = path.join(FIXTURES, "orchestrator-prompt-resume.json");
const CODER_FIXTURE = path.join(FIXTURES, "coder-prompt.json");
const CODER_SCOPE = path.join(FIXTURES, "coder-scope.json");
const CHILD_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

interface RunResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: Error;
	command: string;
}

/** Spawn `node scripts/<script> …` from the extension dir, bounded and captured. */
function runScript(script: string, args: string[]): RunResult {
	const command = `node scripts/${script} ${args.join(" ")}`;
	const result = spawnSync(process.execPath, [path.join("scripts", script), ...args], {
		cwd: EXT_DIR,
		encoding: "utf8",
		timeout: CHILD_TIMEOUT_MS,
		maxBuffer: 256 * 1024 * 1024,
		env: process.env,
	});
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
		command,
	};
}

/** Human-readable failure report — the child's own stderr is the point of this gate. */
function report(r: RunResult): string {
	return [
		`command: ${r.command}`,
		`ext dir: ${EXT_DIR}`,
		`exit: ${r.status}${r.signal ? ` (killed by ${r.signal})` : ""}`,
		r.error ? `spawn error: ${r.error.message}` : "",
		`--- stdout (tail) ---\n${r.stdout.slice(-2000)}`,
		`--- stderr (tail) ---\n${r.stderr.slice(-4000)}`,
	]
		.filter(Boolean)
		.join("\n");
}

describe("prompt oracle gate", () => {
	it(
		"orchestrator: --chain render is byte-identical to the live capture",
		() => {
			const r = runScript("build-system-prompt.mjs", ["--cwd", "/private/tmp", "--chain", "--diff", ORCHESTRATOR_FIXTURE]);
			expect(r.status, report(r)).toBe(0);
			expect(r.stdout, report(r)).toContain("no differences");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"orchestrator (Resume): --chain render is byte-identical to the live capture",
		() => {
			const r = runScript("build-system-prompt.mjs", ["--cwd", "/Users/shivam94/Documents/Resume", "--chain", "--diff", ORCHESTRATOR_RESUME_FIXTURE]);
			expect(r.status, report(r)).toBe(0);
			expect(r.stdout, report(r)).toContain("no differences");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"coder: render with the captured scope is byte-identical to the live capture",
		() => {
			const r = runScript("render-specialist-prompt.mjs", [
				"--specialist",
				"coder",
				"--cwd",
				"/Users/shivam94/Documents/Resume",
				"--scope-json",
				CODER_SCOPE,
				"--diff",
				CODER_FIXTURE,
			]);
			expect(r.status, report(r)).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});
