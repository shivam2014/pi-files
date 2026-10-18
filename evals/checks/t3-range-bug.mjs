// check: t3-range-bug — inclusive range
import { pathToFileURL } from "node:url";
const dir = process.argv[2];
let range;
try {
  ({ range } = await import(pathToFileURL(`${dir}/range.js`).href));
} catch (e) {
  console.log(`FAIL: could not import range.js: ${e.message}`);
  process.exit(1);
}
if (typeof range !== "function") {
  console.log("FAIL: range is not exported as a function");
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fails = [];
const cases = [
  [[1, 5], [1, 2, 3, 4, 5]],
  [[3, 3], [3]],
  [[5, 1], []],
  [[0, 2], [0, 1, 2]],
  [[-2, 1], [-2, -1, 0, 1]],
];
try {
  for (const [args, want] of cases) {
    const got = range(...args);
    if (!eq(got, want)) fails.push(`range(${args}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
} catch (e) {
  fails.push(`threw: ${e.message}`);
}
if (fails.length) {
  console.log("FAIL: " + fails.join("; "));
  process.exit(1);
}
console.log("PASS: range inclusive + edges correct");
