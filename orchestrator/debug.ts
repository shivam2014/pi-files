/**
 * Debug logging for the orchestrator extension.
 * Extracted from orchestrator.ts during refactoring.
 * Writes to /tmp/orchestrator-debug/ with timestamped filenames.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DEBUG_LOG_DIR = "/tmp/orchestrator-debug";
try { mkdirSync(DEBUG_LOG_DIR, { recursive: true }); } catch {}
const DEBUG_LOG = join(DEBUG_LOG_DIR, `orchestrator-${Date.now()}.log`);

/**
 * Delete debug log files older than 1 hour.
 */
function cleanupOldLogs(): void {
	try {
		const now = Date.now();
		const maxAge = 60 * 60 * 1000; // 1 hour
		const files = readdirSync(DEBUG_LOG_DIR);
		for (const file of files) {
			if (!file.startsWith("orchestrator-") || !file.endsWith(".log")) continue;
			const filePath = join(DEBUG_LOG_DIR, file);
			try {
				const stat = statSync(filePath);
				if (now - stat.mtimeMs > maxAge) {
					unlinkSync(filePath);
				}
			} catch {}
		}
	} catch {}
}

cleanupOldLogs();

export function debugLog(msg: string, data?: any): void {
	const line = data
		? `[${new Date().toISOString()}] ${msg} ${JSON.stringify(data)}`
		: `[${new Date().toISOString()}] ${msg}`;
	try { appendFileSync(DEBUG_LOG, line + "\n"); } catch {}
}
