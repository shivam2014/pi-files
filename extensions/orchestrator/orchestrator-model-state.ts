/**
 * Persistent "last orchestrator model" store.
 *
 * Purpose: a new orchestration session defaults to the model used by the
 * most-recently-*ended* orchestration session, without hardcoding and without
 * disrupting currently-running parallel sessions.
 *
 * Concurrency model:
 *   - getLastOrchestratorModel(): non-locking read (last-write-wins snapshot).
 *   - recordOrchestratorModel(): last-to-end-wins by timestamp. It acquires an
 *     exclusive file lock, re-reads the latest on-disk state, and only writes
 *     when the incoming endAt is strictly newer than the stored lastEndAt.
 *     Writes are atomic (write to a temp file then rename).
 *
 * Locking: a lightweight PID-based lock file (no external dependency).
 *   - The lock file is created exclusively (flag 'wx'). On EEXIST the holder's
 *     PID is read and checked with process.kill(pid, 0); a dead PID means a
 *     stale lock that is broken and retried, otherwise a short busy-wait retry.
 *
 * The state file lives next to orchestrator.yml, i.e. in getAgentDir()
 * (reused from orchestrator-config.ts's config path resolution).
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Types ─────────────────────────────────────────────────

export interface OrchestratorModelState {
	lastModel: string | null;
	lastEndAt: number | null;
}

// ─── Paths ─────────────────────────────────────────────────

/** Default state-file path, next to orchestrator.yml (getAgentDir()). */
export function _defaultStatePath(): string {
	return join(getAgentDir(), "orchestrator-state.json");
}

/** Lock file path derived from the state file path. */
export function _lockPathFor(statePath: string): string {
	return `${statePath}.lock`;
}

// ─── Locking (PID-based, no external dependency) ───────────

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		// EPERM means the process exists but we lack permission to signal it.
		return err?.code === "EPERM";
	}
}

/** Synchronous sleep (busy-wait retry backoff) without a native sleep. */
function sleepSync(ms: number): void {
	const sab = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(sab, 0, 0, ms);
}

const LOCK_RETRIES = 25;
const LOCK_RETRY_BASE_MS = 10;

function acquireLock(lockPath: string): boolean {
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		try {
			writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			return true;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			// Lock exists. Determine whether the holder is still alive.
			let heldPid: number | null = null;
			try {
				heldPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
			} catch {
				// Lock file unreadable or vanished — treat as stale and retry.
			}
			if (heldPid === null || Number.isNaN(heldPid) || !isProcessAlive(heldPid)) {
				// Stale lock: break it and retry immediately.
				try { unlinkSync(lockPath); } catch { /* ignore */ }
				continue;
			}
			// Lock held by a live process — busy-wait briefly.
			sleepSync(LOCK_RETRY_BASE_MS + attempt * 5);
		}
	}
	return false;
}

function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// Lock already gone — nothing to do.
	}
}

// ─── State file IO ─────────────────────────────────────────

function readState(statePath: string): OrchestratorModelState {
	try {
		const raw = readFileSync(statePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return {
				lastModel: typeof parsed.lastModel === "string" ? parsed.lastModel : null,
				lastEndAt: typeof parsed.lastEndAt === "number" ? parsed.lastEndAt : null,
			};
		}
		return { lastModel: null, lastEndAt: null };
	} catch {
		// File absent or invalid — treat as empty state.
		return { lastModel: null, lastEndAt: null };
	}
}

function writeStateAtomic(statePath: string, state: OrchestratorModelState): void {
	const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(state), "utf-8");
	renameSync(tmpPath, statePath);
}

// ─── Public API ────────────────────────────────────────────

/**
 * Read the persisted last orchestrator model (non-locking read).
 * Returns the model id string, or null when the file is absent/invalid.
 */
export function getLastOrchestratorModel(statePath?: string): string | null {
	return readState(statePath ?? _defaultStatePath()).lastModel;
}

/**
 * Record the orchestrator model used by an ended orchestration session.
 *
 * Concurrency-safe, last-to-end-wins by timestamp:
 *   1. acquire an exclusive file lock,
 *   2. re-read the latest on-disk state,
 *   3. write only when endAt > stored lastEndAt,
 *   4. write atomically (temp file + rename).
 */
export function recordOrchestratorModel(model: string, endAt: number, statePath?: string): void {
	const path = statePath ?? _defaultStatePath();
	const lockPath = _lockPathFor(path);
	mkdirSync(dirname(path), { recursive: true });

	const locked = acquireLock(lockPath);
	try {
		const current = readState(path);
		// Last-to-end-wins: only overwrite when this write ends later.
		if (current.lastEndAt != null && endAt <= current.lastEndAt) {
			return;
		}
		writeStateAtomic(path, { lastModel: model, lastEndAt: endAt });
	} finally {
		if (locked) releaseLock(lockPath);
	}
}
