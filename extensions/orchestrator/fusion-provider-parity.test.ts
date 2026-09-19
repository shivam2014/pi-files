import { describe, it, expect } from "vitest";
import http from "node:http";
import { getModel } from "@earendil-works/pi-ai/compat";
import { FusionPipeline, FusionRunContext, getSessionAttributionHeaders, parseJudgeFromResponse } from "./fusion-pipeline";

/**
 * fusion-provider-parity — real-seam regression tests for the two fusion bugs.
 *
 * Why a real HTTP server: fusion-tool.test.ts / fusion-pipeline.test.ts both
 * `vi.mock("@earendil-works/pi-ai/compat")`, which stubs the provider and can
 * therefore NEVER observe the request headers the gateway actually receives.
 * Here we stand up a capturing localhost server and drive the real
 * FusionPipeline so the emitted headers (Bug A) and the judge fail-soft path
 * (Bug B) are exercised end to end.
 *
 * Bug A — fusion bypasses pi's SDK provider wrapper and calls complete()
 *         directly, so opencode-go requests reach the gateway without
 *         `x-opencode-session` and get 400 MissingSessionID. Fix: attach the same
 *         attribution headers pi's normal path sends, on the FIRST request (no retry).
 * Bug B — a prose judge reply makes parseJudgeAnalysis -> null and the ENTIRE
 *         fusion result (including good panel output) is discarded.
 */

const SESSION_ID = "parity-session-01";
const PANEL_MODEL_ID = "glm-5.1";
const JUDGE_PROSE =
	"The panel broadly agrees the plan is viable, but I want to flag two contradictions " +
	"around the migration ordering and at least one blind spot regarding rollback. " +
	"Overall the recommendation is to sequence the schema change before the deploy.";

const VALID_ANALYSIS = {
	consensus: ["agreed point"],
	contradictions: [],
	unique_insights: [],
	blind_spots: [],
	recommendations: ["proceed"],
};

// pi-coding-agent does not re-export provider-attribution from its package root,
// so resolve the deep module by path (same approach the repro harness uses).
const PI_CA_ROOT = `${process.env.HOME}/.pi/agent/extensions/node_modules/@earendil-works/pi-coding-agent`;
const ATTR_PATH = `${PI_CA_ROOT}/dist/core/provider-attribution.js`;

type RequestRecord = {
	method: string;
	path: string;
	headers: Record<string, string | undefined>;
	body: string;
	payload: any;
	status: number;
};

type Server = { server: http.Server; requests: RequestRecord[]; port: number };

/** Localhost server that records every request it receives. */
function startCapturingServer(
	handle: (rec: RequestRecord, res: http.ServerResponse) => void,
): Promise<Server> {
	const requests: RequestRecord[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const headers: Record<string, string | undefined> = {};
			for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v as string;
			let payload: any = null;
			try {
				payload = JSON.parse(body);
			} catch {
				/* keep raw body */
			}
			const rec: RequestRecord = { method: req.method ?? "", path: req.url ?? "", headers, body, payload, status: 200 };
			requests.push(rec);
			handle(rec, res);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: (server.address() as any).port }));
	});
}

function writeSse(res: http.ServerResponse, parts: Array<Record<string, unknown>>): void {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	const chunk = (choices: unknown[]) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices })}\n\n`;
	let first = true;
	for (const part of parts) {
		const delta = { ...(first ? { role: "assistant" } : {}), ...part };
		first = false;
		res.write(chunk([{ index: 0, delta, finish_reason: null }]));
	}
	res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
	res.write("data: [DONE]\n\n");
	res.end();
}

function replyText(res: http.ServerResponse, text: string): void {
	writeSse(res, [{ content: text }]);
}

/** opencode-go gateway shape: reject requests without the session header. */
function enforceSession(rec: RequestRecord, res: http.ServerResponse): boolean {
	if (!rec.headers["x-opencode-session"]) {
		rec.status = 400;
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ message: "Request is missing x-opencode-session", type: "MissingSessionID" }));
		return true;
	}
	return false;
}

function opencodeModel(port: number) {
	const base = getModel("opencode-go", PANEL_MODEL_ID);
	if (!base) throw new Error(`catalog missing opencode-go/${PANEL_MODEL_ID}`);
	return { ...base, baseUrl: `http://127.0.0.1:${port}/v1` };
}

