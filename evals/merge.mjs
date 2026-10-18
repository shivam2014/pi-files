#!/usr/bin/env node
// Merge several results.json files into one, keyed by `taskId::arm`.
// Later files win. Used to fold a targeted re-run back into the main results
// file without re-running the whole suite.
//
// Usage: node evals/merge.mjs a.json b.json --out=evals/results.json

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let out = null;
let note = null;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--out=")) out = path.resolve(a.slice(6));
  else if (a === "--out") out = path.resolve(args[++i]);
  else if (a.startsWith("--note=")) note = a.slice(7);
  else if (a === "--note") note = args[++i];
  else if (!a.startsWith("--")) inputs.push(path.resolve(a));
}
if (!inputs.length || !out) {
  console.error("usage: node evals/merge.mjs <a.json> [b.json ...] --out=<path>");
  process.exit(2);
}

const byKey = new Map();
let meta = null;
const provenance = [];
for (const f of inputs) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!meta) meta = d.meta;
  provenance.push({ file: f, runId: d.meta?.runId, runs: (d.runs || []).length });
  for (const r of d.runs || []) byKey.set(`${r.taskId}::${r.arm}`, r);
}

const runs = [...byKey.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.arm < b.arm ? -1 : 1));
const merged = {
  meta: {
    ...meta,
    mergedAt: new Date().toISOString(),
    mergedFrom: provenance,
    note: note || meta.note,
    totalRuns: runs.length,
  },
  runs,
};
fs.writeFileSync(out, JSON.stringify(merged, null, 2));
console.log(`wrote ${out}: ${runs.length} runs from ${inputs.length} file(s)`);
