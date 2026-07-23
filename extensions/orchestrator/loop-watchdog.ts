/**
 * Event-loop lag probe ported from OMP reference.
 * Tracks the current subagent event phase for stall diagnostics.
 */

import { performance } from "node:perf_hooks";
import { debugLog } from "./debug.ts";

// ── Phase tracker ────────────────────────────────────────────────────────────

const phaseStack: string[] = [];

export function pushPhase(name: string): void {
	phaseStack.push(name);
}

export function popPhase(): void {
	phaseStack.pop();
}

export function takeRecentLoopPhase(): string | null {
	return phaseStack.length > 0 ? phaseStack[phaseStack.length - 1] : null;
}

/** Clear phase stack (for tests). */
export function resetPhaseTracker(): void {
	phaseStack.length = 0;
}

// ── LoopWatchdog ─────────────────────────────────────────────────────────────

export interface LoopWatchdogOptions {
	intervalMs?: number;
	thresholdMs?: number;
	now?: () => number;
	schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
	onStall?: (info: { blockedMs: number; phase: string }) => void;
}

interface LoopWatchdogTimer {
	unref?(): void;
	cancel?(): void;
}

export class LoopWatchdog {
	#intervalMs: number;
	#thresholdMs: number;
	#now: () => number;
	#schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
	#onStall?: (info: { blockedMs: number; phase: string }) => void;
	#expected = 0;
	#wasBlocked = false;
	#running = false;
	#generation = 0;
	#handle: LoopWatchdogTimer | undefined;

	constructor(options: LoopWatchdogOptions = {}) {
		this.#intervalMs = options.intervalMs ?? 250;
		this.#thresholdMs = options.thresholdMs ?? 250;
		this.#now = options.now ?? (() => performance.now());
		this.#schedule =
			options.schedule ??
			((cb, ms) => {
				const timer = setTimeout(cb, ms);
				return {
					unref: () => timer.unref?.(),
					cancel: () => clearTimeout(timer),
				};
			});
		this.#onStall = options.onStall;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#wasBlocked = false;
		this.#armTick();
	}

	stop(): void {
		this.#running = false;
		this.#wasBlocked = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	#armTick(): void {
		const generation = this.#generation;
		this.#expected = this.#now() + this.#intervalMs;
		this.#handle = this.#schedule(
			() => this.#tick(generation),
			this.#intervalMs,
		);
		this.#handle.unref?.();
	}

	#tick(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const blockedMs = this.#now() - this.#expected;
		const phase = takeRecentLoopPhase();
		if (blockedMs > this.#thresholdMs) {
			if (!this.#wasBlocked) {
				this.#wasBlocked = true;
				const info = {
					blockedMs: Math.round(blockedMs),
					phase: phase ?? "unknown",
				};
				debugLog("[watchdog] loop-blocked:", info);
				this.#onStall?.(info);
			}
		} else {
			this.#wasBlocked = false;
		}
		this.#armTick();
	}
}