/** Same api/baseUrl as an opencode model, but a provider that must NOT receive the session header. */
function nonOpencodeModel(port: number) {
	return { ...opencodeModel(port), provider: "some-other-provider" };
}

function fakeRegistry(model: any) {
	return {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test", headers: {} }),
		find: () => model,
		getAvailable: () => [model],
	};
}

function makePipeline(model: any): FusionPipeline {
	return new FusionPipeline(fakeRegistry(model), config, new FusionRunContext());
}

const config = {
	enabled: true,
	panel: [],
	judge: "",
	maxPanelModels: 3,
	temperature: 0.3,
	maxTokensPerPanel: 256,
	maxTokensForJudge: 256,
};

async function loadNormalPathHeaders(model: any, sessionId: string) {
	const mod = await import(/* @vite-ignore */ ATTR_PATH);
	const merge = mod.mergeProviderAttributionHeaders as (
		model: any,
		settingsManager: any,
		sessionId: string | undefined,
		...sources: any[]
	) => Record<string, string> | undefined;
	return merge(model, { getEnableInstallTelemetry: () => false }, sessionId, {}, {});
}

// ─── Bug A: session attribution header parity ─────────────

describe("Bug A — session attribution on the real request", () => {
	it("A-happy: opencode-go panel request carries x-opencode-session == sessionId and succeeds", async () => {
		const { server, requests, port } = await startCapturingServer((rec, res) => {
			if (enforceSession(rec, res)) return;
			replyText(res, "panel ok");
		});
		try {
			const model = opencodeModel(port);
			const pipeline = makePipeline(model);
			const { succeeded } = await pipeline.panelPhase([model], "sys", "user", undefined, undefined, SESSION_ID);

			expect(succeeded).toHaveLength(1);
			// Upfront injection: the header rides the FIRST request and the call succeeds
			// without any retry, so exactly one request is issued (no doomed 400 attempt).
			expect(requests).toHaveLength(1);
			const first = requests[0];
			expect(first.headers["x-opencode-session"]).toBe(SESSION_ID);
			expect(first.headers["x-opencode-client"]).toBe("pi");
			// The single request is the one the gateway accepts.
			expect(first.status).toBe(200);
		} finally {
			server.close();
		}
	});

	it("A-happy: opencode-go judge request carries x-opencode-session == sessionId", async () => {
		const { server, requests, port } = await startCapturingServer((rec, res) => {
			if (enforceSession(rec, res)) return;
			replyText(res, `\`\`\`json\n${JSON.stringify(VALID_ANALYSIS)}\n\`\`\``);
		});
		try {
			const model = opencodeModel(port);
			const pipeline = makePipeline(model);
			// The session id is captured by panelPhase (as in the real fusion-tool flow),
			// then reused by judgePhase for the same attribution headers.
			await pipeline.panelPhase([model], "sys", "user", undefined, undefined, SESSION_ID);
			const { analysis } = await pipeline.judgePhase([{ model: "p", content: "x" }], model, undefined, undefined);

			expect(analysis).not.toBeNull();
			const attributed = requests.filter((r) => r.headers["x-opencode-session"] === SESSION_ID);
			expect(attributed.length).toBeGreaterThan(0);
		} finally {
			server.close();
		}
	});

	it("A-edge: a non-opencode provider receives NO x-opencode-session header (no leak) and still succeeds", async () => {
		const { server, requests, port } = await startCapturingServer((_rec, res) => {
			// Deliberately do NOT enforce the session header for this provider.
			replyText(res, "panel ok");
		});
		try {
			const model = nonOpencodeModel(port);
			const pipeline = makePipeline(model);
			const { succeeded } = await pipeline.panelPhase([model], "sys", "user", undefined, undefined, SESSION_ID);

			expect(succeeded).toHaveLength(1);
			expect(requests.length).toBeGreaterThan(0);
			expect(requests.every((r) => r.headers["x-opencode-session"] === undefined)).toBe(true);
			expect(requests.every((r) => r.headers["x-opencode-client"] === undefined)).toBe(true);
		} finally {
			server.close();
		}
	});

	it("A-edge: sessionId undefined -> no session header and no throw", async () => {
		const { server, requests, port } = await startCapturingServer((_rec, res) => replyText(res, "panel ok"));
		try {
			const model = opencodeModel(port);
			const pipeline = makePipeline(model);
			const { succeeded } = await pipeline.panelPhase([model], "sys", "user", undefined, undefined, undefined);

			expect(succeeded).toHaveLength(1);
			expect(requests.length).toBeGreaterThan(0);
			expect(requests.every((r) => r.headers["x-opencode-session"] === undefined)).toBe(true);
		} finally {
			server.close();
		}
	});

	it("A-regression: fusion's attributed request matches pi's normal-path headers for the same model+sessionId", async () => {
		const { server, requests, port } = await startCapturingServer((rec, res) => {
			if (enforceSession(rec, res)) return;
			replyText(res, "panel ok");
		});
		try {
			const model = opencodeModel(port);
			const expected = await loadNormalPathHeaders(model, SESSION_ID);
			expect(expected).toBeDefined();

			const pipeline = makePipeline(model);
			await pipeline.panelPhase([model], "sys", "user", undefined, undefined, SESSION_ID);

			const attributed = requests.find((r) => r.headers["x-opencode-session"] === SESSION_ID);
			expect(attributed).toBeDefined();
			expect(attributed!.headers["x-opencode-session"]).toBe(expected!["x-opencode-session"]);
			expect(attributed!.headers["x-opencode-client"]).toBe(expected!["x-opencode-client"]);
		} finally {
			server.close();
		}
	});
});

