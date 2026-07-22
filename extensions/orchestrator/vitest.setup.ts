/**
 * Vitest setup — initializes the SDK theme singleton for test environments.
 *
 * In production, pi calls initTheme() before any UI renders. In tests we
 * must set the global manually so getTheme() in orchestrator-theme.ts works.
 *
 * This runs BEFORE any test module imports, so globalThis[THEME_KEY] is set
 * before any transitive import of orchestrator-theme.ts can call getTheme().
 *
 * Per-file vi.mock() calls in individual tests override this — both coexist.
 */

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

if (!(globalThis as any)[THEME_KEY]) {
  (globalThis as any)[THEME_KEY] = {
    fg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
    bg: (_style: string, text: any) => (typeof text === "string" ? text : ""),
  };
}
