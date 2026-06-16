import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TexliveDetection } from "./types";

const TINYTEX_BIN = "/Users/shivam94/Documents/Resume/texlive/bin/universal-darwin";
const REQUIRED = ["latexmk", "pdflatex", "kpsewhich"] as const;
const RECOMMENDED = ["xelatex", "lualatex", "biber"] as const;
const ALL = [...REQUIRED, ...RECOMMENDED] as const;

function buildSearchPath(): string {
  const paths = [TINYTEX_BIN, "/Library/TeX/texbin"];
  try {
    const dirs = readdirSync("/usr/local/texlive");
    for (const dir of dirs) {
      const binDir = `/usr/local/texlive/${dir}/bin`;
      try {
        for (const arch of readdirSync(binDir)) paths.push(`${binDir}/${arch}`);
      } catch {}
    }
  } catch {}
  const currentPath = process.env.PATH || "";
  return [...paths, ...currentPath.split(":").filter(Boolean)].join(":");
}

function checkTool(tool: string, searchPath: string): { path: string | null; version: string | null } {
  try {
    const p = execFileSync("which", [tool], { env: { PATH: searchPath }, encoding: "utf-8", timeout: 3000 }).trim();
    if (!p) return { path: null, version: null };
    let version: string | null = null;
    try {
      const args = tool === "latexmk" ? ["-norc", "-v"] : ["--version"];
      const v = execFileSync(p, args, { env: { PATH: searchPath }, encoding: "utf-8", timeout: 5000 });
      version = v.split("\n")[0]?.trim() || null;
    } catch {}
    return { path: p, version };
  } catch {
    return { path: null, version: null };
  }
}

export function detectTexlive(): TexliveDetection {
  const searchPath = buildSearchPath();
  const commands: Record<string, { path: string | null; version: string | null }> = {};
  for (const tool of ALL) commands[tool] = checkTool(tool, searchPath);

  let texmfroot: string | null = null;
  if (commands.kpsewhich.path) {
    try {
      const out = execFileSync(commands.kpsewhich.path, ["-var-value=TEXMFROOT"], {
        env: { PATH: searchPath }, encoding: "utf-8", timeout: 5000,
      }).trim();
      texmfroot = out || null;
    } catch {}
  }

  const missingRequired = REQUIRED.filter(t => !commands[t].path);
  const missingRecommended = RECOMMENDED.filter(t => !commands[t].path);
  const activeBinDir = commands.pdflatex.path ? dirname(commands.pdflatex.path) : commands.kpsewhich.path ? dirname(commands.kpsewhich.path) : null;

  let status: TexliveDetection["status"];
  let reason: string;
  if (!commands.pdflatex.path && !commands.kpsewhich.path) {
    status = "missing";
    reason = "No TeX Live tools found on PATH or known locations";
  } else if (missingRequired.length > 0) {
    status = "existing-partial";
    reason = `Missing required tools: ${missingRequired.join(", ")}`;
  } else {
    status = "existing-usable";
    reason = "All required TeX tools available";
  }

  return {
    status, reason, activeBinDir, texmfroot, commands,
    missingRequired, missingRecommended,
    knownTexBinDirs: [TINYTEX_BIN, "/Library/TeX/texbin"],
    searchPath,
  };
}
