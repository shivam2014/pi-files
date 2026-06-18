export interface TectonicDetection {
  status: "available" | "missing";
  path: string | null;
  version: string | null;
  source: "bundled" | "path" | null;
}

export interface CommandInfo {
  path: string | null;
  version: string | null;
}

export interface TexliveDetection {
  status: "existing-usable" | "existing-partial" | "missing";
  reason: string;
  activeBinDir: string | null;
  texmfroot: string | null;
  commands: Record<string, CommandInfo>;
  missingRequired: string[];
  missingRecommended: string[];
  knownTexBinDirs: string[];
  searchPath: string;
}

export interface SmokeTest {
  attempted: boolean;
  passed: boolean;
  command?: string[];
  exitCode?: number;
  reason?: string;
  log?: string;
}

export interface CompileAttempt {
  compiler: "tectonic" | "texlive";
  command: string[];
  exitCode: number | null;
  pdfPath: string;
  pdfExists: boolean;
  log: string;
  skipped?: boolean;
  reason?: string;
}

export interface TectonicSuitability {
  suitable: boolean;
  reasons: string[];
  scannedFiles: string[];
}

export interface CompileResult {
  success: boolean;
  rootFile: string;
  pdfPath: string;
  texlive: TexliveDetection;
  tectonic: TectonicDetection;
  attempts: CompileAttempt[];
  texProjectFiles: string[];
  suitability: TectonicSuitability;
}

export interface DoctorResult {
  ready: boolean;
  tectonic: { detection: TectonicDetection; smokeTest: SmokeTest };
  texlive: { detection: TexliveDetection; smokeTest: SmokeTest };
}

export interface CompileOptions {
  compiler?: "auto" | "tectonic" | "texlive";
  engine?: "pdflatex" | "xelatex" | "lualatex";
  outputDirectory?: string;
}
