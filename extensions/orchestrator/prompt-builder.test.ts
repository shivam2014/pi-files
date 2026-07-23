import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock specialists module ──────────────────────────────────────────────
vi.mock('./specialists', () => ({
	listSpecialists: vi.fn(() => ['scout', 'coder', 'reviewer', 'researcher', 'writer']),
	SPECIALISTS: {
		scout: {
			name: 'scout',
			description: 'Read-only investigator.',
			tools: ['read', 'grep', 'find'],
			routingLabel: 'Investigate codebase / find files',
			suggestedSkills: ['diagnosing-bugs'],
		},
		coder: {
			name: 'coder',
			description: 'Implementation specialist.',
			tools: ['read', 'edit', 'write'],
			routingLabel: 'Implement features / fix bugs',
			suggestedSkills: ['implement', 'tdd'],
		},
		reviewer: {
			name: 'reviewer',
			description: 'Read-only code reviewer with bash access.',
			tools: ['read', 'bash', 'grep'],
			routingLabel: 'Review code changes / run bash diagnostics',
			suggestedSkills: ['code-review'],
		},
		researcher: {
			name: 'researcher',
			description: 'Read-only research specialist with web search.',
			tools: ['read', 'web_search', 'grep'],
			routingLabel: 'Research docs / web',
			suggestedSkills: ['domain-modeling'],
		},
		writer: {
			name: 'writer',
			description: 'Documentation specialist with read/write access.',
			tools: ['read', 'write', 'edit'],
			routingLabel: 'Create/edit docs',
			suggestedSkills: ['agents-md-writer'],
		},
	},
	COMMUNICATION_INSTRUCTION: '\n\nRespond with completeness but without verbosity (caveman). All technical substance stay. Only fluff die.\n\n## Auto-Clarity\nDrop caveman for: security warnings, destructive ops, multi-step ambiguity, user asks clarify. Resume after.\n',
}));

import { buildOrchestratorPrompt } from './prompt-builder';

describe('buildOrchestratorPrompt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes delegation instructions in output', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '' });
		expect(result.systemPrompt).toContain('## Capabilities');
		expect(result.systemPrompt).toContain('Delegate only');
		expect(result.systemPrompt).toContain('delegate(specialist, task, scope?)');
	});

	it('includes specialist roster built from mock data', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '' });
		expect(result.systemPrompt).toContain('**scout**');
		expect(result.systemPrompt).toContain('**coder**');
		expect(result.systemPrompt).toContain('read, grep, find');
		expect(result.systemPrompt).toContain('Read-only investigator');
	});

	it('includes fusion section when fusionEnabled is true', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: true });
		expect(result.systemPrompt).toContain('Fusion Tool');
		expect(result.systemPrompt).toContain('multi-model advice');
	});

	it('omits fusion section when fusionEnabled is false', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: false });
		expect(result.systemPrompt).not.toContain('Fusion Tool');
		// "multi-model advice" is in the static intro, not fusion section — skip that check
	});

	it('omits fusion section when fusionEnabled is undefined', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '' });
		expect(result.systemPrompt).not.toContain('Fusion Tool');
	});

	it('includes skills section when skills array is provided', () => {
		const skills = [
			{ name: 'typescript', description: 'TypeScript expertise' },
			{ name: 'react', description: 'React framework knowledge' },
		];
		const result = buildOrchestratorPrompt({ basePrompt: '', skills });
		expect(result.systemPrompt).toContain('Available skills');
		expect(result.systemPrompt).toContain('**typescript**: TypeScript expertise');
		expect(result.systemPrompt).toContain('**react**: React framework knowledge');
	});

	it('omits skills section when skills array is empty', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '', skills: [] });
		expect(result.systemPrompt).not.toContain('Available skills');
	});

	it('omits skills section when skills is undefined', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '' });
		expect(result.systemPrompt).not.toContain('Available skills');
	});

	it('does NOT modify prompt when basePrompt already contains ## Orchestrator Mode', () => {
		const existingPrompt = 'Some text\n## Orchestrator Mode\nmore text';
		const result = buildOrchestratorPrompt({ basePrompt: existingPrompt });
		expect(result.systemPrompt).toBe(existingPrompt);
		expect(result.systemPrompt).not.toContain('## Capabilities');
	});

	it('appends instructions after existing basePrompt content', () => {
		const basePrompt = 'Existing system prompt content';
		const result = buildOrchestratorPrompt({ basePrompt });
		expect(result.systemPrompt).toContain(basePrompt);
		expect(result.systemPrompt).toContain('## Capabilities');
	});

	it('handles skills with missing description field gracefully', () => {
		const skills = [{ name: 'minimal' } as { name: string; description?: string }];
		const result = buildOrchestratorPrompt({ basePrompt: '', skills });
		expect(result.systemPrompt).toContain('**minimal**');
	});

	it('handles fusionEnabled=true with skills together', () => {
		const skills = [{ name: 'test', description: 'Test skill' }];
		const result = buildOrchestratorPrompt({ basePrompt: '', skills, fusionEnabled: true });
		expect(result.systemPrompt).toContain('Fusion Tool');
		expect(result.systemPrompt).toContain('Available skills');
		expect(result.systemPrompt).toContain('**test**');
	});
});

