// check: t1-hello — hello.txt must contain exactly "hi"
import fs from "node:fs";
const dir = process.argv[2];
const p = `${dir}/hello.txt`;
if (!fs.existsSync(p)) {
  console.log("FAIL: hello.txt does not exist");
  process.exit(1);
}
const raw = fs.readFileSync(p, "utf8");
if (raw !== "hi") {
  console.log(`FAIL: content is ${JSON.stringify(raw)}, expected "hi"`);
  process.exit(1);
}
console.log("PASS: hello.txt === 'hi'");
