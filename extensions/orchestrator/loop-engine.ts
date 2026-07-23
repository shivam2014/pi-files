import { exec } from "child_process";
import { MetricConfig, MetricDirection } from "./types.ts";

/**
 * L1 — Metric abstraction
 */

/** Execute a metric command and parse its stdout as a number */
export async function runMetricCommand(config: MetricConfig): Promise<number> {
  return new Promise((resolve, reject) => {
    exec(config.command, { shell: "/bin/bash", timeout: 30_000 }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        reject(new Error(`Metric command failed: ${error.message}`));
        return;
      }
      const trimmed = stdout.trim();
      const parsed = Number(trimmed);
      if (isNaN(parsed)) {
        reject(new Error(`Metric command output non-numeric: "${trimmed}"`));
        return;
      }
      resolve(parsed);
    });
  });
}

/** Evaluate a single metric value against its target */
export function evaluateMetric(
  current: number,
  config: MetricConfig
): { met: boolean; direction: number } {
  if (config.target === undefined) {
    return { met: false, direction: 0 };
  }
  switch (config.direction) {
    case 'higher-better':
      return {
        met: current >= config.target,
        direction: current >= config.target ? 1 : -1,
      };
    case 'lower-better':
      return {
        met: current <= config.target,
        direction: current <= config.target ? 1 : -1,
      };
  }
}

/**
 * L2 — Trajectory classifier
 */

export type TrajectoryClass =
  | 'CONVERGING'
  | 'STALLING'
  | 'OSCILLATING'
  | 'DIVERGING'
  | 'INSUFFICIENT_DATA';

function absDiffPercent(a: number, b: number): number {
  const maxAbs = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / maxAbs;
}

function isNearTarget(value: number, target: number | undefined): boolean {
  if (target === undefined) return false;
  return absDiffPercent(value, target) <= 0.05; // within 5%
}

/** Classify a trajectory history into a trajectory class */
export function classifyTrajectory(
  history: number[],
  direction: MetricDirection,
  target?: number
): TrajectoryClass {
  if (history.length < 3) return 'INSUFFICIENT_DATA';

  const last5 = history.slice(-5);
  const last3 = history.slice(-3);

  // OSCILLATING: direction changes at least 3 times in last 5 values
  if (last5.length >= 4) {
    const deltas: number[] = [];
    for (let i = 1; i < last5.length; i++) {
      deltas.push(last5[i] - last5[i - 1]);
    }
    let signChanges = 0;
    for (let i = 1; i < deltas.length; i++) {
      if ((deltas[i] >= 0 && deltas[i - 1] < 0) || (deltas[i] < 0 && deltas[i - 1] >= 0)) {
        signChanges++;
      }
    }
    if (signChanges >= 3) return 'OSCILLATING';
  }

  // Check for target
  if (target !== undefined) {
    const firstVal = history[0];
    const lastVal = history[history.length - 1];

    // STALLING: last 3 values within 2% of each other and not near target
    {
      const max3 = Math.max(...last3);
      const min3 = Math.min(...last3);
      const mean3 = (max3 + min3) / 2;
      const rangePct = mean3 === 0 ? Math.abs(max3 - min3) : Math.abs(max3 - min3) / Math.abs(mean3);
      if (rangePct <= 0.05 && !isNearTarget(last3[last3.length - 1], target)) {
        return 'STALLING';
      }
    }

    // CONVERGING: last 2 values improve toward target, or within 5% of target
    const secondLast = history[history.length - 2];
    const improving =
      direction === 'higher-better'
        ? lastVal > secondLast
        : lastVal < secondLast;
    if (improving || isNearTarget(lastVal, target)) {
      return 'CONVERGING';
    }

    // DIVERGING: last value is further from target than first
    const firstDist = Math.abs(firstVal - target);
    const lastDist = Math.abs(lastVal - target);
    if (lastDist > firstDist) return 'DIVERGING';
  } else {
    // No target — use raw trend
    const lastVal = history[history.length - 1];
    const firstVal = history[0];
    const secondLast = history[history.length - 2];

    // STALLING: last 3 values within 2% of each other
    {
      const max3 = Math.max(...last3);
      const min3 = Math.min(...last3);
      const mean3 = (max3 + min3) / 2;
      const rangePct = mean3 === 0 ? Math.abs(max3 - min3) : Math.abs(max3 - min3) / Math.abs(mean3);
      if (rangePct <= 0.05) {
        return 'STALLING';
      }
    }

    const improving =
      direction === 'higher-better'
        ? lastVal > secondLast
        : lastVal < secondLast;
    if (improving) return 'CONVERGING';

    // DIVERGING: last value is worse than first
    const worsening =
      direction === 'higher-better'
        ? lastVal < firstVal
        : lastVal > firstVal;
    if (worsening) return 'DIVERGING';
  }

  return 'CONVERGING'; // optimistic default
}

/**
 * L3 — Best-so-far rollback
 */

/** Find the index of the best value in history based on direction */
export function findBestIndex(
  history: number[],
  direction: MetricDirection
): number {
  if (history.length === 0) return -1;
  let bestIdx = 0;
  for (let i = 1; i < history.length; i++) {
    const better =
      direction === 'higher-better'
        ? history[i] > history[bestIdx]
        : history[i] < history[bestIdx];
    if (better) bestIdx = i;
  }
  return bestIdx;
}
