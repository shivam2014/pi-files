import { describe, it, expect } from "vitest";
import {
  runMetricCommand,
  evaluateMetric,
  classifyTrajectory,
  findBestIndex,
} from "./loop-engine.ts";
import type { MetricConfig } from "./types.ts";

describe("L1 — Metric abstraction", () => {
  describe("runMetricCommand", () => {
    it("should parse numeric output from a command", async () => {
      const result = await runMetricCommand({
        command: "echo 42",
        direction: "higher-better",
      });
      expect(result).toBe(42);
    });

    it("should reject on non-numeric output", async () => {
      await expect(
        runMetricCommand({
          command: "echo hello",
          direction: "higher-better",
        })
      ).rejects.toThrow(/non-numeric/);
    });

    it("should reject on command failure", async () => {
      await expect(
        runMetricCommand({
          command: "false",
          direction: "higher-better",
        })
      ).rejects.toThrow(/failed/);
    });
  });

  describe("evaluateMetric", () => {
    const higherBetter: MetricConfig = {
      command: "",
      direction: "higher-better",
      target: 100,
    };
    const lowerBetter: MetricConfig = {
      command: "",
      direction: "lower-better",
      target: 50,
    };

    it("higher-better: met when current >= target", () => {
      expect(evaluateMetric(100, higherBetter)).toEqual({ met: true, direction: 1 });
      expect(evaluateMetric(150, higherBetter)).toEqual({ met: true, direction: 1 });
    });

    it("higher-better: not met when current < target", () => {
      expect(evaluateMetric(99, higherBetter)).toEqual({ met: false, direction: -1 });
    });

    it("lower-better: met when current <= target", () => {
      expect(evaluateMetric(50, lowerBetter)).toEqual({ met: true, direction: 1 });
      expect(evaluateMetric(30, lowerBetter)).toEqual({ met: true, direction: 1 });
    });

    it("lower-better: not met when current > target", () => {
      expect(evaluateMetric(51, lowerBetter)).toEqual({ met: false, direction: -1 });
    });

    it("returns met=false when no target defined", () => {
      const noTarget: MetricConfig = { command: "", direction: "higher-better" };
      expect(evaluateMetric(42, noTarget)).toEqual({ met: false, direction: 0 });
    });
  });
});

describe("L2 — Trajectory classifier", () => {
  describe("classifyTrajectory", () => {
    it("returns INSUFFICIENT_DATA for history length < 3", () => {
      expect(classifyTrajectory([1, 2], "higher-better")).toBe("INSUFFICIENT_DATA");
      expect(classifyTrajectory([1], "higher-better")).toBe("INSUFFICIENT_DATA");
      expect(classifyTrajectory([], "higher-better")).toBe("INSUFFICIENT_DATA");
    });

    it("returns CONVERGING when last 2 values improve toward target", () => {
      const result = classifyTrajectory([10, 20, 30, 40, 50], "higher-better", 100);
      expect(result).toBe("CONVERGING");
    });

    it("returns CONVERGING when within 5% of target", () => {
      const result = classifyTrajectory([1, 2, 3, 4, 98], "higher-better", 100);
      expect(result).toBe("CONVERGING");
    });

    it("returns STALLING when last 3 values within 2% but not near target", () => {
      const result = classifyTrajectory([5, 10, 52, 53, 53.5], "higher-better", 100);
      expect(result).toBe("STALLING");
    });

    it("returns OSCILLATING when direction changes >= 3 times in last 5", () => {
      const result = classifyTrajectory([1, 10, 2, 11, 3, 12, 4], "higher-better", 100);
      expect(result).toBe("OSCILLATING");
    });

    it("returns DIVERGING when last value further from target than first", () => {
      const result = classifyTrajectory([50, 40, 30, 20, 10], "higher-better", 100);
      expect(result).toBe("DIVERGING");
    });
  });
});

describe("L3 — Best-so-far rollback", () => {
  describe("findBestIndex", () => {
    it("returns index of highest value for higher-better", () => {
      const result = findBestIndex([60, 40, 80, 83, 88, 81], "higher-better");
      expect(result).toBe(4); // 88 at index 4
    });

    it("returns index of lowest value for lower-better", () => {
      const result = findBestIndex([10, 5, 8, 3, 7, 4], "lower-better");
      expect(result).toBe(3); // 3 at index 3
    });

    it("returns 0 for single-element history", () => {
      expect(findBestIndex([42], "higher-better")).toBe(0);
    });

    it("returns -1 for empty history", () => {
      expect(findBestIndex([], "higher-better")).toBe(-1);
    });
  });
});
