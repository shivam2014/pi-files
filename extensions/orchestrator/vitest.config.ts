import { defineConfig } from "vitest/config";

const PI_ROOT = `${process.env.HOME}/.pi/agent/extensions/node_modules/@earendil-works/pi-coding-agent`;

const resolveAlias = [
  // Longer (more specific) paths first to avoid prefix collisions
  {
    find: "@earendil-works/pi-ai/compat",
    replacement: `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  },
  {
    find: "@earendil-works/pi-ai",
    replacement: `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  },
  {
    find: "@earendil-works/pi-tui",
    replacement: `${PI_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  },
  {
    find: "@earendil-works/pi-agent-core",
    replacement: `${PI_ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
  },
  {
    find: "@earendil-works/pi-coding-agent",
    replacement: `${PI_ROOT}/dist/index.js`,
  },
  // ── @mariozechner/* (older namespace, identical packages) ──────
  {
    find: "@mariozechner/pi-coding-agent",
    replacement: `${PI_ROOT}/dist/index.js`,
  },
  {
    find: "@mariozechner/pi-ai",
    replacement: `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  },
  {
    find: "@mariozechner/pi-tui",
    replacement: `${PI_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  },
  {
    find: "@mariozechner/pi-agent-core",
    replacement: `${PI_ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
  },
  {
    find: "typebox",
    replacement: `${PI_ROOT}/node_modules/typebox/build/index.mjs`,
  },
];

export default defineConfig({
  resolve: {
    alias: resolveAlias,
  },
  test: {
    setupFiles: ["./test-setup.ts"],
  },
});
