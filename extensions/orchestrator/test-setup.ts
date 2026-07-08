/**
 * Vitest setup — initializes the SDK theme singleton for test environments.
 *
 * In production, pi calls initTheme() before any UI renders. In tests we
 * must set the global manually so getTheme() in orchestrator-theme.ts works.
 */
import { beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";

beforeAll(() => {
  // Initialize with default theme (dark/light based on terminal)
  // This sets globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]
  initTheme("dark");
});
