// check: t4-add-tests — node --test suite must exist and pass, covering add and sub
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const dir = process.argv[2];
const testFile = `${dir}/calc.test.js`;
if (!fs.existsSync(testFile)) {
  console.log("FAIL: calc.test.js not found");
  process.exit(1);
}
const src = fs.readFileSync(testFile, "utf8");
const hasNodeTest = /node:test/.test(src);
const coversAdd = /add/.test(src);
const coversSub = /sub/.test(src);
const calcUnchanged = fs.readFileSync(`${dir}/calc.js`, "utf8").includes("return a + b;");
if (!hasNodeTest) { console.log("FAIL: calc.test.js does not use node:test"); process.exit(1); }
if (!coversAdd || !coversSub) { console.log("FAIL: tests do not reference both add and sub"); process.exit(1); }
if (!calcUnchanged) { console.log("FAIL: calc.js was modified"); process.exit(1); }
const r = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8", timeout: 60000 });
const out = `${r.stdout || ""}${r.stderr || ""}`;
const passMatch = /# pass (\d+)/.exec(out);
const failMatch = /# fail (\d+)/.exec(out);
const pass = passMatch ? Number(passMatch[1]) : 0;
const fail = failMatch ? Number(failMatch[1]) : 0;
if (r.status !== 0 || fail > 0) {
  console.log(`FAIL: node --test status=${r.status} pass=${pass} fail=${fail}\n${out.slice(-800)}`);
  process.exit(1);
}
if (pass < 3) {
  console.log(`FAIL: only ${pass} tests passed, want >= 3`);
  process.exit(1);
}
console.log(`PASS: node --test pass=${pass} fail=${fail}`);
