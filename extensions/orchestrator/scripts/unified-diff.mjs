// @ts-nocheck — plain-JS helper; covered by the diff tests in build-system-prompt.test.ts
/**
 * unified-diff.mjs — dependency-free unified diff used by build-system-prompt.mjs.
 * Extracted so the CLI entrypoint stays small; tested through --diff.
 */
export class CaptureError extends Error {}

/** LCS-based op list: { t: " "|"-"|"+", a?, b? } with original line indices. */
export function diffOps(a, b) {
	const n = a.length;
	const m = b.length;
	const at = (i, j) => i * (m + 1) + j;
	const dp = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) ops.push({ t: " ", a: i++, b: j++ });
		else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) ops.push({ t: "-", a: i++ });
		else ops.push({ t: "+", b: j++ });
	}
	while (i < n) ops.push({ t: "-", a: i++ });
	while (j < m) ops.push({ t: "+", b: j++ });
	return ops;
}

const lineNumberAt = (ops, index, key) => {
	let count = 1;
	for (let k = 0; k < index; k++) if (ops[k].t !== (key === "a" ? "+" : "-")) count++;
	return count;
};

export function formatDiff(aLines, bLines, aName, bName, context = 3) {
	const ops = diffOps(aLines, bLines);
	const out = [`--- ${aName}`, `+++ ${bName}`];
	let pos = 0;
	while (pos < ops.length) {
		while (pos < ops.length && ops[pos].t === " ") pos++;
		if (pos >= ops.length) break;
		const start = Math.max(0, pos - context);
		let end = pos;
		while (end < ops.length) {
			if (ops[end].t !== " ") {
				end++;
				continue;
			}
			let k = end;
			while (k < ops.length && ops[k].t === " ") k++;
			if (k >= ops.length || k - end > context * 2) {
				end = Math.min(k, end + context);
				break;
			}
			end = k;
		}
		const hunk = ops.slice(start, end);
		const aCount = hunk.filter((o) => o.t !== "+").length;
		const bCount = hunk.filter((o) => o.t !== "-").length;
		out.push(`@@ -${lineNumberAt(ops, start, "a")},${aCount} +${lineNumberAt(ops, start, "b")},${bCount} @@`);
		for (const op of hunk) out.push(op.t === " " ? ` ${aLines[op.a]}` : op.t === "-" ? `-${aLines[op.a]}` : `+${bLines[op.b]}`);
		pos = end;
	}
	return out.join("\n");
}

/**
 * Pull the prompt out of a prompt-dump capture. Accepts the raw record
 * ({ systemPrompt }), a { payload: { systemPrompt } } wrapper, or a bare JSON string.
 */
export function extractCaptureText(file, readFile) {
	let data;
	try {
		data = JSON.parse(readFile(file, "utf8"));
	} catch (err) {
		throw new CaptureError(`cannot read capture ${file}: ${err.message}`);
	}
	const prompt = typeof data === "string" ? data : (data?.systemPrompt ?? data?.payload?.systemPrompt);
	if (typeof prompt !== "string" || !prompt.length) throw new CaptureError(`capture ${file} has no systemPrompt field`);
	return prompt;
}
