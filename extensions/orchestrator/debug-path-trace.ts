/**
 * Diagnostic tracing for file path handling in the orchestrator.
 *
 * Bug: scout reads "bash-interceptor.ts" but error shows "subagent-tools.ts".
 * This module logs the actual event.input.path at every stage to find
 * where the path gets transformed.
 *
 * ENABLE: set DEBUG_PATH_TRACE=1 in env, or call enablePathTrace().
 * OUTPUT: /tmp/orchestrator-debug/path-trace-<timestamp>.log
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TRACE_LOG_DIR = "/tmp/orchestrator-debug";
try { mkdirSync(TRACE_LOG_DIR, { recursive: true }); } catch {}
const TRACE_LOG = join(TRACE_LOG_DIR, `path-trace-${Date.now()}.log`);

let _traceEnabled = false;

export function enablePathTrace(): void {
	_traceEnabled = true;
}

export function isPathTraceEnabled(): boolean {
	return _traceEnabled || process.env.DEBUG_PATH_TRACE === "1";
}

function ts(): string {
	return new Date().toISOString();
}

function writeLine(line: string): void {
	try { appendFileSync(TRACE_LOG, line + "\n"); } catch {}
}

/**
 * Log the raw event as it arrives at a tool_call handler.
 * Captures: toolName, input (with paths), and a stack trace
 * to see the call chain.
 */
export function traceToolCallEntry(
	stage: string,
	event: any,
	ctx?: { cwd?: string },
): void {
	if (!isPathTraceEnabled()) return;
	const input = event?.input ?? {};
	const paths = extractPaths(input);
	const stack = new Error().stack?.split("\n").slice(1, 6).join(" | ") ?? "no-stack";

	writeLine(
		`[${ts()}] ENTRY stage=${stage} tool=${event?.toolName}` +
		` cwd=${ctx?.cwd ?? process.cwd()}` +
		` paths=${JSON.stringify(paths)}` +
		` input_keys=${JSON.stringify(Object.keys(input))}` +
		` input_preview=${JSON.stringify(input).slice(0, 300)}` +
		` stack=${stack}`
	);
}

/**
 * Log after paths have been collected from event.input.
 * Shows each raw path and which input field it came from.
 */
export function tracePathsExtracted(
	stage: string,
	input: any,
	filePaths: string[],
): void {
	if (!isPathTraceEnabled()) return;
	writeLine(
		`[${ts()}] EXTRACT stage=${stage}` +
		` input.path=${input?.path}` +
		` input.filePath=${input?.filePath}` +
		` input.file=${input?.file}` +
		` input.command=${input?.command?.slice(0, 120)}` +
		` extracted=${JSON.stringify(filePaths)}`
	);
}

/**
 * Log after path.resolve() — shows the transformation.
 */
export function tracePathResolved(
	stage: string,
	rawPath: string,
	absolutePath: string,
	operation: string,
): void {
	if (!isPathTraceEnabled()) return;
	writeLine(
		`[${ts()}] RESOLVE stage=${stage}` +
		` raw=${rawPath}` +
		` resolved=${absolutePath}` +
		` op=${operation}`
	);
}

/**
 * Log scope check result.
 */
export function traceScopeCheck(
	stage: string,
	absolutePath: string,
	allowed: boolean,
	reason?: string,
): void {
	if (!isPathTraceEnabled()) return;
	writeLine(
		`[${ts()}] SCOPE stage=${stage}` +
		` path=${absolutePath}` +
		` allowed=${allowed}` +
		` reason=${reason ?? "ok"}`
	);
}

/**
 * Log the final block/allow decision with full context.
 */
export function traceDecision(
	stage: string,
	event: any,
	result: any,
): void {
	if (!isPathTraceEnabled()) return;
	writeLine(
		`[${ts()}] DECIDE stage=${stage}` +
		` tool=${event?.toolName}` +
		` input_path=${event?.input?.path}` +
		` result=${JSON.stringify(result)}`
	);
}

/**
 * Generic marker — for ad-hoc debugging.
 */
export function traceMark(label: string, data?: any): void {
	if (!isPathTraceEnabled()) return;
	writeLine(
		`[${ts()}] MARK ${label} ${data != null ? JSON.stringify(data) : ""}`
	);
}

function extractPaths(input: any): Record<string, string | undefined> {
	return {
		path: input?.path,
		filePath: input?.filePath,
		file: input?.file,
	};
}

// ── Self-test: run with `npx tsx debug-path-trace.ts` ──
if (process.argv[1]?.endsWith("debug-path-trace.ts")) {
	const { resolve } = await import("node:path");
	const cwd = "/Users/shivam94/.pi/agent/extensions/orchestrator";

	console.log("=== path-trace self-test ===\n");

	// Test 1: Basic path extraction
	const input1: any = { path: "bash-interceptor.ts" };
	const paths1 = [input1.filePath, input1.path, input1.file].filter(Boolean);
	console.log(`[1] input.path extraction: ${JSON.stringify(paths1)}`);
	console.assert(paths1.length === 1 && paths1[0] === "bash-interceptor.ts", "FAIL: expected bash-interceptor.ts");

	// Test 2: Path resolution
	const resolved1 = resolve(cwd, "bash-interceptor.ts");
	console.log(`[2] resolved: ${resolved1}`);
	console.assert(resolved1.endsWith("bash-interceptor.ts"), "FAIL: resolved path missing filename");

	// Test 3: Event mutation simulation
	const sharedInput: any = { path: "bash-interceptor.ts" };
	const event1 = { toolName: "read", input: sharedInput };
	const captured1 = [event1.input.path];
	sharedInput.path = "subagent-tools.ts"; // SDK reuses object
	const event2 = { toolName: "read", input: sharedInput };
	const captured2 = [event2.input.path];
	console.log(`[3] event1 captured: ${JSON.stringify(captured1)} (before mutation)`);
	console.log(`[3] event2 sees: ${JSON.stringify(captured2)} (after mutation)`);
	console.log(`[3] BUG? event1 captured "${captured1[0]}" but if re-read: "${event1.input.path}"`);
	console.assert(captured1[0] === "bash-interceptor.ts", "FAIL: captured should be original");
	console.assert(captured2[0] === "subagent-tools.ts", "FAIL: event2 should see mutated");
	console.assert(event1.input.path === "subagent-tools.ts", "FAIL: re-read should show mutation");

	// Test 4: Trace the exact bug scenario
	enablePathTrace();
	traceToolCallEntry("self-test", { toolName: "read", input: { path: "bash-interceptor.ts" } }, { cwd });
	tracePathsExtracted("self-test", { path: "bash-interceptor.ts" }, ["bash-interceptor.ts"]);
	tracePathResolved("self-test", "bash-interceptor.ts", resolve(cwd, "bash-interceptor.ts"), "read");
	traceScopeCheck("self-test", resolve(cwd, "bash-interceptor.ts"), false, "Scope violation: bash-interceptor.ts is outside the allowed scope");
	traceDecision("self-test", { toolName: "read", input: { path: "bash-interceptor.ts" } }, { block: true, reason: "Scope violation" });

	console.log(`\n[4] Trace log written to: ${TRACE_LOG}`);
	console.log("\n=== self-test complete ===");
}
