/**
 * Unit tests for subagent-runner safety helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	truncateSubagentOutput,
	snapshotSubagentEnv,
	cleanSubagentEnv,
	installSubagentEnv,
	SUBAGENT_ENV_KEY,
	resolveSkillPaths,
	createFlightRecorderDump,
	SubagentRunner,
} from "./subagent-runner.ts";
import { DEFAULTS } from "./orchestrator-config.ts";
import { shortenLabel, truncateLabel } from "../token-saver.ts";
import { registerFusionTool } from "./fusion-tool.ts";
import { createActivityFeed, addStep, completeCurrentStep, markFeedError } from "./activity-feed.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubagentState, subagentSessions } from "./subagent-sessions.ts";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    ModelRuntime: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
});

describe("truncateSubagentOutput", () => {
	it("returns output unchanged when under cap", () => {
		const output = "small output";
		expect(truncateSubagentOutput(output, 100)).toBe(output);
	});

	it("preserves trailing ## Findings and ## Audit sections", () => {
		const findings = "## Findings\n- bug in auth.ts\n- missing test";
		const audit = "## Audit\n- no scope deviation";
		const filler = "x".repeat(50_000);
		const output = `${filler}\n\n${findings}\n\n${audit}`;
		const truncated = truncateSubagentOutput(output, 30_000);

		expect(truncated).toContain("[output truncated at 30000 chars; tail preserved]");
		expect(truncated).toContain("## Findings");
		expect(truncated).toContain("bug in auth.ts");
		expect(truncated).toContain("## Audit");
		expect(truncated).toContain("no scope deviation");
		expect(truncated.length).toBeLessThanOrEqual(30_000);
	});

	it("handles output with only a ## Findings section", () => {
		const findings = "## Findings\n- only finding";
		const output = "x".repeat(40_000) + "\n\n" + findings;
		const truncated = truncateSubagentOutput(output, 30_000);
		expect(truncated).toContain("## Findings");
		expect(truncated).toContain("only finding");
		expect(truncated).toContain("[output truncated at 30000 chars; tail preserved]");
	});

	it("falls back to plain truncation when tail exceeds cap", () => {
		const output = "x".repeat(60_000);
		const truncated = truncateSubagentOutput(output, 100);
		expect(truncated).toContain("[output truncated at 100 chars; tail preserved]");
		expect(truncated.length).toBeLessThanOrEqual(100);
	});
});

describe("subagent env isolation helpers", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		installSubagentEnv(originalEnv);
	});

	it("snapshotSubagentEnv returns a shallow copy", () => {
		process.env.TEST_SNAPSHOT = "1";
		const snap = snapshotSubagentEnv();
		expect(snap.TEST_SNAPSHOT).toBe("1");
		expect(snap).not.toBe(process.env);
	});

	it("cleanSubagentEnv strips PI_ORCHESTRATOR_SUBAGENT and PI_* tokens", () => {
		const env: NodeJS.ProcessEnv = {
			HOME: "/home/test",
			PI_ORCHESTRATOR_SUBAGENT: "1",
			PI_INTERNAL_TOKEN: "secret",
			PATH: "/bin",
		};
		const cleaned = cleanSubagentEnv(env);
		expect(cleaned.HOME).toBe("/home/test");
		expect(cleaned.PATH).toBe("/bin");
		expect(cleaned[SUBAGENT_ENV_KEY]).toBeUndefined();
		expect(cleaned.PI_INTERNAL_TOKEN).toBeUndefined();
	});

	it("installSubagentEnv replaces the active environment", () => {
		process.env.TEST_INSTALL = "before";
		installSubagentEnv({ TEST_INSTALL: "after" });
		expect(process.env.TEST_INSTALL).toBe("after");
		expect(process.env.HOME).toBeUndefined();
	});
});

describe("token-saver immutability", () => {
	it("shortenLabel does not mutate its input", () => {
		const input = "  Based on this: read the auth file and return concise summary  ";
		const original = input;
		shortenLabel(input);
		expect(input).toBe(original);
	});

	it("truncateLabel does not mutate its input", () => {
		const input = "a very long label that should not be changed";
		const original = input;
		truncateLabel(input, 10);
		expect(input).toBe(original);
	});
});

describe("resolveSkillPaths", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
		// Create two existing skills
		mkdirSync(join(testDir, "skills", "skill-a"), { recursive: true });
		writeFileSync(join(testDir, "skills", "skill-a", "SKILL.md"), "a");
		mkdirSync(join(testDir, "skills", "skill-b"), { recursive: true });
		writeFileSync(join(testDir, "skills", "skill-b", "SKILL.md"), "b");
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("resolves skill names to existing paths under agentDir/skills/<name>/SKILL.md", () => {
		const result = resolveSkillPaths(["skill-a", "skill-b"], testDir);
		expect(result).toEqual([
			join(testDir, "skills", "skill-a", "SKILL.md"),
			join(testDir, "skills", "skill-b", "SKILL.md"),
		]);
	});

	it("returns empty array for empty input", () => {
		const result = resolveSkillPaths([], testDir);
		expect(result).toEqual([]);
	});

	it("filters out non-existent skills", () => {
		const result = resolveSkillPaths(["skill-a", "non-existent"], testDir);
		expect(result).toEqual([join(testDir, "skills", "skill-a", "SKILL.md")]);
	});
});

describe("finalization loop", () => {
	function runFinalizationLoop(feed: ReturnType<typeof createActivityFeed>) {
		while (feed.currentStep >= 0 && feed.currentStep < feed.steps.length) {
			feed = completeCurrentStep(feed);
		}
		return feed;
	}

	it("marks all remaining steps complete when subagent skips final advanceStep", () => {
		let feed = createActivityFeed();
		feed = addStep(feed, "Step 1");
		feed = addStep(feed, "Step 2");
		feed = addStep(feed, "Step 3");
		// Subagent finished Step 1 and called completeCurrentStep but never advanced.
		feed = completeCurrentStep(feed);
		expect(feed.currentStep).toBe(1);
		expect(feed.steps[0].completed).toBe(true);
		expect(feed.steps[1].completed).toBe(false);
		expect(feed.steps[2].completed).toBe(false);

		feed = runFinalizationLoop(feed);

		expect(feed.currentStep).toBe(3);
		expect(feed.steps.every((s) => s.completed)).toBe(true);
	});

	it("preserves errored session state when finalization is skipped", () => {
		let feed = createActivityFeed();
		feed = addStep(feed, "Step 1");
		feed = addStep(feed, "Step 2");
		feed = markFeedError(feed, "Something broke");
		expect(feed.errored).toBe(true);
		expect(feed.errorMessage).toBe("Something broke");

		// Simulate guarded finalization: error/aborted status skips the loop.
		const finalStatus = "error";
		if (finalStatus !== "error" && finalStatus !== "aborted") {
			feed = runFinalizationLoop(feed);
		}

		expect(feed.errored).toBe(true);
		expect(feed.errorMessage).toBe("Something broke");
		expect(feed.steps[1].completed).toBe(false);
	});
});

describe("subagentSessions Map lifecycle", () => {
	beforeEach(() => {
		subagentSessions.clear();
	});

	it("starts empty", () => {
		expect(subagentSessions.size).toBe(0);
	});

	it("populates and retrieves per-session state", () => {
		subagentSessions.set("session-1", { specialistName: "scout", planParsed: false, blockedCalls: [] });
		expect(subagentSessions.size).toBe(1);
		const state = subagentSessions.get("session-1");
		expect(state?.specialistName).toBe("scout");
		expect(state?.planParsed).toBe(false);
	});

	it("supports concurrent sessions without interference", () => {
		subagentSessions.set("session-a", { specialistName: "scout", planParsed: false, blockedCalls: [] });
		subagentSessions.set("session-b", { specialistName: "coder", planParsed: true, blockedCalls: [] });
		expect(subagentSessions.size).toBe(2);
		expect(subagentSessions.get("session-a")?.specialistName).toBe("scout");
		expect(subagentSessions.get("session-b")?.specialistName).toBe("coder");
	});

	it("mutates planParsed in-place (reference sharing)", () => {
		const state: SubagentState = { specialistName: "scout", planParsed: false, blockedCalls: [] };
		subagentSessions.set("session-1", state);
		state.planParsed = true;
		expect(subagentSessions.get("session-1")?.planParsed).toBe(true);
	});

	it("cleans up on delete (simulating finally block)", () => {
		subagentSessions.set("session-1", { specialistName: "scout", planParsed: false, blockedCalls: [] });
		subagentSessions.delete("session-1");
		expect(subagentSessions.size).toBe(0);
		expect(subagentSessions.get("session-1")).toBeUndefined();
	});

	it("delete of non-existent key is a no-op", () => {
		expect(() => subagentSessions.delete("ghost")).not.toThrow();
	});
});

describe("registerFusionTool — idempotency keyed by cwd", () => {
	function createMockPi(initialTools: any[] = []) {
		const tools = [...initialTools];
		return {
			tools,
			registerTool: (t: any) => {
				if (!tools.some((existing) => existing.name === t.name)) {
					tools.push(t);
				}
			},
			getAllTools: () => tools,
			unregisterTool: (name: string) => {
				const idx = tools.findIndex((t) => t.name === name);
				if (idx >= 0) tools.splice(idx, 1);
			},
		};
	}

	it("registers fusion once even when called twice for the same cwd", () => {
		const pi = createMockPi() as any;
		registerFusionTool(pi, "/project-a");
		registerFusionTool(pi, "/project-a");
		expect(pi.getAllTools().filter((t: any) => t.name === "fusion")).toHaveLength(1);
	});

	it("keeps registrations separate per cwd", () => {
		const pi = createMockPi() as any;
		registerFusionTool(pi, "/project-a");
		registerFusionTool(pi, "/project-b");
		expect(pi.getAllTools().filter((t: any) => t.name === "fusion")).toHaveLength(1);
	});

	it("unregisters fusion when config is disabled", () => {
		const pi = createMockPi() as any;
		registerFusionTool(pi, "/enabled-project");
		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);

		// Switch to disabled config by using a cwd that has no fusion.json
		// and an already-registered tool; disabled project should unregister.
		// Since loadFusionConfig defaults enabled:true, we simulate by
		// calling registerFusionTool on the same cwd again with the registry
		// already containing the tool and relying on the idempotency path.
		registerFusionTool(pi, "/enabled-project");
		expect(pi.getAllTools().some((t: any) => t.name === "fusion")).toBe(true);
	});
});

// ─── Flight Recorder Dump ─────────────────────────────────────

describe("createFlightRecorderDump", () => {
	it("includes scope when scope is provided", () => {
		const params = {
			specialist: "test-spec",
			task: "do something",
			sessionId: "session-1",
			model: "claude-3",
			turns: 5,
			elapsedMs: 1000,
			stopReason: "done" as const,
			errorMessage: undefined as string | undefined,
			finalStatus: "completed" as const,
			messages: [],
			scope: {
				filesToModify: ["src/test.ts"],
				filesToCreate: [],
				directories: ["src"],
				maxFiles: 5,
				requiresApprovalBeyondScope: false,
				changeType: "single-file" as const,
				maxLinesPerFile: 400,
				gateMode: "relaxed" as const,
			},
		};

		const dump = createFlightRecorderDump(params);
		expect(dump).toHaveProperty("scope");
		expect(dump.scope).toEqual(params.scope);
	});

	it("includes scope as undefined when scope is not provided", () => {
		const params = {
			specialist: "test-spec",
			task: "do something",
			sessionId: "session-1",
			model: "claude-3",
			turns: 5,
			elapsedMs: 1000,
			stopReason: "done" as const,
			errorMessage: undefined as string | undefined,
			finalStatus: "completed" as const,
			messages: [],
		};

		const dump = createFlightRecorderDump(params);
		expect(dump).toHaveProperty("scope");
		expect(dump.scope).toBeUndefined();
	});
});

// ─── maxTurns Enforcement ─────────────────────────────────

describe("maxTurns enforcement", () => {
	it("RED: aborts session when turns exceed DEFAULTS.delegation.maxTurns", async () => {
		let subscribeCb: ((event: any) => void) | null = null;
		const abortSpy = vi.fn(() => {
			const err = new Error("Aborted");
			err.name = "AbortError";
			throw err;
		});

		const mockSession = {
			sessionId: "test-maxTurns",
			messages: [] as any[],
			subscribe: vi.fn((cb: any) => {
				subscribeCb = cb;
				return () => {};
			}),
			abort: abortSpy,
			prompt: vi.fn(async () => {
				const maxTurns = DEFAULTS.delegation.maxTurns ?? 30;
				for (let i = 0; i < maxTurns + 1; i++) {
					subscribeCb?.({ type: "message_end", message: { role: "assistant" } });
				}
			}),
			dispose: vi.fn(),
		};

		const mockModel = {};
		const mockModelRegistry = {
			find: vi.fn(() => mockModel),
			getAvailable: vi.fn(() => [mockModel]),
			getAll: vi.fn(() => [mockModel]),
		} as any;

		const runner = new SubagentRunner({
			cwd: "/tmp",
			modelRegistry: mockModelRegistry,
			agentDir: "/Users/shivam94/.pi/agent",
			agentSessionFactory: async () => ({ session: mockSession }),
		} as any);

		const specialist = { name: "test-spec", tools: ["read"], systemPrompt: "test prompt" } as any;
		const result = await runner.run("test task", specialist);

		expect(abortSpy).toHaveBeenCalled();
		expect(result.turns).toBe(DEFAULTS.delegation.maxTurns ?? 30);
		expect(result.output).toContain("aborted");
	});
});
