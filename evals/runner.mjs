#!/usr/bin/env node
// pi-files evaluation runner.
//
// Runs every task in tasks.json through two arms and records metrics:
//   ARM A  single agent, no orchestrator, no extensions/skills/context files
//   ARM B  default extensions (orchestrator auto-loaded)
//
// Each run happens in a fresh scratch dir seeded from evals/fixtures/<id>/.
// Results are appended to results.json after every run, so a killed runner
// still leaves partial results on disk.
//
// Usage:
//   node evals/runner.mjs                      # all tasks, both arms
//   node evals/runner.mjs --tasks t1-hello,t3-range-bug
//   node evals/runner.mjs --arms A
//   node evals/runner.mjs --timeout 420 --scratch /tmp/evalrun
//
// Long runs: launch in background and poll results.json / the log file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..");

const DEFAULTS = {
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  timeoutSec: 300,
  scratch: process.env.EVAL_SCRATCH || "/tmp/evalrun",
  out: path.join(EVALS_DIR, "results.json"),
  log: path.join(EVALS_DIR, "runner.log"),
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, arms: ["A", "B"], tasks: null, runId: null, limit: null };
  for (const a of argv) {
    const [k, v] = a.split("=");
    if (k === "--tasks") out.tasks = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
    else if (k === "--arms") out.arms = v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (k === "--timeout") out.timeoutSec = Number(v);
    else if (k === "--scratch") out.scratch = v;
    else if (k === "--out") out.out = path.resolve(v);
    else if (k === "--log") out.log = path.resolve(v);
    else if (k === "--provider") out.provider = v;
    else if (k === "--model") out.model = v;
    else if (k === "--runid") out.runId = v;
    else if (k === "--limit") out.limit = Number(v);
    else if (k === "--help" || k === "-h") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 22).join("\n")); process.exit(0); }
  }
  return out;
}

const ARMS = {
  A: { label: "single-agent", base: ["--no-extensions", "--no-skills", "--no-context-files"] },
  B: { label: "orchestrator", base: [] },
};

function ts() { return new Date().toISOString(); }

function makeLogger(logFile) {
  let fd = null;
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fd = fs.openSync(logFile, "a"); } catch {}
  return (msg) => {
    const line = `[${ts()}] ${msg}`;
    console.log(line);
    if (fd !== null) { try { fs.writeSync(fd, line + "\n"); } catch {} }
  };
}

function runCommand(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 60000 });
  return (r.stdout || "").trim();
}

// Run `pi` detached so we can time it out and kill the whole process group.
function runPi(args, cwd, timeoutMs, outFile, errFile) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const outFd = fs.openSync(outFile, "w");
    const errFd = fs.openSync(errFile, "w");
    const t0 = Date.now();
    let child;
    let timedOut = false;
    let graceTimer = null;
    let done = false;
    try {
      child = spawn(process.env.PI_BIN || "pi", args, {
        cwd, env: process.env, detached: true, stdio: ["ignore", outFd, errFd],
      });
    } catch (e) {
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      resolve({ code: null, signal: null, timedOut: false, wallMs: 0, spawnError: e.message });
      return;
    }
    const hardTimer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      graceTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10000);
    }, timeoutMs);

    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      resolve({ code, signal, timedOut, wallMs: Date.now() - t0, spawnError: null });
    };
    child.on("exit", (code, signal) => finish(code, signal));
    child.on("error", (err) => { try { fs.closeSync(outFd); } catch {}; try { fs.closeSync(errFd); } catch {}; done = true; clearTimeout(hardTimer); resolve({ code: null, signal: null, timedOut, wallMs: Date.now() - t0, spawnError: err.message }); });
  });
}

function parseJsonl(file) {
  const m = {
    sessionId: null, cwd: null, turns: 0, assistantMessages: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0,
    toolCalls: {}, toolCallTotal: 0, toolErrors: 0,
    delegates: [], specialists: [], askOrchestrator: 0, escalations: 0,
    upstreamErrors: [], stopReasons: [], willRetry: false, finalText: "", events: 0,
  };
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return m; }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    m.events++;
    const t = o.type;
    if (t === "session") { m.sessionId = o.id || null; m.cwd = o.cwd || null; }
    else if (t === "turn_end") m.turns++;
    else if (t === "message_end") {
      const msg = o.message || {};
      if (msg.role === "assistant") {
        m.assistantMessages++;
        const u = msg.usage || {};
        m.input += u.input || 0;
        m.output += u.output || 0;
        m.cacheRead += u.cacheRead || 0;
        m.cacheWrite += u.cacheWrite || 0;
        m.totalTokens += u.totalTokens || 0;
        m.cost += (u.cost && u.cost.total) || 0;
        if (msg.stopReason) m.stopReasons.push(msg.stopReason);
        const content = msg.content || [];
        const texts = [];
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          if (c.type === "text" && c.text) texts.push(c.text);
          if (c.type === "toolCall" || c.type === "tool_use") {
            const name = c.name || c.toolName || "unknown";
            m.toolCalls[name] = (m.toolCalls[name] || 0) + 1;
            m.toolCallTotal++;
            if (name === "delegate") {
              const a = c.arguments || c.args || {};
              if (a.specialist) m.delegates.push(a.specialist);
              if (a.specialist) m.specialists.push(a.specialist);
            }
            if (name === "ask_orchestrator") m.askOrchestrator++;
          }
        }
        if (texts.length) m.finalText = texts.join("\n");
      } else if (msg.role === "toolResult" && msg.isError) m.toolErrors++;
    } else if (t === "tool_execution_end") {
      if (o.isError) m.toolErrors++;
    } else if (t === "auto_retry_end" && o.success === false) {
      m.upstreamErrors.push(o.finalError || `retry attempt ${o.attempt} failed`);
    } else if (t === "agent_end") {
      m.willRetry = !!o.willRetry;
    }
  }
  // Escalation signals surfaced as text inside delegate results.
  const esc = raw.match(/recommend=(investigate|plan|review)/g) || [];
  m.escalations = m.askOrchestrator + new Set(esc).size;
  return m;
}