describe("appendix slimming (#39)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("includes caveman mode in orchestrator prompt", () => {
		const basePrompt = "Some base instructions without Orchestrator header";
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt, fusionEnabled: false });
		// The appendix now includes the new caveman mode text
		expect(systemPrompt).toContain("Respond with completeness but without verbosity (caveman)");
		expect(systemPrompt).toContain("Drop caveman for: security warnings");
	});

	it("keeps orchestrator-specific sections", () => {
		const basePrompt = "Some base instructions";
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt, fusionEnabled: false });
		// Must still contain delegation workflow
		expect(systemPrompt).toContain("delegate(specialist, task, scope?)");
		expect(systemPrompt).toContain("Specialist roster");
		expect(systemPrompt).toContain("Scope requirement");
		expect(systemPrompt).toContain("Execution Monitoring");
		expect(systemPrompt).toContain("Audit & Issues Review");
	});

	it("reduces appendix character count compared to before", () => {
		const basePrompt = "Some base instructions";
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt, fusionEnabled: false });
		// The appended part should be reasonable (< 7500 chars — includes routing table + caveman instruction + orchestrator intro)
		const appendix = systemPrompt.replace(basePrompt, "").trim();
		expect(appendix.length).toBeLessThan(13500);
	});
});
describe("clarification deduplication (#40)", () => {
	it("subagent-runner does not duplicate ACTIVITY_FEED_INSTRUCTION clarification text", async () => {
		// ACTIVITY_FEED_INSTRUCTION in specialists.ts already tells subagents about ask_orchestrator.
		// subagent-runner.ts's systemPromptOverride must NOT append a duplicate ### Clarification block.
		// This test fails (RED) as long as the duplication exists.

		// Get actual ACTIVITY_FEED_INSTRUCTION (bypass the mock at top of file)
		const { ACTIVITY_FEED_INSTRUCTION } = await vi.importActual<typeof import("./specialists")>("./specialists");

		// Sanity: ACTIVITY_FEED_INSTRUCTION covers ask_orchestrator
		expect(ACTIVITY_FEED_INSTRUCTION).toContain("ask_orchestrator");
		expect(ACTIVITY_FEED_INSTRUCTION).toContain("Request input from the orchestrator");

		// Read subagent-runner source to detect duplicate clarification inline
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const source = readFileSync(resolve(__dirname, "subagent-runner.ts"), "utf-8");

		// The text 'ask_orchestrator({ question: "' (literal double-quoted ellipsis values)
		// appears ONLY in the redundant ### Clarification block inside systemPromptOverride,
		// NOT in STEPS_MANDATE (which uses `{ question, context? }` syntax).
		// Assertion fails while duplication exists → RED phase.
		expect(source).not.toContain('ask_orchestrator({ question: "');
	});
});

describe("routing table (#43)", () => {
	it("includes task routing table in orchestrator prompt", () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: "base", fusionEnabled: false });
		expect(systemPrompt).toContain("Task Routing");
		expect(systemPrompt).toContain("specialist");
		expect(systemPrompt).toContain("skills");
	});

	it("routing table maps task types to specialist + skills", () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: "base", fusionEnabled: false });
		expect(systemPrompt).toContain("diagnosing-bugs");
		expect(systemPrompt).toContain("agents-md-writer");
		expect(systemPrompt).toContain("code-review");
	});
});

describe("goal-achieved early stop (#45)", () => {
	it("ACTIVITY_FEED_INSTRUCTION contains early-stop instruction", async () => {
		const { ACTIVITY_FEED_INSTRUCTION } = await vi.importActual<typeof import("./specialists")>("./specialists");
		expect(ACTIVITY_FEED_INSTRUCTION).toContain("Goal-achieved early stop");
		expect(ACTIVITY_FEED_INSTRUCTION).toContain("STOP and report back");
		expect(ACTIVITY_FEED_INSTRUCTION).toContain("Do NOT execute remaining planned steps");
	});
});

describe("intro replacement (#issue-1-3)", () => {
	const OLD_PI_INTRO = `You are an expert coding assistant operating inside pi. You have access to read, bash, grep, find, edit, and write tools.

Pi coding agent documentation (available on request):
- Main: /path/to/readme.md
- Additional docs: /path/to/docs
- Examples: /path/to/examples
`;

	it("replaces old pi intro with orchestrator intro", () => {
		const basePrompt = OLD_PI_INTRO + "\nSome additional instructions\n";
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt, fusionEnabled: false });
		expect(systemPrompt).toContain("You are an orchestrator");
		expect(systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");
		expect(systemPrompt).toContain("Some additional instructions");
	});

	it("handles leading content before old pi intro (no ^ anchor)", () => {
		const basePrompt = "\n  \n" + OLD_PI_INTRO + "\nRemaining content\n";
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt, fusionEnabled: false });
		expect(systemPrompt).toContain("You are an orchestrator");
		expect(systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");
		expect(systemPrompt).toContain("Remaining content");
	});

	it("dedup returns early without calling getReadmePath/getDocsPath/getExamplesPath", () => {
		const existingPrompt = "Some text\n## Orchestrator Mode\nmore text";
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: existingPrompt });
		expect(systemPrompt).toBe(existingPrompt);
		expect(systemPrompt).not.toContain("DELEGATE ONLY");
	});

	it("returns basePrompt as-is when no old intro exists", () => {
		const basePrompt = "Custom prompt without any pi intro";
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt, fusionEnabled: false });
		expect(systemPrompt).toContain(basePrompt);
		expect(systemPrompt).toContain("## Capabilities");
		expect(systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");
	});

	it("handles empty basePrompt", () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: "", fusionEnabled: false });
		expect(systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");
		expect(systemPrompt).toContain("## Capabilities");
	});
});
