// check: t2-fizzbuzz
import { pathToFileURL } from "node:url";
const dir = process.argv[2];
let mod;
try {
  mod = await import(pathToFileURL(`${dir}/fizzbuzz.js`).href);
} catch (e) {
  console.log(`FAIL: could not import fizzbuzz.js: ${e.message}`);
  process.exit(1);
}
const { fizzbuzz } = mod;
if (typeof fizzbuzz !== "function") {
  console.log("FAIL: fizzbuzz is not exported as a function");
  process.exit(1);
}
const fails = [];
try {
  const out = fizzbuzz(15);
  if (!Array.isArray(out)) fails.push("fizzbuzz(15) is not an array");
  else {
    if (out.length !== 15) fails.push(`length ${out.length} !== 15`);
    if (out[0] !== "1") fails.push(`out[0] = ${JSON.stringify(out[0])}, want "1"`);
    if (out[2] !== "Fizz") fails.push(`out[2] = ${JSON.stringify(out[2])}, want "Fizz"`);
    if (out[4] !== "Buzz") fails.push(`out[4] = ${JSON.stringify(out[4])}, want "Buzz"`);
    if (out[14] !== "FizzBuzz") fails.push(`out[14] = ${JSON.stringify(out[14])}, want "FizzBuzz"`);
    if (out[10] !== "11") fails.push(`out[10] = ${JSON.stringify(out[10])}, want "11"`);
  }
  if (fizzbuzz(0).length !== 0) fails.push("fizzbuzz(0) should be empty");
} catch (e) {
  fails.push(`threw: ${e.message}`);
}
if (fails.length) {
  console.log("FAIL: " + fails.join("; "));
  process.exit(1);
}
console.log("PASS: fizzbuzz correct");
