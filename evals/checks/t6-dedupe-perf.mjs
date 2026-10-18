// check: t6-dedupe-perf — correctness + O(n) timing on 200k ints
import { pathToFileURL } from "node:url";
const dir = process.argv[2];
let dedupe;
try {
  ({ dedupe } = await import(pathToFileURL(`${dir}/dedupe.js`).href));
} catch (e) {
  console.log(`FAIL: could not import dedupe.js: ${e.message}`);
  process.exit(1);
}
if (typeof dedupe !== "function") {
  console.log("FAIL: dedupe is not exported as a function");
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fails = [];
try {
  if (!eq(dedupe([1, 2, 1, 3, 2, 4]), [1, 2, 3, 4])) fails.push("basic correctness failed");
  if (!eq(dedupe(["a", "a", "b"]), ["a", "b"])) fails.push("string dedupe failed");
  if (!eq(dedupe([]), [])) fails.push("empty array failed");
} catch (e) {
  fails.push(`correctness threw: ${e.message}`);
}
let ms = null;
try {
  const N = 200000;
  const big = new Array(N);
  for (let i = 0; i < N; i++) big[i] = i % (N / 2);
  const t0 = Date.now();
  const res = dedupe(big);
  ms = Date.now() - t0;
  if (res.length !== N / 2) fails.push(`big dedupe length ${res.length} !== ${N / 2}`);
} catch (e) {
  fails.push(`perf run threw: ${e.message}`);
}
if (ms !== null && ms >= 300) fails.push(`took ${ms}ms for 200k, want < 300ms`);
if (fails.length) {
  console.log("FAIL: " + fails.join("; "));
  process.exit(1);
}
console.log(`PASS: dedupe correct, 200k in ${ms}ms`);
