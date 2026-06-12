/**
 * Debug logging for the orchestrator extension.
 * Extracted from orchestrator.ts during refactoring.
 * Writes to /tmp/orchestrator-debug/ with timestamped filenames.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEBUG_LOG_DIR = "/tmp/orchestrator-debug";
try { mkdirSync(DEBUG_LOG_DIR, { recursive: true }); } catch {}
const DEBUG_LOG = join(DEBUG_LOG_DIR, `orchestrator-${Date.now()}.log`);

export function debugLog(msg: string, data?: any): void {
	const line = data
		? `[${new Date().toISOString()}] ${msg} ${JSON.stringify(data)}`
		: `[${new Date().toISOString()}] ${msg}`;
	try { appendFileSync(DEBUG_LOG, line + "\n"); } catch {}
}
