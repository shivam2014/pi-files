import { defineConfig } from "vitest/config";

const PI_ROOT = `${process.env.HOME}/.pi/agent/extensions/node_modules/@earendil-works/pi-coding-agent`;

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@earendil-works/pi-coding-agent",
        replacement: `${PI_ROOT}/dist/index.js`,
      },
      {
        find: "typebox",
        replacement: `${PI_ROOT}/node_modules/typebox/build/index.mjs`,
      },
    ],
  },
  test: {
    setupFiles: ["./orchestrator/test-setup.ts"],
  },
});
