import { readFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join, dirname, basename, resolve, extname } from "node:path";
import { detectTectonic } from "./detect-tectonic";
import { detectTexlive } from "./detect-texlive";
import type { CompileResult, CompileOptions, CompileAttempt, TectonicSuitability, TexliveDetection } from "./types";

// Regex patterns
const ROOT_DIRECTIVE_RE = /^%\s*!TEX\s+root\s*=\s*(?<root>.+?)\s*$/m;
const PROGRAM_DIRECTIVE_RE = /^%\s*!TEX\s+program\s*=\s*(?<program>.+?)\s*$/im;
const INPUT_RE = /\\(?:input|include)\{(?<path>[^}]+)\}/g;
const PACKAGE_RE = /\\usepackage(?:\[[^\]]*\])?\{(?<packages>[^}]+)\}/g;

const COMPLEX_TECTONIC_PACKAGES = new Set([
  "asymptote", "biblatex", "glossaries", "imakeidx",
  "luacode", "makeidx", "minted", "pythontex", "shellesc",
]);

const COMPLEX_TECTONIC_COMMANDS: [RegExp, string][] = [
  [/\\(?:addbibresource|bibliography)\b/, "bibliography tooling"],
  [/\\(?:makeglossaries|makeindex|printglossary|printindex)\b/, "index or glossary tooling"],
  [/\\(?:inputminted|tikzexternalize|write18)\b/, "shell escape or externalization"],
];

const MAX_PROJECT_FILES = 50;

function readTex(path: string): string {
  return readFileSync(path, { encoding: "utf-8", flag: "r" });
}

