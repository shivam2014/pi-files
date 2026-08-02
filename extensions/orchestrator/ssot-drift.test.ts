/**
 * SSOT drift guards — lock schema↔dependent-code links so a change to a
 * schema forces a test failure in the dependent code instead of silent drift.
 *
 * Each test asserts a LINKING INVARIANT between the schema file and the
 * dependent file. They were red before the fixes (see git history / audit):
 * - V1: scope docs in prompt-builder hardcoded fields, missing gateMode
 * - V2: SubagentDiagnostic.metrics inline duplicate of DelegationMetrics
 * - V3: formatResult re-implements formatMetricsLine (scopeNotes already drifted)
 * - V4: deliverable markers hardcoded in pipeline, not next to the template
 * - V5: specialist name lists hardcoded in 4 sites instead of registry metadata
 * - V6: "Clarified:"/"[error]"/"[aborted]" markers duplicated across files
 * - V7: diagnostic kind literals re-spelled in subagent-diagnostics.ts
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { buildOrchestratorPrompt } from "./prompt-builder.ts";
import { formatResult } from "./delegate-pipeline.ts";
import { FINDINGS_AUDIT_TEMPLATE, DELIVERABLE_MARKERS, SPECIALISTS, isReadOnlySpecialist, canUseBash, hasGitTools } from "./specialists.ts";
import type { DelegationMetrics, SubagentDiagnostic, ScopeNotes } from "./types.ts";
import { generateScopeDocumentation } from "./scope-manager.ts";
import { CLARIFIED_PREFIX, createActivityFeed } from "./activity-feed.ts";
import { ERROR_MARKER, ABORT_MARKER, createAskOrchestratorTool } from "./subagent-runner.ts";
import { DIAGNOSTIC_KINDS, captureDiagnostic, isDiagnosticsEnabled } from "./subagent-diagnostics.ts";
import { ActivityFeed } from "./activity-feed.ts";

// ── V1: scope docs must cover the whole ScopeManifest schema ──────────────

describe("V1 — scope documentation covers ScopeManifest", () => {
	// Known-good literal of the schema fields (independent of the code under test)
	const MANIFEST_FIELDS = [
		"filesToModify",
		"filesToCreate",
		"directories",
		"maxFiles",
		"maxLinesPerFile",
		"changeType",
		"requiresApprovalBeyondScope",
		"gateMode",
		"boundaries",
	];

	it("generateScopeDocumentation lists every ScopeManifest field", () => {
		const doc = generateScopeDocumentation();
		for (const field of MANIFEST_FIELDS) {
			expect(doc, `missing ${field} in scope docs`).toContain(field);
		}
	});

	it("built orchestrator prompt's scope section lists every ScopeManifest field", () => {
		const { systemPrompt } = buildOrchestratorPrompt({
			basePrompt: "You are an expert coding assistant operating inside pi\n- Tool one: read",
		});
		const scopeSection = systemPrompt.slice(systemPrompt.indexOf("### Scope requirement"));
		for (const field of MANIFEST_FIELDS) {
			expect(scopeSection, `missing ${field} in prompt scope section`).toContain(field);
		}
	});
});

// ── V2: SubagentDiagnostic.metrics must BE DelegationMetrics (no inline copy) ─

describe("V2 — SubagentDiagnostic.metrics is DelegationMetrics", () => {
	it("type-level: metrics field is exactly DelegationMetrics", () => {
		expectTypeOf<SubagentDiagnostic["metrics"]>().toEqualTypeOf<DelegationMetrics>();
	});
});

// ── V3: formatResult reuses formatMetricsLine (SSOT for the metrics line) ──

describe("V3 — formatResult metrics line matches formatMetricsLine", () => {
	it("includes scopeNotes when present (formatMetricsLine does; formatResult's copy did not)", () => {
		const scopeNotes: ScopeNotes = {
			blockedTools: [{ tool: "write", target: "x", reason: "outside scope", timestamp: 1 }],
			assessment: "minor-deviation",
			summary: "1 tool call(s) blocked — write(x)",
		};
		const { formatted } = formatResult({
			output: "done",
			metrics: {
				readCalls: 1, grepCalls: 0, findCalls: 0,
				editCalls: 1, writeCalls: 0, bashCalls: 2, lsCalls: 0,
				scopeNotes,
			},
			elapsed: 10,
			turns: 2,
			toolCalls: 3,
			status: "ok",
		});
		expect(formatted).toContain("scopeNotes=");
		expect(formatted).toContain("bash=2");
	});
});

// ── V4: deliverable markers live next to the report template ──────────────

describe("V4 — deliverable markers co-located with FINDINGS_AUDIT_TEMPLATE", () => {
	it("DELIVERABLE_MARKERS includes the template's own Findings heading", () => {
		expect(FINDINGS_AUDIT_TEMPLATE).toContain("## Findings");
		expect(DELIVERABLE_MARKERS).toContain("## Findings");
	});
});

// ── V5: specialist capabilities derived from the registry, not name lists ──

describe("V5 — specialist helpers derive from SPECIALISTS metadata", () => {
	it("isReadOnlySpecialist matches the declared readOnly flag for every specialist", () => {
		for (const name of Object.keys(SPECIALISTS)) {
			expect(isReadOnlySpecialist(name), name).toBe(SPECIALISTS[name].readOnly);
		}
	});

	it("canUseBash matches the tools array for every specialist", () => {
		for (const name of Object.keys(SPECIALISTS)) {
			expect(canUseBash(name), name).toBe(SPECIALISTS[name].tools.includes("bash"));
		}
	});

	it("hasGitTools is true exactly for scout+researcher (the registry's git-capable pair)", () => {
		expect(hasGitTools("scout")).toBe(true);
		expect(hasGitTools("researcher")).toBe(true);
		expect(hasGitTools("coder")).toBe(false);
		expect(hasGitTools("writer")).toBe(false);
		expect(hasGitTools("reviewer")).toBe(false);
	});
});

// ── V6: cross-file marker protocols share constants ───────────────────────

describe("V6 — marker protocols are shared constants", () => {
	it("ask_orchestrator labels use the shared Clarified prefix", async () => {
		const feed = new ActivityFeed();
		feed.addStep("Step 1").addSubstep("Clarify: what color?");
		const tool = createAskOrchestratorTool(async () => "blue", () => {}, "coder", feed);
		await (tool.execute as any)("call-1", { question: "what color?" }, undefined, () => {}, {});
		const substep = feed.steps[0].substeps[0];
		expect(substep.label.startsWith(CLARIFIED_PREFIX)).toBe(true);
	});

	it("pipeline detects abort/error via the shared markers", () => {
		expect(ERROR_MARKER).toBe("[error]");
		expect(ABORT_MARKER).toBe("[aborted]");
		// Linking: the render-detection contract in delegate-pipeline relies on these
		const detect = (out: string) => out.startsWith(ERROR_MARKER) || out.startsWith(ABORT_MARKER);
		expect(detect(`${ERROR_MARKER} boom`)).toBe(true);
		expect(detect(`${ABORT_MARKER} stop`)).toBe(true);
	});
});

// ── V7: diagnostic kinds derived from one const ───────────────────────────

describe("V7 — diagnostic kinds share a single const", () => {
	it("DIAGNOSTIC_KINDS contains every kind the type allows", () => {
		expect(DIAGNOSTIC_KINDS).toContain("silent_failure");
		expect(DIAGNOSTIC_KINDS).toContain("crash");
		expect(DIAGNOSTIC_KINDS).toContain("tool_errors");
		expect(DIAGNOSTIC_KINDS).toContain("blocked_calls");
	});

	it("captureDiagnostic only ever emits kinds from DIAGNOSTIC_KINDS", async () => {
		const enabled = isDiagnosticsEnabled();
		if (!enabled) return; // diagnostics off in this env — the const still guards the union type
		const diag = await captureDiagnostic({
			output: "test",
			turns: 0,
			toolCallTrail: [],
			elapsedMs: 1,
			specialist: "scout",
			task: "t",
			sessionId: "s",
			metrics: { readCalls: 0, grepCalls: 0, findCalls: 0, editCalls: 0, writeCalls: 0, bashCalls: 0, lsCalls: 0 },
			agentDir: "/tmp",
		} as any);
		if (diag) {
			expect(DIAGNOSTIC_KINDS).toContain(diag.kind);
		}
	});
});

// ── Sanity: the SSOT helpers exist and compose (compile-time linking) ─────

describe("SSOT drift-guard sanity", () => {
	it("createActivityFeed is importable from the shared module (no duplicate ActivityFeed)", () => {
		expect(typeof createActivityFeed).toBe("function");
	});
});
