#!/usr/bin/env node
// Grader self-test: proves each check fails on the untouched fixture and passes
// on a known-good reference solution. Catches broken graders before they poison
// the eval.
//
// Usage: node evals/selftest.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, "tasks.json"), "utf8")).tasks;
const BASE = process.env.EVAL_SELFTEST_DIR || "/tmp/evalrun/selftest";

const SOLUTIONS = {
  "t1-hello": { "hello.txt": "hi" },
  "t2-fizzbuzz": {
    "fizzbuzz.js": `export function fizzbuzz(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    if (i % 15 === 0) out.push("FizzBuzz");
    else if (i % 3 === 0) out.push("Fizz");
    else if (i % 5 === 0) out.push("Buzz");
    else out.push(String(i));
  }
  return out;
}
`,
  },
  "t3-range-bug": {
    "range.js": `export function range(start, end) {
  const out = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}
`,
  },
  "t4-add-tests": {
    "calc.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { add, sub } from "./calc.js";
test("add positives", () => assert.equal(add(2, 3), 5));
test("add negatives", () => assert.equal(add(-2, -3), -5));
test("add zero", () => assert.equal(add(0, 0), 0));
test("sub positives", () => assert.equal(sub(5, 3), 2));
test("sub negatives", () => assert.equal(sub(-1, -4), 3));
test("sub zero", () => assert.equal(sub(0, 0), 0));
`,
  },
  "t5-csv": {
    "csv.js": `export function parseCSV(text) {
  if (text.endsWith("\\n")) text = text.slice(0, -1);
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}
`,
  },
  "t6-dedupe-perf": {
    "dedupe.js": `export function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}
`,
  },
  "t7-refactor-multifile": {
    "util.js": `export function formatName(first, last) {
  const parts = [first, last]
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return parts.join(" ");
}
`,
    "a.js": `import { formatName } from "./util.js";
export function formatFromA(first, last) { return formatName(first, last); }
`,
    "b.js": `import { formatName } from "./util.js";
export function formatFromB(first, last) { return formatName(first, last); }
`,
  },
  "t8-router": {
    "router.js": `export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), segments: pattern.split("/").filter(Boolean), handler });
    },
    match(method, path) {
      const m = method.toUpperCase();
      const segs = path.split("/").filter(Boolean);
      for (const r of routes) {
        if (r.method !== m || r.segments.length !== segs.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < r.segments.length; i++) {
          const rs = r.segments[i];
          if (rs.startsWith(":")) params[rs.slice(1)] = decodeURIComponent(segs[i]);
          else if (rs !== segs[i]) { ok = false; break; }
        }
        if (ok) return { handler: r.handler, params };
      }
      return null;
    },
  };
}
`,
  },
};

function seed(task, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(__dirname, "fixtures", task.id), dir, { recursive: true });
}

function check(task, dir) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "checks", task.check), dir], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n")[0] };
}

let failures = 0;
for (const task of tasks) {
  const dir = path.join(BASE, task.id);
  seed(task, dir);
  const before = check(task, dir);
  for (const [name, content] of Object.entries(SOLUTIONS[task.id] || {})) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const after = check(task, dir);
  const good = !before.ok && after.ok;
  if (!good) failures++;
  console.log(`${good ? "OK  " : "BAD "} ${task.id}  reject-unsolved=${!before.ok} accept-solution=${after.ok}  (before: ${before.out})`);
}
console.log(failures ? `\n${failures} grader(s) FAILED self-test` : `\nall ${tasks.length} graders valid`);
process.exit(failures ? 1 : 0);