export function resolveTexRoot(texFile: string): string {
  const texPath = resolve(texFile);
  const content = readTex(texPath);

  // Check !TEX root directive (first 20 lines)
  const lines = content.split("\n").slice(0, 20);
  for (const line of lines) {
    const m = ROOT_DIRECTIVE_RE.exec(line);
    if (m) {
      const root = m.groups!.root.trim();
      const candidate = resolve(dirname(texPath), root);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Check if this file has \documentclass
  if (/\\documentclass\b/.test(content)) return texPath;

  // Scan siblings for \documentclass
  const parentDir = dirname(texPath);
  try {
    const files = require("node:fs").readdirSync(parentDir).filter((f: string) => f.endsWith(".tex"));
    // Don't use readdirSync again, just filter from readdirSync result
    for (const f of require("node:fs").readdirSync(parentDir)) {
      if (!f.endsWith(".tex") || resolve(parentDir, f) === texPath) continue;
      const candidate = resolve(parentDir, f);
      try {
        if (/\\documentclass\b/.test(readTex(candidate))) return candidate;
      } catch {}
    }
  } catch {}

  return texPath;
}

export function projectTexFiles(rootFile: string): string[] {
  const root = resolve(rootFile);
  const pending = [root];
  const seen = new Set<string>();
  const ordered: string[] = [];

  while (pending.length > 0 && ordered.length < MAX_PROJECT_FILES) {
    const current = pending.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    ordered.push(current);

    try {
      const text = readTex(current);
      const matches = text.matchAll(INPUT_RE);
      for (const m of matches) {
        const rawPath = m.groups!.path.trim();
        if (!rawPath || rawPath.startsWith("|")) continue;
        let candidate = resolve(dirname(current), rawPath);
        if (!existsSync(candidate) && !extname(candidate)) {
          candidate = candidate + ".tex";
        }
        if (existsSync(candidate) && !seen.has(candidate)) {
          pending.push(candidate);
        }
      }
    } catch {}
  }

  return ordered;
}

export function checkTectonicSuitability(texFile: string): TectonicSuitability {
  const rootFile = resolveTexRoot(texFile);
  const files = projectTexFiles(rootFile);
  const reasons: string[] = [];

  for (const filePath of files) {
    try {
      const text = readTex(filePath);
      const lines = text.split("\n").slice(0, 20);

      // Check !TEX program directive
      for (const line of lines) {
        const m = PROGRAM_DIRECTIVE_RE.exec(line);
        if (m) {
          const program = m.groups!.program.trim().toLowerCase();
          if (program && program !== "tectonic") {
            reasons.push(`${filePath}: !TEX program asks for "${program}"`);
          }
        }
      }

      // Check packages
      const pkgMatches = text.matchAll(PACKAGE_RE);
      for (const pm of pkgMatches) {
        for (const name of pm.groups!.packages.split(",")) {
          if (COMPLEX_TECTONIC_PACKAGES.has(name.trim())) {
            reasons.push(`${filePath}: uses package "${name.trim()}" which may need TeX Live`);
          }
        }
      }

      // Check commands
      for (const [pattern, description] of COMPLEX_TECTONIC_COMMANDS) {
        if (pattern.test(text)) {
          reasons.push(`${filePath}: uses ${description}`);
        }
      }
    } catch {}
  }

  return {
    suitable: reasons.length === 0,
    reasons,
    scannedFiles: files,
  };
}

function buildTexliveCommand(
  detection: TexliveDetection,
  engine: string,
  outputDirectory: string | undefined,
  rootFile: string,
): string[] {
  const latexmk = detection.commands.latexmk?.path;
  const enginePath = detection.commands[engine]?.path;

  if (latexmk) {
    const engineFlag: Record<string, string> = {
      pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex",
    };
    const cmd = [
      latexmk, "-norc", engineFlag[engine] || "-pdf",
      "-interaction=nonstopmode", "-halt-on-error", "-synctex=1",
    ];
    if (outputDirectory) cmd.push(`-outdir=${outputDirectory}`);
    cmd.push(rootFile);
    return cmd;
  }

  if (enginePath) {
    const cmd = [
      enginePath, "-interaction=nonstopmode", "-halt-on-error", "-synctex=1",
    ];
    if (outputDirectory) cmd.push(`-output-directory=${outputDirectory}`);
    cmd.push(rootFile);
    return cmd;
  }

  throw new Error(`Neither latexmk nor ${engine} is available`);
}

function buildTectonicCommand(
  tectonicPath: string,
  outputDirectory: string | undefined,
  rootFile: string,
): string[] {
  const outDir = outputDirectory || dirname(rootFile);
  return [
    tectonicPath, "-X", "compile",
    "--outdir", outDir,
    "--outfmt", "pdf",
    "--print", "--untrusted",
    basename(rootFile),
  ];
}

function expectedPdfPath(rootFile: string, outputDirectory: string | undefined): string {
  const dir = outputDirectory || dirname(rootFile);
  return join(dir, basename(rootFile, ".tex") + ".pdf");
}

function runAttempt(
  command: string[],
  compiler: "tectonic" | "texlive",
  cwd: string,
  env: Record<string, string>,
  pdfPath: string,
): CompileAttempt {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const log = ((result.stdout || "") + (result.stderr || "")).slice(-8000);

  return {
    compiler,
    command,
    exitCode: result.status,
    pdfPath,
    pdfExists: existsSync(pdfPath),
    log,
  };
}

export function compileLatex(texFile: string, opts?: CompileOptions): CompileResult {
  const rootFile = resolveTexRoot(texFile);
  const outputDirectory = opts?.outputDirectory
    ? resolve(opts.outputDirectory)
    : undefined;
  const pdfPath = expectedPdfPath(rootFile, outputDirectory);
  const engine = opts?.engine || "pdflatex";
  const compiler = opts?.compiler || "auto";

  const tectonic = detectTectonic();
  const texlive = detectTexlive();
  const suitability = checkTectonicSuitability(texFile);
  const attempts: CompileAttempt[] = [];

  const tryTexlive = (): CompileAttempt | null => {
    if (texlive.status === "missing") {
      const attempt: CompileAttempt = {
        compiler: "texlive", command: [], exitCode: null,
        pdfPath, pdfExists: false, log: "",
        skipped: true, reason: "No TeX Live installation detected",
      };
      attempts.push(attempt);
      return null;
    }

    try {
      const cmd = buildTexliveCommand(texlive, engine, outputDirectory, rootFile);
      const attempt = runAttempt(cmd, "texlive", dirname(rootFile), { PATH: texlive.searchPath }, pdfPath);
      attempts.push(attempt);

      // Two-pass for raw engine (not latexmk)
      if (!texlive.commands.latexmk?.path && attempt.exitCode === 0) {
        const secondAttempt = runAttempt(cmd, "texlive", dirname(rootFile), { PATH: texlive.searchPath }, pdfPath);
        if (secondAttempt.pdfExists || secondAttempt.exitCode === 0) {
          attempts.push(secondAttempt);
          return secondAttempt;
        }
      }

      if (attempt.exitCode === 0 && attempt.pdfExists) return attempt;
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempt: CompileAttempt = {
        compiler: "texlive", command: [], exitCode: null,
        pdfPath, pdfExists: false, log: String(err),
        skipped: true, reason: msg,
      };
      attempts.push(attempt);
      return null;
    }
  };

  const tryTectonic = (): CompileAttempt | null => {
    if (tectonic.status === "missing") {
      const attempt: CompileAttempt = {
        compiler: "tectonic", command: [], exitCode: null,
        pdfPath, pdfExists: false, log: "",
        skipped: true, reason: "No Tectonic installation detected",
      };
      attempts.push(attempt);
      return null;
    }

    try {
      const cmd = buildTectonicCommand(tectonic.path!, outputDirectory, rootFile);
      const attempt = runAttempt(cmd, "tectonic", dirname(rootFile), { TECTONIC_UNTRUSTED_MODE: "1" }, pdfPath);
      attempts.push(attempt);
      if (attempt.exitCode === 0 && attempt.pdfExists) return attempt;
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempt: CompileAttempt = {
        compiler: "tectonic", command: [], exitCode: null,
        pdfPath, pdfExists: false, log: String(err),
        skipped: true, reason: msg,
      };
      attempts.push(attempt);
      return null;
    }
  };

  // Strategy based on compiler setting
  if (compiler === "texlive") {
    tryTexlive();
  } else if (compiler === "tectonic") {
    if (!tryTectonic() && suitability.suitable) {
      // If tectonic failed and suitable, try one more time
      tryTectonic();
    } else if (!suitability.suitable) {
      tryTexlive();
    }
  } else {
    // auto: TeX Live first, then Tectonic, then TeX Live again
    const tlResult = tryTexlive();
    if (!tlResult && suitability.suitable) {
      const tResult = tryTectonic();
      if (!tResult) {
        tryTexlive(); // retry TeX Live
      }
    }
  }

  const success = attempts.some(a => a.exitCode === 0 && a.pdfExists);

  return {
    success,
    rootFile,
    pdfPath,
    texlive,
    tectonic,
    attempts,
    texProjectFiles: projectTexFiles(rootFile),
    suitability,
  };
}
