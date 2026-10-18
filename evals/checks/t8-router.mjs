// check: t8-router
import { pathToFileURL } from "node:url";
const dir = process.argv[2];
let createRouter;
try {
  ({ createRouter } = await import(pathToFileURL(`${dir}/router.js`).href));
} catch (e) {
  console.log(`FAIL: could not import router.js: ${e.message}`);
  process.exit(1);
}
if (typeof createRouter !== "function") {
  console.log("FAIL: createRouter is not exported as a function");
  process.exit(1);
}
const fails = [];
try {
  const r = createRouter();
  const hUser = () => "user";
  const hPost = () => "post";
  const hList = () => "list";
  r.add("GET", "/users/:id", hUser);
  r.add("GET", "/users/:id/posts/:postId", hPost);
  r.add("get", "/users", hList);

  const m1 = r.match("GET", "/users/42");
  if (!m1 || m1.handler !== hUser || m1.params.id !== "42") fails.push(`match /users/42 => ${JSON.stringify(m1)}`);

  const m2 = r.match("GET", "/users/42/posts/7");
  if (!m2 || m2.handler !== hPost || m2.params.id !== "42" || m2.params.postId !== "7") fails.push(`match nested => ${JSON.stringify(m2)}`);

  const m3 = r.match("get", "/users");
  if (!m3 || m3.handler !== hList) fails.push(`method case-insensitive / static => ${JSON.stringify(m3)}`);

  const m4 = r.match("POST", "/users/42");
  if (m4 !== null) fails.push(`method mismatch should be null, got ${JSON.stringify(m4)}`);

  const m5 = r.match("GET", "/nothing/here/at/all");
  if (m5 !== null) fails.push(`no route should be null, got ${JSON.stringify(m5)}`);

  const m6 = r.match("GET", "/users/a%20b");
  if (!m6 || m6.params.id !== "a b") fails.push(`url decoding => ${JSON.stringify(m6)}`);
} catch (e) {
  fails.push(`threw: ${e.message}`);
}
if (fails.length) {
  console.log("FAIL: " + fails.join("; "));
  process.exit(1);
}
console.log("PASS: router matching/params/method correct");
