import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	getLastOrchestratorModel,
	recordOrchestratorModel,
	_lockPathFor,
} from "./orchestrator-model-state.ts";

// Track temp dirs so we can clean them up after each test.
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

/** Create a fresh temp dir for the state file, isolated from the real agent dir. */
function makeStatePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "orch-state-"));
	tempDirs.push(dir);
	return join(dir, "orchestrator-state.json");
}

describe("orchestrator-model-state", () => {
	describe("getLastOrchestratorModel", () => {
		it("returns null when the state file is absent", () => {
			const statePath = makeStatePath();
			expect(getLastOrchestratorModel(statePath)).toBeNull();
		});

		it("returns null when the state file is invalid JSON", () => {
			const statePath = makeStatePath();
			writeFileSync(statePath, "{ not json", "utf-8");
			expect(getLastOrchestratorModel(statePath)).toBeNull();
		});

		it("returns null when the state file has no lastModel", () => {
			const statePath = makeStatePath();
			writeFileSync(statePath, JSON.stringify({ lastModel: null, lastEndAt: null }), "utf-8");
			expect(getLastOrchestratorModel(statePath)).toBeNull();
		});

		it("reads a persisted model id back", () => {
			const statePath = makeStatePath();
			recordOrchestratorModel("anthropic/claude-sonnet-4", 1000, statePath);
			expect(getLastOrchestratorModel(statePath)).toBe("anthropic/claude-sonnet-4");
		});
	});

	describe("recordOrchestratorModel — last-to-end-wins", () => {
		it("records then reads back the model and endAt", () => {
			const statePath = makeStatePath();
			recordOrchestratorModel("provider/model-a", 500, statePath);
			const state = JSON.parse(readFileSync(statePath, "utf-8"));
			expect(state.lastModel).toBe("provider/model-a");
			expect(state.lastEndAt).toBe(500);
		});

		it("the later endAt wins when two writes race", () => {
			const statePath = makeStatePath();
			recordOrchestratorModel("provider/model-old", 100, statePath);
			recordOrchestratorModel("provider/model-new", 200, statePath);
			expect(getLastOrchestratorModel(statePath)).toBe("provider/model-new");
			const state = JSON.parse(readFileSync(statePath, "utf-8"));
			expect(state.lastEndAt).toBe(200);
		});

		it("does not overwrite a newer state with an older endAt", () => {
			const statePath = makeStatePath();
			recordOrchestratorModel("provider/model-new", 300, statePath);
			// An older/equal write must NOT clobber the newer one.
			recordOrchestratorModel("provider/model-stale", 200, statePath);
			expect(getLastOrchestratorModel(statePath)).toBe("provider/model-new");
			const state = JSON.parse(readFileSync(statePath, "utf-8"));
			expect(state.lastEndAt).toBe(300);
		});

		it("writes are atomic: no temp files left behind, file is valid JSON", () => {
			const statePath = makeStatePath();
			recordOrchestratorModel("provider/model-a", 1234, statePath);
			const dir = join(statePath, "..");
			const files = readdirSync(dir);
			// Only the state file (and no leftover *.tmp).
			expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
			expect(existsSync(statePath)).toBe(true);
			expect(JSON.parse(readFileSync(statePath, "utf-8")).lastModel).toBe("provider/model-a");
		});

		it("concurrent writes settle on the maximum endAt (last-to-end-wins)", async () => {
			const statePath = makeStatePath();
			const writes: Array<[string, number]> = [
				["provider/model-1", 100],
				["provider/model-2", 400],
				["provider/model-3", 200],
				["provider/model-4", 300],
			];
			await Promise.all(
				writes.map(([model, endAt]) =>
					Promise.resolve().then(() => recordOrchestratorModel(model, endAt, statePath)),
				),
			);
			// The model with the highest endAt (model-2 @ 400) must win.
			expect(getLastOrchestratorModel(statePath)).toBe("provider/model-2");
			const state = JSON.parse(readFileSync(statePath, "utf-8"));
			expect(state.lastEndAt).toBe(400);
		});
	});

	describe("lock handling", () => {
		it("breaks a stale lock (dead PID) and proceeds to write", () => {
			const statePath = makeStatePath();
			const lockPath = _lockPathFor(statePath);
			// A PID that is guaranteed not alive.
			writeFileSync(lockPath, String(999999999), "utf-8");
			recordOrchestratorModel("provider/model-a", 10, statePath);
			expect(getLastOrchestratorModel(statePath)).toBe("provider/model-a");
			// The stale lock must be cleaned up.
			expect(existsSync(lockPath)).toBe(false);
		});

		it("releases the lock after a normal write", () => {
			const statePath = makeStatePath();
			const lockPath = _lockPathFor(statePath);
			recordOrchestratorModel("provider/model-a", 10, statePath);
			expect(existsSync(lockPath)).toBe(false);
		});
	});
});
