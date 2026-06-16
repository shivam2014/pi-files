import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectTectonic } from "./detect-tectonic";
import { detectTexlive } from "./detect-texlive";
import type { DoctorResult, SmokeTest, TexliveDetection } from "./types";

const SMOKE_TEX = [
  "\\documentclass{article}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  "Smoke test. \\(E = mc^2\\).",
  "\\end{document}",
].join("\n");

function runTexliveSmoke(detection: TexliveDetection): SmokeTest {
  const tmpDir = mkdtempSync(join(tmpdir(), "latex-doctor-"));
  const texPath = join(tmpDir, "smoke.tex");
  writeFileSync(texPath, SMOKE_TEX, "utf-8");

  const latexmk = detection.commands.latexmk?.path;
  const pdflatex = detection.commands.pdflatex?.path;

  if (!latexmk && !pdflatex) {
    return { attempted: false, passed: false, reason: "Neither latexmk nor pdflatex available" };
  }

  const cmd = latexmk
    ? [latexmk, "-norc", "-pdf", "-interaction=nonstopmode", "-halt-on-error", texPath]
    : [pdflatex!, "-interaction=nonstopmode", "-halt-on-error", texPath];

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: tmpDir,
    env: { ...process.env, PATH: detection.searchPath },
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });

  const pdfPath = join(tmpDir, "smoke.pdf");
  return {
    attempted: true,
    passed: result.status === 0 && existsSync(pdfPath),
    command: cmd,
    exitCode: result.status ?? undefined,
    log: ((result.stdout || "") + (result.stderr || "")).slice(-8000),
  };
}

function runTectonicSmoke(tectonicPath: string): SmokeTest {
  const tmpDir = mkdtempSync(join(tmpdir(), "tectonic-doctor-"));
  const texPath = join(tmpDir, "smoke.tex");
  writeFileSync(texPath, SMOKE_TEX, "utf-8");

  const cmd = [tectonicPath, "-X", "compile", "--outdir", tmpDir, "--outfmt", "pdf", "--print", "--untrusted", "smoke.tex"];

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: tmpDir,
    env: { ...process.env, TECTONIC_UNTRUSTED_MODE: "1" },
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });

  const pdfPath = join(tmpDir, "smoke.pdf");
  return {
    attempted: true,
    passed: result.status === 0 && existsSync(pdfPath),
    command: cmd,
    exitCode: result.status ?? undefined,
    log: ((result.stdout || "") + (result.stderr || "")).slice(-8000),
  };
}

export function runDoctor(): DoctorResult {
  const tectonic = detectTectonic();
  const texlive = detectTexlive();

  const tectonicSmoke = tectonic.status === "available" && tectonic.path
    ? runTectonicSmoke(tectonic.path)
    : { attempted: false, passed: false, reason: "Tectonic not available" };

  const texliveSmoke = texlive.status !== "missing"
    ? runTexliveSmoke(texlive)
    : { attempted: false, passed: false, reason: "TeX Live not available" };

  const ready = tectonicSmoke.passed || texliveSmoke.passed;

  return {
    ready,
    tectonic: { detection: tectonic, smokeTest: tectonicSmoke as SmokeTest },
    texlive: { detection: texlive, smokeTest: texliveSmoke as SmokeTest },
  };
}
