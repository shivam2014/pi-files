import { mkdirSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import type { SubagentDiagnostic, DelegationMetrics } from "./types.ts";

export interface CaptureDiagnosticInput {
  output: string;
  turns: number;
  toolCallTrail: Array<{ tool: string; isError?: boolean }>;
  blockedCalls?: Array<{ tool: string; target: string; reason: string; timestamp: number }>;
  elapsedMs: number;
  specialist: string;
  task: string;
  sessionId: string;
  metrics: DelegationMetrics;
  agentDir?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  httpStatus?: number;
  findingsText?: string;
}

/**
 * Captures a diagnostic for a subagent session if the subagent exhibited
 * silent failure (no tool calls, no meaningful output) or crashed outright.
 *
 * Returns null if the subagent behaved normally.
 */
export function captureDiagnostic(input: CaptureDiagnosticInput): SubagentDiagnostic | null {
  const toolCalls = input.toolCallTrail?.length || 0;

  // Silent failure: 0 tool calls, >= 1 turn, empty/short output
  // Note: if output is empty AND turns >= 1, it counts as BOTH crash and silent failure
  const isSilentFailure =
    toolCalls === 0 &&
    input.turns >= 1 &&
    (!input.output || input.output.trim().length < 50);

  // Crash: 0 tool calls, no output at all (regardless of turns)
  const isCrash =
    toolCalls === 0 &&
    (!input.output || input.output.trim().length === 0);

  if (isSilentFailure || isCrash) {
    // Build diagnostic
    const outputPreview = redactSecrets(truncatePreview(input.output || "", 200));

    return {
      schemaVersion: 1,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
      specialist: input.specialist,
      task: input.task,
      turns: input.turns,
      toolCalls: toolCalls,
      elapsedMs: input.elapsedMs,
      crashed: isCrash,
      outputPreview,
      metrics: { ...input.metrics },
      kind: isCrash ? 'crash' : 'silent_failure',
      diagnosticId: `${new Date().toISOString()}-${input.specialist}-${simpleHash(input.task)}`,
      agentDir: input.agentDir,
      model: input.model,
      stopReason: input.stopReason,
      errorMessage: input.errorMessage,
      httpStatus: input.httpStatus,
      findingsText: input.findingsText || undefined,
    } as SubagentDiagnostic;
  }

  // Tool errors: any tool call in the trail has isError === true
  const toolErrorEntries = input.toolCallTrail?.filter(e => e.isError === true) ?? [];
  if (toolErrorEntries.length > 0) {
    const outputPreview = redactSecrets(truncatePreview(input.output || "", 200));
    const erroredTools = toolErrorEntries.map(e => e.tool);

    return {
      schemaVersion: 1,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
      specialist: input.specialist,
      task: input.task,
      turns: input.turns,
      toolCalls: toolCalls,
      elapsedMs: input.elapsedMs,
      crashed: false,
      outputPreview,
      metrics: { ...input.metrics },
      kind: 'tool_errors',
      diagnosticId: `${new Date().toISOString()}-${input.specialist}-${simpleHash(input.task)}`,
      agentDir: input.agentDir,
      model: input.model,
      stopReason: input.stopReason,
      errorMessage: input.errorMessage,
      httpStatus: input.httpStatus,
      findingsText: input.findingsText || undefined,
    } as SubagentDiagnostic;
  }

  // Blocked calls: scope guard blocked one or more tool calls
  if (input.blockedCalls && input.blockedCalls.length > 0) {
    const outputPreview = redactSecrets(truncatePreview(input.output || "", 200));

    return {
      schemaVersion: 1,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
      specialist: input.specialist,
      task: input.task,
      turns: input.turns,
      toolCalls: toolCalls,
      elapsedMs: input.elapsedMs,
      crashed: false,
      outputPreview,
      metrics: { ...input.metrics },
      kind: 'blocked_calls',
      diagnosticId: `${new Date().toISOString()}-${input.specialist}-${simpleHash(input.task)}`,
      agentDir: input.agentDir,
      model: input.model,
      stopReason: input.stopReason,
      errorMessage: input.errorMessage,
      httpStatus: input.httpStatus,
      findingsText: input.findingsText || undefined,
    } as SubagentDiagnostic;
  }

  return null;
}

export function truncatePreview(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/**
 * Simple string hash for generating short filenames.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * Check if diagnostics are enabled via env var.
 * Defaults to enabled. Set PI_ORCHESTRATOR_DIAGNOSTICS=off to disable.
 */
export function isDiagnosticsEnabled(): boolean {
  return process.env.PI_ORCHESTRATOR_DIAGNOSTICS !== "off";
}

/**
 * Get diagnostics directory path under agent directory.
 */
export function getDiagnosticsDir(agentDir: string): string {
  return join(agentDir, "extensions", "orchestrator", "diagnostics");
}

/**
 * Persist a diagnostic to disk at a date-based path.
 * Uses atomic write: write to .tmp, then renameSync to final path.
 * Creates parent directories recursively.
 *
 * Path format:
 *   {dir}/extensions/orchestrator/diagnostics/YYYY-MM-DD/{sessionId}/incident-{timestamp}-{specialist}-{shortHash}.json
 */
export function persistDiagnostic(dir: string, diagnostic: SubagentDiagnostic): string {
  const date = diagnostic.timestamp.slice(0, 10); // YYYY-MM-DD from ISO
  const sessionId = diagnostic.sessionId;
  const safeSpecialist = diagnostic.specialist.replace(/[^a-zA-Z0-9_-]/g, "_");
  const shortHash = simpleHash(diagnostic.timestamp + diagnostic.specialist);
  // Format timestamp for filename: replace colons with dots
  const tsForFile = diagnostic.timestamp.replace(/[:]/g, ".").replace(/[TZ]/g, "-").replace(/--/g, "-").replace(/-$/g, "");

  const diagnosticDir = join(dir, "extensions", "orchestrator", "diagnostics", date, sessionId);
  const fileName = `incident-${tsForFile}-${safeSpecialist}-${shortHash}.json`;
  const finalPath = join(diagnosticDir, fileName);
  const tmpPath = finalPath + ".tmp";

  // Create parent directories recursively
  mkdirSync(dirname(tmpPath), { recursive: true });

  // Atomic write: write to .tmp, then rename
  writeFileSync(tmpPath, JSON.stringify(diagnostic, null, 2), "utf-8");
  renameSync(tmpPath, finalPath);

  return finalPath;
}

/**
 * Clean up old diagnostic directories older than maxAgeDays.
 * Scans {dir}/diagnostics/ for YYYY-MM-DD subdirectories.
 * Returns count of deleted directories.
 */
export function cleanupOldDiagnostics(dir: string, maxAgeDays: number = 30): number {
  const diagnosticsDir = join(dir, "extensions", "orchestrator", "diagnostics");
  if (!existsSync(diagnosticsDir)) return 0;

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  const entries = readdirSync(diagnosticsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Match YYYY-MM-DD pattern
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

    const dirDate = new Date(entry.name + "T00:00:00Z");
    if (isNaN(dirDate.getTime())) continue;

    if (now - dirDate.getTime() > maxAgeMs) {
      const fullPath = join(diagnosticsDir, entry.name);
      rmSync(fullPath, { recursive: true, force: true });
      deletedCount++;
    }
  }

  return deletedCount;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9]{32,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_-]{20,}/gi, "Bearer [REDACTED]")
    .replace(/token[=:]["']?[A-Za-z0-9_-]{20,}/gi, "token=[REDACTED]");
}