function runCheck(task, scratchDir) {
  const checkPath = path.join(EVALS_DIR, "checks", task.check);
  const r = spawnSync(process.execPath, [checkPath, scratchDir], { cwd: scratchDir, encoding: "utf8", timeout: 120000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  return { success: r.status === 0, exitCode: r.status, output: out.slice(0, 800) };
}

function listFiles(dir) {
  const out = [];
  const skip = new Set([".sessions", "node_modules", ".git", ".pi"]);
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

function seedScratch(task, scratchDir) {
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  const fixture = path.join(EVALS_DIR, "fixtures", task.id);
  if (fs.existsSync(fixture)) fs.cpSync(fixture, scratchDir, { recursive: true });
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const runId = cfg.runId || new Date().toISOString().replace(/[:.]/g, "-");
  const log = makeLogger(cfg.log);
  const tasksFile = JSON.parse(fs.readFileSync(path.join(EVALS_DIR, "tasks.json"), "utf8"));
  let tasks = tasksFile.tasks;
  if (cfg.tasks) tasks = tasks.filter((t) => cfg.tasks.includes(t.id));
  if (cfg.limit) tasks = tasks.slice(0, cfg.limit);
  const commit = runCommand("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"]) || "unknown";
  const timeoutMs = cfg.timeoutSec * 1000;

  log(`runId=${runId} commit=${commit} provider=${cfg.provider} model=${cfg.model}`);
  log(`tasks=${tasks.map((t) => t.id).join(",")} arms=${cfg.arms.join(",")} timeout=${cfg.timeoutSec}s`);

  const results = {
    meta: {
      runId, startedAt: ts(), repoCommit: commit,
      provider: cfg.provider, model: cfg.model, perRunTimeoutSec: cfg.timeoutSec,
      arms: ARMS, scratchBase: cfg.scratch, taskCount: tasks.length,
    },
    runs: [],
  };

  const persist = () => {
    results.meta.finishedAt = ts();
    fs.writeFileSync(cfg.out, JSON.stringify(results, null, 2));
  };
  persist();

  for (const task of tasks) {
    for (const armKey of cfg.arms) {
      const arm = ARMS[armKey];
      const scratchDir = path.join(cfg.scratch, runId, task.id, `arm-${armKey}`);
      const outFile = path.join(scratchDir, ".pi-events.jsonl");
      const errFile = path.join(scratchDir, ".pi-stderr.log");
      seedScratch(task, scratchDir);

      const args = [
        "--provider", cfg.provider, "--model", cfg.model,
        "--print", "--mode", "json",
        "--session-dir", path.join(scratchDir, ".sessions"),
        ...arm.base,
        task.prompt,
      ];
      log(`RUN ${task.id} arm=${armKey} (${arm.label}) -> ${scratchDir}`);
      const run = await runPi(args, scratchDir, timeoutMs, outFile, errFile);
      const metrics = parseJsonl(outFile);
      const check = runCheck(task, scratchDir);
      const files = listFiles(scratchDir);

      let status = "ok";
      if (run.spawnError) status = "error";
      else if (run.timedOut) status = "timeout";
      else if (metrics.upstreamErrors.length && metrics.assistantMessages === 0) status = "upstream-error";
      else if (run.code !== 0) status = "error";

      const record = {
        runId, taskId: task.id, difficulty: task.difficulty, arm: armKey, armLabel: arm.label,
        startedAt: ts(), wallMs: run.wallMs, wallSec: +(run.wallMs / 1000).toFixed(2),
        status, success: status === "ok" && check.success,
        piExitCode: run.code, piSignal: run.signal, timedOut: run.timedOut, spawnError: run.spawnError,
        check: { exitCode: check.exitCode, output: check.output },
        usage: {
          input: metrics.input, output: metrics.output, cacheRead: metrics.cacheRead,
          cacheWrite: metrics.cacheWrite, totalTokens: metrics.totalTokens, costUSD: +metrics.cost.toFixed(6),
        },
        turns: metrics.turns, assistantMessages: metrics.assistantMessages,
        toolCalls: metrics.toolCalls, toolCallTotal: metrics.toolCallTotal,
        delegateCount: metrics.delegates.length, specialists: metrics.delegates,
        askOrchestrator: metrics.askOrchestrator, escalations: metrics.escalations,
        upstreamErrors: metrics.upstreamErrors, willRetry: metrics.willRetry,
        stopReasons: metrics.stopReasons,
        filesCreatedByAgent: files.filter((f) => !f.startsWith(".pi-")),
        finalText: metrics.finalText.slice(0, 600),
        scratchDir,
        command: `pi ${args.slice(0, -1).join(" ")} "<prompt>"`,
        events: metrics.events,
      };
      results.runs.push(record);
      persist();
      log(`DONE ${task.id} arm=${armKey} status=${status} success=${record.success} wall=${record.wallSec}s in=${metrics.input} out=${metrics.output} cost=$${record.usage.costUSD} delegates=${record.delegateCount} escalations=${record.escalations} :: ${check.output.split("\n")[0]}`);
    }
  }

  log(`ALL DONE. results -> ${cfg.out}`);
  const ok = results.runs.filter((r) => r.success).length;
  log(`summary: ${ok}/${results.runs.length} successful runs`);
  persist();
}

main().catch((e) => { console.error("RUNNER CRASHED:", e); process.exit(1); });
