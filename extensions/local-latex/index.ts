import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compileLatex, checkTectonicSuitability } from "./compile";
import { runDoctor } from "./doctor";

function formatCompileResult(r: any): string {
  if (r.success) {
    const attempt = r.attempts.find((a: any) => a.exitCode === 0 && a.pdfExists);
    return `✅ Compiled successfully\nPDF: ${r.pdfPath}\nEngine: ${attempt?.compiler || "unknown"}`;
  }
  const lines = ["❌ Compilation failed"];
  for (const a of r.attempts) {
    if (a.skipped) {
      lines.push(`  - ${a.compiler}: skipped (${a.reason})`);
    } else {
      lines.push(`  - ${a.compiler}: exit ${a.exitCode}, pdf ${a.pdfExists ? "found" : "not found"}`);
      if (a.log) {
        // Show last 500 chars of log
        const tail = a.log.slice(-500);
        lines.push(`    Log tail: ${tail.slice(0, 200)}...`);
      }
    }
  }
  lines.push(`\nRoot file: ${r.rootFile}`);
  lines.push(`TeX Live: ${r.texlive.status}`);
  lines.push(`Tectonic: ${r.tectonic.status}`);
  if (!r.suitability.suitable) {
    lines.push(`\n⚠️  Tectonic suitability issues:`);
    for (const reason of r.suitability.reasons) {
      lines.push(`  - ${reason}`);
    }
  }
  return lines.join("\n");
}

function formatDoctorResult(r: any): string {
  const lines: string[] = [];
  lines.push(`# LaTeX Doctor Report`);
  lines.push(`\n**Overall: ${r.ready ? "✅ Ready" : "❌ Not ready"}**\n`);

  lines.push(`## Tectonic`);
  lines.push(`Status: ${r.tectonic.detection.status}`);
  if (r.tectonic.detection.path) lines.push(`Path: ${r.tectonic.detection.path}`);
  if (r.tectonic.detection.version) lines.push(`Version: ${r.tectonic.detection.version}`);
  lines.push(`Smoke test: ${r.tectonic.smokeTest.passed ? "✅ passed" : r.tectonic.smokeTest.attempted ? "❌ failed" : "⏭️ skipped"}`);

  lines.push(`\n## TeX Live`);
  lines.push(`Status: ${r.texlive.detection.status}`);
  if (r.texlive.detection.activeBinDir) lines.push(`Bin dir: ${r.texlive.detection.activeBinDir}`);
  if (r.texlive.detection.texmfroot) lines.push(`TEXMFROOT: ${r.texlive.detection.texmfroot}`);
  lines.push(`Commands:`);
  for (const [tool, info] of Object.entries(r.texlive.detection.commands)) {
    const infoObj = info as any;
    lines.push(`  - ${tool}: ${infoObj.path || "❌ missing"}`);
  }
  lines.push(`Smoke test: ${r.texlive.smokeTest.passed ? "✅ passed" : r.texlive.smokeTest.attempted ? "❌ failed" : "⏭️ skipped"}`);

  return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
  // latex-compile
  pi.registerTool({
    name: "latex-compile",
    label: "LaTeX Compile",
    description: "Compile a .tex file to PDF using local TeX Live or Tectonic",
    promptSnippet: "latex-compile: Compile .tex files to PDF",
    promptGuidelines: [
      "Use latex-compile to compile .tex → PDF",
      "Auto-mode tries TeX Live first, falls back to Tectonic if project is suitable",
      "Two-pass pdflatex for cross-references",
    ],
    parameters: Type.Object({
      tex_file: Type.String({ description: "Path to the .tex file to compile" }),
      compiler: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("tectonic"),
        Type.Literal("texlive"),
      ])),
      engine: Type.Optional(Type.Union([
        Type.Literal("pdflatex"),
        Type.Literal("xelatex"),
        Type.Literal("lualatex"),
      ])),
      output_directory: Type.Optional(Type.String({ description: "Output directory for PDF" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = compileLatex(params.tex_file, {
        compiler: params.compiler as any,
        engine: params.engine as any,
        outputDirectory: params.output_directory,
      });
      return {
        content: [{ type: "text", text: formatCompileResult(result) }],
        details: result,
      };
    },
  });

  // latex-doctor
  pi.registerTool({
    name: "latex-doctor",
    label: "LaTeX Doctor",
    description: "Check if LaTeX engines (TeX Live, Tectonic) are installed and working. Runs a smoke test compile.",
    promptSnippet: "latex-doctor: Diagnose LaTeX installation",
    promptGuidelines: [
      "Run latex-doctor first if you're unsure whether LaTeX is set up",
      "Shows paths, versions, and smoke test results per engine",
    ],
    parameters: Type.Object({
      json: Type.Optional(Type.Boolean({ description: "Return raw JSON output" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = runDoctor();
      return {
        content: [{
          type: "text",
          text: params.json ? JSON.stringify(result, null, 2) : formatDoctorResult(result),
        }],
        details: result,
      };
    },
  });

  // latex-tectonic-suitability
  pi.registerTool({
    name: "latex-tectonic-suitability",
    label: "Tectonic Suitability",
    description: "Check if a LaTeX project is compatible with the Tectonic compiler",
    promptSnippet: "latex-tectonic-suitability: Check Tectonic compatibility",
    parameters: Type.Object({
      tex_file: Type.String({ description: "Path to the .tex file to analyze" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = checkTectonicSuitability(params.tex_file);
      const text = result.suitable
        ? `✅ Project is suitable for Tectonic\nScanned ${result.scannedFiles.length} file(s)`
        : `❌ Project is NOT suitable for Tectonic:\n${result.reasons.map(r => `  - ${r}`).join("\n")}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });
}
