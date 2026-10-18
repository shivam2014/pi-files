// check: t7-refactor-multifile — util.js extracted, both modules re-export identical behaviour
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const dir = process.argv[2];
if (!fs.existsSync(`${dir}/util.js`)) {
  console.log("FAIL: util.js was not created");
  process.exit(1);
}
let a, b;
try {
  a = await import(pathToFileURL(`${dir}/a.js`).href);
  b = await import(pathToFileURL(`${dir}/b.js`).href);
} catch (e) {
  console.log(`FAIL: could not import a.js/b.js: ${e.message}`);
  process.exit(1);
}
if (typeof a.formatFromA !== "function" || typeof b.formatFromB !== "function") {
  console.log("FAIL: formatFromA / formatFromB exports missing");
  process.exit(1);
}
const fails = [];
const cases = [
  [["john", "doe"], "John Doe"],
  [["  jane  ", "  SMITH "], "Jane SMITH"],
  [["solo", ""], "Solo"],
  [["", "x"], "X"],
  [[null, "y"], "Y"],
];
for (const [args, want] of cases) {
  for (const [name, fn] of [["formatFromA", a.formatFromA], ["formatFromB", b.formatFromB]]) {
    let got;
    try {
      got = fn(...args);
    } catch (e) {
      fails.push(`${name}(${JSON.stringify(args)}) threw: ${e.message}`);
      continue;
    }
    if (got !== want) fails.push(`${name}(${JSON.stringify(args)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
const aSrc = fs.readFileSync(`${dir}/a.js`, "utf8");
const bSrc = fs.readFileSync(`${dir}/b.js`, "utf8");
if (/function formatName/.test(aSrc) || /function formatName/.test(bSrc)) {
  fails.push("duplicated formatName still defined in a.js/b.js");
}
if (!/from\s+["']\.\/util\.js["']/.test(aSrc) || !/from\s+["']\.\/util\.js["']/.test(bSrc)) {
  fails.push("a.js/b.js do not both import from ./util.js");
}
if (fails.length) {
  console.log("FAIL: " + fails.join("; "));
  process.exit(1);
}
console.log("PASS: shared util.js extracted and behaviour preserved");