// ─── Bug B: judge fail-soft ───────────────────────────────

describe("Bug B — judge structured-output / fail-soft", () => {
	it("B-happy: a fenced JSON judge reply parses", async () => {
		const { server, port } = await startCapturingServer((_rec, res) =>
			replyText(res, `Here you go:\n\`\`\`json\n${JSON.stringify(VALID_ANALYSIS)}\n\`\`\``),
		);
		try {
			const model = opencodeModel(port);
			const pipeline = makePipeline(model);
			const { analysis } = await pipeline.judgePhase([{ model: "p", content: "x" }], model, undefined, undefined);
			expect(analysis).not.toBeNull();
			expect(analysis!.consensus).toEqual(["agreed point"]);
		} finally {
			server.close();
		}
	});

	it("B-edge: a prose-only judge reply is NOT discarded — result stays usable with panel content", async () => {
		const { server, port } = await startCapturingServer((_rec, res) => replyText(res, JUDGE_PROSE));
		try {
			const model = opencodeModel(port);
			const pipeline = makePipeline(model);
			const panel = [{ model: "deepseek", content: "Panel says: do X then Y.", reports: ["Panel says: do X then Y."] }];

			const { analysis, judgeError } = await pipeline.judgePhase(panel, model, undefined, undefined);

			// Fail-soft: non-null analysis so the caller does not throw the panel away.
			expect(analysis).not.toBeNull();
			// Judge error is recorded.
			expect(judgeError).toBeTruthy();
			// Panel content still surfaces in the final formatted result.
			const result = pipeline.formatPhase(analysis, panel, [], [model], model, judgeError);
			expect(result.content[0].text).toContain("Panel says: do X then Y.");
		} finally {
			server.close();
		}
	});

	it("B-regression: the retry request body differs from the first attempt body", async () => {
		const { server, requests, port } = await startCapturingServer((_rec, res) => replyText(res, JUDGE_PROSE));
		try {
			const model = opencodeModel(port);
			const pipeline = makePipeline(model);
			await pipeline.judgePhase([{ model: "p", content: "x" }], model, undefined, undefined);

			expect(requests.length).toBeGreaterThanOrEqual(2);
			expect(requests[1].body).not.toBe(requests[0].body);
		} finally {
			server.close();
		}
	});

	it("B-regression: JSON inside a thinking block + prose text is recovered and parsed", async () => {
		const { server, port } = await startCapturingServer((_rec, res) =>
			writeSse(res, [{ reasoning_content: JSON.stringify(VALID_ANALYSIS) }, { content: "Here is my analysis in prose." }]),
		);
		try {
			const model = opencodeModel(port);
			const pipeline = makePipeline(model);
			const { analysis } = await pipeline.judgePhase([{ model: "p", content: "x" }], model, undefined, undefined);
			expect(analysis).not.toBeNull();
			expect(analysis!.consensus).toEqual(["agreed point"]);
		} finally {
			server.close();
		}
	});

	it("B-regression: parseJudgeFromResponse recovers JSON from a thinking block when text is prose", () => {
		const response: any = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `reasoning...\n\n\`\`\`json\n${JSON.stringify(VALID_ANALYSIS)}\n\`\`\`` },
				{ type: "text", text: "Here is my analysis in prose." },
			],
			stopReason: "stop",
		};
		const analysis = parseJudgeFromResponse(response);
		expect(analysis).not.toBeNull();
		expect(analysis!.recommendations).toEqual(["proceed"]);
	});
});

