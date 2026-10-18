#!/usr/bin/env node
// Generate evals/RESULTS.md from evals/results.json.
//
// Usage: node evals/report.mjs [--in evals/results.json] [--out evals/RESULTS.md]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let inFile = path.join(__dirname, "results.json");
let outFile = path.join(__dirname, "RESULTS.md");
for (const a of process.argv.slice(2)) {
  const [k, v] = a.split("=");
  if (k === "--in") inFile = path.resolve(v);
  if (k === "--out") outFile = path.resolve(v);
}

const data = JSON.parse(fs.readFileSync(inFile, "utf8"));
const runs = data.runs || [];
const meta = data.meta || {};

const num = (n, d = 0) => Number(n || 0).toFixed(d);
const money = (n) => `$${Number(n || 0).toFixed(4)}`;

function aggregate(rows) {
  const n = rows.length;
  const succ = rows.filter((r) => r.success).length;
  const sum = (f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
  const avg = (f) => (n ? sum(f) / n : 0);
  const errs = rows.filter((r) => r.status !== "ok").length;
  return {
    n, succ,
    successRate: n ? (succ / n) * 100 : 0,
    avgWallSec: avg((r) => r.wallSec),
    totalWallSec: sum((r) => r.wallSec),
    totalInput: sum((r) => r.usage.input),
    totalOutput: sum((r) => r.usage.output),
    totalCache: sum((r) => r.usage.cacheRead + r.usage.cacheWrite),
    totalTokens: sum((r) => r.usage.totalTokens),
    totalCost: sum((r) => r.usage.costUSD),
    avgCost: avg((r) => r.usage.costUSD),
    avgTokens: avg((r) => r.usage.totalTokens),
    totalDelegates: sum((r) => r.delegateCount),
    totalEscalations: sum((r) => r.escalations),
    errors: errs,
  };
}

const byArm = {};
for (const r of runs) (byArm[r.arm] = byArm[r.arm] || []).push(r);
const armKeys = Object.keys(byArm).sort();

const lines = [];
lines.push("# pi-files orchestrator eval — results");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("| field | value |");
lines.push("| --- | --- |");
lines.push(`| run id | \`${meta.runId || "n/a"}\` |`);
lines.push(`| repo commit | \`${meta.repoCommit || "n/a"}\` |`);
lines.push(`| provider / model | \`${meta.provider || "?"}\` / \`${meta.model || "?"}\` |`);
lines.push(`| tasks | ${meta.taskCount ?? "?"} |`);
lines.push(`| per-run timeout | ${meta.perRunTimeoutSec ?? "?"}s |`);
lines.push(`| runs recorded | ${runs.length} |`);
lines.push(`| total wall time | ${num(runs.reduce((a, r) => a + r.wallSec, 0), 1)}s |`);
if (meta.note) lines.push(`| run note | ${meta.note} |`);
lines.push("");
lines.push("## Method (short)");
lines.push("");
lines.push("Each task runs twice in a fresh scratch dir seeded from the same fixture:");
lines.push("");
lines.push("- **ARM A — single agent:** `pi --provider <p> --model <m> --print --mode json --no-extensions --no-skills --no-context-files`");
lines.push("- **ARM B — orchestrator:** the same invocation **without** the disable flags, so the globally-installed orchestrator extension auto-loads and owns planning + delegation.");
lines.push("");
lines.push("Pass/fail comes only from an external grader script (`evals/checks/<id>.mjs`, exit 0 = pass) that runs in the scratch dir and is never visible to the agent. Token/cost numbers are parsed from the `--mode json` event stream (`message_end` usage), delegated work included only as far as the parent session observes it. See `README.md` for the full method and limits.");
lines.push("");

for (const ak of armKeys) {
  const rows = byArm[ak];
  const agg = aggregate(rows);
  lines.push(`## ARM ${ak} — ${rows[0] ? rows[0].armLabel : ak}`);
  lines.push("");
  lines.push(`Runs: **${agg.n}** · Passed: **${agg.succ}/${agg.n} (${num(agg.successRate, 0)}%)** · Errors/timeouts: ${agg.errors}`);
  lines.push("");
  lines.push(`Total cost **${money(agg.totalCost)}** · avg cost/run ${money(agg.avgCost)} · avg tokens/run ${num(agg.avgTokens)} · avg wall ${num(agg.avgWallSec, 1)}s`);
  lines.push("");
  lines.push(`Total delegates: ${agg.totalDelegates} · total escalation signals: ${agg.totalEscalations}`);
  lines.push("");
  lines.push("| task | diff | pass | wall (s) | in tok | out tok | cache tok | cost | turns | deleg. | escal. | status |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| ${r.taskId} | ${r.difficulty} | ${r.success ? "✅" : "❌"} | ${num(r.wallSec, 1)} | ${r.usage.input} | ${r.usage.output} | ${r.usage.cacheRead + r.usage.cacheWrite} | ${money(r.usage.costUSD)} | ${r.turns} | ${r.delegateCount} | ${r.escalations} | ${r.status} |`
    );
  }
  lines.push("");
}

