// check: t5-csv — RFC4180-ish parsing
import { pathToFileURL } from "node:url";
const dir = process.argv[2];
let parseCSV;
try {
  ({ parseCSV } = await import(pathToFileURL(`${dir}/csv.js`).href));
} catch (e) {
  console.log(`FAIL: could not import csv.js: ${e.message}`);
  process.exit(1);
}
if (typeof parseCSV !== "function") {
  console.log("FAIL: parseCSV is not exported as a function");
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fails = [];
const cases = [
  ["a,b,c", [["a", "b", "c"]]],
  ['a,"b,c",d', [["a", "b,c", "d"]]],
  ['"he said ""hi""",x', [['he said "hi"', "x"]]],
  ["a,b\nc,d", [["a", "b"], ["c", "d"]]],
  ["a,b\n", [["a", "b"]]],
  ['"line1\nline2",z', [["line1\nline2", "z"]]],
  ["", [[""]]],
];
try {
  for (const [input, want] of cases) {
    let got;
    try {
      got = parseCSV(input);
    } catch (e) {
      fails.push(`parseCSV(${JSON.stringify(input)}) threw: ${e.message}`);
      continue;
    }
    if (!eq(got, want)) fails.push(`parseCSV(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
} catch (e) {
  fails.push(`threw: ${e.message}`);
}
if (fails.length) {
  console.log("FAIL: " + fails.join("; "));
  process.exit(1);
}
console.log("PASS: parseCSV correct on quotes/commas/embedded-newlines");