// ─── Bug A (host gate): opencode detection by baseUrl host ─────
//
describe("Bug A host gate — non-opencode provider + opencode baseUrl", () => {
	// The provider name is deliberately NOT opencode*: the ONLY thing that can attach
	// the header here is the baseUrl host check, which is the branch previously
	// uncovered (every other test overrides baseUrl to 127.0.0.1).
	const modelFor = (baseUrl: string) => ({ id: "m", provider: "unknown-provider", baseUrl });

	it("A-host-happy: bare https://opencode.ai/zen/go/v1 attaches the session header", () => {
		const headers = getSessionAttributionHeaders(modelFor("https://opencode.ai/zen/go/v1"), SESSION_ID);
		expect(headers).toBeDefined();
		expect(headers!["x-opencode-session"]).toBe(SESSION_ID);
		expect(headers!["x-opencode-client"]).toBe("pi");
	});

	it("A-host-edge: *.opencode.ai subdomain (api.opencode.ai) attaches the session header", () => {
		const headers = getSessionAttributionHeaders(modelFor("https://api.opencode.ai/v1"), SESSION_ID);
		expect(headers).toBeDefined();
		expect(headers!["x-opencode-session"]).toBe(SESSION_ID);
	});

	it("A-host-regression: lookalike opencode.ai.evil.com does NOT match", () => {
		expect(getSessionAttributionHeaders(modelFor("https://opencode.ai.evil.com/v1"), SESSION_ID)).toBeUndefined();
	});

	it("A-host-regression: lookalike notopencode.ai does NOT match", () => {
		expect(getSessionAttributionHeaders(modelFor("https://notopencode.ai/v1"), SESSION_ID)).toBeUndefined();
	});

	it("A-host-control: http://127.0.0.1:<port> does NOT match (existing control)", () => {
		expect(getSessionAttributionHeaders(modelFor("http://127.0.0.1:12345/v1"), SESSION_ID)).toBeUndefined();
	});
});

// ─── Bug C: per-instance session isolation (no shared module default) ──
//
describe("session isolation — no-ctx pipelines do not share a session id", () => {
	it("A-regression: a second no-ctx pipeline does NOT inherit the first pipeline's session id", async () => {
		const { server, requests, port } = await startCapturingServer((_rec, res) => replyText(res, "ok"));
		try {
			const model = opencodeModel(port);

			// Pipeline A captures a session id via panelPhase (fresh, per-instance ctx).
			const pipelineA = new FusionPipeline(fakeRegistry(model), config, undefined);
			await pipelineA.panelPhase([model], "sys", "user", undefined, undefined, "session-A");

			// Pipeline B is a SEPARATE no-ctx pipeline that never receives a session id.
			const before = requests.length;
			const pipelineB = new FusionPipeline(fakeRegistry(model), config, undefined);
			await pipelineB.judgePhase([{ model: "p", content: "x" }], model, undefined, undefined);

			const bRequests = requests.slice(before);
			expect(bRequests.length).toBeGreaterThan(0);
			// If the two pipelines shared the old module-global default ctx, B would
			// emit "session-A" here. Isolation means B emits no session header at all.
			expect(bRequests.every((r) => r.headers["x-opencode-session"] === undefined)).toBe(true);
		} finally {
			server.close();
		}
	});
});
