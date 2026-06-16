import { defineConfig } from "vitest/config";

const PI_ROOT = `${process.env.HOME}/.hermes/node/lib/node_modules/@earendil-works/pi-coding-agent`;

export default defineConfig({
  resolve: {
    alias: {
      // ── @earendil-works/* packages ──────────────────────────────────
      "@earendil-works/pi-coding-agent": `${PI_ROOT}/dist/index.js`,
      "@earendil-works/pi-ai": `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/index.js`,
      "@earendil-works/pi-tui": `${PI_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
      "@earendil-works/pi-agent-core": `${PI_ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,

      // ── @mariozechner/* (older namespace, identical packages) ──────
      "@mariozechner/pi-coding-agent": `${PI_ROOT}/dist/index.js`,
      "@mariozechner/pi-ai": `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/index.js`,
      "@mariozechner/pi-tui": `${PI_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
      "@mariozechner/pi-agent-core": `${PI_ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,

      // ── typebox ────────────────────────────────────────────────────
      "typebox": `${PI_ROOT}/node_modules/typebox/build/index.mjs`,
    },
  },
});
