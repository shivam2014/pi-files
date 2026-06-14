import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { TectonicDetection } from "./types";

const TECTONIC_BUNDLED = "/Users/shivam94/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/latex/bin/tectonic";

function getVersion(path: string): string | null {
  try {
    const out = execFileSync(path, ["--version"], { encoding: "utf-8", timeout: 5000 });
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function detectTectonic(): TectonicDetection {
  if (existsSync(TECTONIC_BUNDLED)) {
    const version = getVersion(TECTONIC_BUNDLED);
    if (version) {
      return { status: "available", path: TECTONIC_BUNDLED, version, source: "bundled" };
    }
  }

  try {
    const which = execFileSync("which", ["tectonic"], { encoding: "utf-8", timeout: 3000 }).trim();
    if (which) {
      const version = getVersion(which);
      return { status: "available", path: which, version, source: "path" };
    }
  } catch {}

  return { status: "missing", path: null, version: null, source: null };
}
