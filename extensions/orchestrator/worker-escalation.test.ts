/**
 * worker-escalation.test.ts
 *
 * Validates WORKER-INITIATED ESCALATION, layered on top of adaptive escalation:
 *  - PART A: the coder/scout system prompts carry a hard, counted exploration
 *    budget rule instructing the worker to escalate UP via ask_orchestrator
 *    before floundering (objective tool-call/trun budgets the worker cannot bias).
 *  - PART B: the orchestrator's ADAPTIVE ROUTING prompt responds to worker-initiated
 *    escalations (ask_orchestrator requesting investigation/plan/review) by
 *    escalating the ladder rather than ignoring the request.
 *  - PART C: the existing adaptive-escalation contract is preserved.
 */
import { describe, it, expect } from 'vitest';
import {
	renderSpecialistPrompt,
	WORKER_ESCALATION_RULE,
	ESCALATION_MAX_EXPLORATION_CALLS,
	ESCALATION_MAX_FILES_TOUCHED,
	ESCALATION_MAX_TURNS,
} from './specialists';
import { buildOrchestratorPrompt } from './prompt-builder';

// ── PART A: hard-budget escalation rule in coder/scout prompts ─────────────
describe('PART A — hard-budget escalation rule (specialists)', () => {
	it('exports the budget constants with sensible counted defaults', () => {
		expect(ESCALATION_MAX_EXPLORATION_CALLS).toBeGreaterThan(0);
		expect(ESCALATION_MAX_FILES_TOUCHED).toBeGreaterThan(0);
		expect(ESCALATION_MAX_TURNS).toBeGreaterThan(0);
	});

	it('WORKER_ESCALATION_RULE references ask_orchestrator + exploration budget + MORE THAN', () => {
		expect(WORKER_ESCALATION_RULE).toContain('ask_orchestrator');
		expect(WORKER_ESCALATION_RULE).toContain('exploration budget');
		expect(WORKER_ESCALATION_RULE).toContain('MORE THAN');
		expect(WORKER_ESCALATION_RULE).toContain('recommend: investigate');
	});

	it('coder prompt instructs escalation via ask_orchestrator on a hard budget', () => {
		const prompt = renderSpecialistPrompt('coder');
		expect(prompt).toContain('ask_orchestrator');
		expect(prompt).toContain('exploration budget');
		expect(prompt).toContain('MORE THAN');
		expect(prompt).toContain('do not silently keep exploring past the budget');
	});

	it('scout prompt instructs escalation via ask_orchestrator on a hard budget', () => {
		const prompt = renderSpecialistPrompt('scout');
		expect(prompt).toContain('ask_orchestrator');
		expect(prompt).toContain('exploration budget');
		expect(prompt).toContain('MORE THAN');
	});

	it('coder prompt keeps the existing ## Difficulty block contract (adaptive escalation)', () => {
		const prompt = renderSpecialistPrompt('coder');
		expect(prompt).toContain('## Difficulty');
		expect(prompt).toContain('recommend');
		expect(prompt).toContain('Fill the Difficulty block honestly');
	});

	it('scout prompt keeps the existing ## Difficulty block contract (adaptive escalation)', () => {
		const prompt = renderSpecialistPrompt('scout');
		expect(prompt).toContain('## Difficulty');
		expect(prompt).toContain('- exploration: low|medium|high');
		expect(prompt).toContain('- recommend: none|review|investigate|plan');
	});
});

// ── PART B: orchestrator responds to worker-initiated escalation ───────────
describe('PART B — worker-escalation-response rule (prompt-builder)', () => {
	it('adaptive-routing prompt contains a worker-escalation-response rule', () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: false });
		expect(systemPrompt).toContain('ask_orchestrator');
		expect(systemPrompt).toContain('escalation');
		expect(systemPrompt).toContain('do NOT ignore');
	});

	it('keeps START CHEAP / ESCALATE ONLY ON SIGNALS so the live trigger layers on top', () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: false });
		expect(systemPrompt).toContain('Adaptive Routing');
		expect(systemPrompt).toContain('START CHEAP');
		expect(systemPrompt).toContain('ESCALATE ONLY ON SIGNALS');
		expect(systemPrompt).toContain('READ THE DIFFICULTY SIGNAL');
		expect(systemPrompt).toContain('Do NOT blindly run all three stages');
	});

	it('does NOT re-introduce the fixed scout→coder→reviewer ladder', () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: false });
		expect(systemPrompt).not.toContain('step 1: delegate("scout", ...)');
		expect(systemPrompt).not.toContain('Diagnose root cause');
	});
});