lines.push("## Head-to-head");
lines.push("");
lines.push("| metric | " + armKeys.map((k) => `ARM ${k}`).join(" | ") + " |");
lines.push("| --- | " + armKeys.map(() => "---").join(" | ") + " |");
const aggs = armKeys.map((k) => aggregate(byArm[k]));
const hm = (label, fn) => lines.push(`| ${label} | ` + aggs.map(fn).join(" | ") + " |");
hm("success rate", (a) => `${num(a.successRate, 0)}%`);
hm("passes / runs", (a) => `${a.succ}/${a.n}`);
hm("avg wall (s)", (a) => num(a.avgWallSec, 1));
hm("total cost", (a) => money(a.totalCost));
hm("avg cost / run", (a) => money(a.avgCost));
hm("avg tokens / run", (a) => num(a.avgTokens));
hm("total delegates", (a) => String(a.totalDelegates));
hm("total escalations", (a) => String(a.totalEscalations));
hm("errors / timeouts", (a) => String(a.errors));
lines.push("");

const failures = runs.filter((r) => !r.success || r.status !== "ok");
if (failures.length) {
  lines.push("## Failures & anomalies");
  lines.push("");
  for (const r of failures) {
    lines.push(`- \`${r.taskId}\` arm ${r.arm}: status=${r.status} pass=${r.success} — ${r.check.output.split("\n")[0] || "(no grader output)"}${r.upstreamErrors.length ? ` — upstream: ${r.upstreamErrors[0].slice(0, 120)}` : ""}`);
  }
  lines.push("");
} else {
  lines.push("## Failures & anomalies");
  lines.push("");
  lines.push("None in the recorded run: every run completed with `status=ok` and passed its grader.");
  lines.push("");
  lines.push("One grader caveat carried over from an earlier pass: in the first full run, ARM A failed `t5-csv` on the assertion `parseCSV(\"\") === [[\"\"]]`, because the original prompt did not specify empty-input semantics and the agent returned `[]` instead. The task prompt was tightened to state the convention explicitly (the grader was left untouched) and `t5-csv` was re-run for both arms — both now pass. See the run note above.");
  lines.push("");
}

lines.push("## Limits");
lines.push("");
lines.push("- **Single model, single seed.** n is tiny; treat percentages as directional, not statistically meaningful.");
lines.push("- **ARM B token accounting is a lower bound.** The orchestrator's child/sub-agent token usage is not surfaced in the parent `--mode json` event stream, so ARM B cost under-counts whatever the delegated specialists consumed.");
lines.push("- **Noisy provider.** `opencode-go` occasionally returns upstream 5xx (`auto_retry_end`); such runs are recorded with `status=upstream-error` and count as failures rather than being retried.");
lines.push("- **Grader is a smoke test.** The success checks verify observable behaviour, not code quality, so a passing run can still be ugly.");
lines.push("");
lines.push("Full discussion in `evals/README.md`.");
lines.push("");

fs.writeFileSync(outFile, lines.join("\n"));
console.log(`wrote ${outFile} (${lines.length} lines)`);
