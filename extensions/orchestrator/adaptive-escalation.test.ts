/**
 * adaptive-escalation.test.ts
 *
 * Validates the three parts of ADAPTIVE ESCALATION:
 *  - PART A: coder/scout emit a `## Difficulty` block (contract in specialists.ts).
 *  - PART B: delegate-pipeline parses the `## Difficulty` block and surfaces it in the
 *            delegate output the orchestrator sees (`[Difficulty: ...]`).
 *  - PART C: the orchestrator prompt uses ADAPTIVE ROUTING instead of the fixed
 *            scout→coder→reviewer ceremony.
 */
import { describe, it, expect } from 'vitest';
import {
	extractDifficultyFromOutput,
	formatDifficultySignal,
	formatResult,
	type DifficultySignal,
} from './delegate-pipeline';
import { renderSpecialistPrompt } from './specialists';
import { shouldNudge, reportsExplicitStop, PERSISTENCE_NUDGE_MESSAGE } from './subagent-runner';
import { buildOrchestratorPrompt } from './prompt-builder';
import type { DelegationMetrics } from './types';

const metrics: DelegationMetrics = {
	readCalls: 3, grepCalls: 2, findCalls: 0,
	editCalls: 1, writeCalls: 0, bashCalls: 5,
	lsCalls: 1, scopeNotes: undefined,
};

// ── PART A: contract — code and content emitted by specialists ─────────────
describe('PART A — difficulty signal contract (specialists)', () => {
	it('coder prompt instructs the subagent to emit a ## Difficulty block', () => {
		const prompt = renderSpecialistPrompt('coder');
		expect(prompt).toContain('## Difficulty');
		expect(prompt).toContain('recommend');
		expect(prompt).toContain('verification');
		expect(prompt).toContain('Fill the Difficulty block honestly');
	});

	it('scout prompt emits the ## Difficulty block via shared findings template', () => {
		const prompt = renderSpecialistPrompt('scout');
		expect(prompt).toContain('## Difficulty');
		expect(prompt).toContain('- exploration: low|medium|high');
		expect(prompt).toContain('- recommend: none|review|investigate|plan');
	});
});

// ── PART B: parse + surface the difficulty signal ─────────────────────────
describe('PART B — difficulty signal parsing (delegate-pipeline)', () => {
	it('extractDifficultyFromOutput parses a full ## Difficulty block', () => {
		const output = `## Findings
- summary: Fixed auth middleware

## Audit
- problems: [none]
- resolution: [none]

## Difficulty
- exploration: high
- uncertainty: low
- verification: pass
- iteration: high
- recommend: review
`;
		const d = extractDifficultyFromOutput(output);
		expect(d).not.toBeNull();
		expect(d!.exploration).toBe('high');
		expect(d!.uncertainty).toBe('low');
		expect(d!.verification).toBe('pass');
		expect(d!.iteration).toBe('high');
		expect(d!.recommend).toBe('review');
	});

	it('returns null when no ## Difficulty block is present', () => {
		expect(extractDifficultyFromOutput('Just plain output')).toBeNull();
		expect(extractDifficultyFromOutput('## Findings\n- summary: done\n')).toBeNull();
	});

	it('strips trailing # comments and whitespace from values', () => {
		const output = `## Difficulty
- exploration: high    # how many files/modules were read
- uncertainty: medium     # ambiguity, unresolved questions
- verification: pass          # lint/test passed
- iteration: low       # one pass
- recommend: review   # my own escalation recommendation
`;
		const d = extractDifficultyFromOutput(output);
		expect(d!.exploration).toBe('high');
		expect(d!.uncertainty).toBe('medium');
		expect(d!.verification).toBe('pass');
		expect(d!.iteration).toBe('low');
		expect(d!.recommend).toBe('review');
	});

	it('handles missing fields gracefully (empty string)', () => {
		const output = `## Difficulty\n- verification: fail\n`;
		const d = extractDifficultyFromOutput(output);
		expect(d).not.toBeNull();
		expect(d!.verification).toBe('fail');
		expect(d!.exploration).toBe('');
		expect(d!.recommend).toBe('');
	});
});

describe('PART B — difficulty signal surfacing', () => {
	it('formatDifficultySignal formats the signal line', () => {
		const d: DifficultySignal = { exploration: 'high', uncertainty: 'low', verification: 'pass', iteration: 'high', recommend: 'review' };
		expect(formatDifficultySignal(d)).toBe('[Difficulty: exploration=high, uncertainty=low, verification=pass, iteration=high, recommend=review]');
	});

	it('formatDifficultySignal defaults to a neutral value when absent', () => {
		expect(formatDifficultySignal(null)).toBe('[Difficulty: not reported]');
		const empty: DifficultySignal = { exploration: '', uncertainty: '', verification: '', iteration: '', recommend: '' };
		expect(formatDifficultySignal(empty)).toBe('[Difficulty: not reported]');
	});

	it('formatResult surfaces the parsed difficulty line in the formatted output', () => {
		const output = `## Findings
- summary: done

## Difficulty
- exploration: high
- uncertainty: low
- verification: pass
- iteration: high
- recommend: review
`;
		const r = formatResult({ output, metrics, elapsed: 1, turns: 2, toolCalls: 3, status: 'ok' });
		expect(r.difficulty).not.toBeNull();
		expect(r.difficulty!.recommend).toBe('review');
		expect(r.formatted).toContain('[Difficulty: exploration=high, uncertainty=low, verification=pass, iteration=high, recommend=review]');
	});

	it('formatResult surfaces a neutral difficulty when the block is absent', () => {
		const output = `## Findings\n- summary: done\n`;
		const r = formatResult({ output, metrics, elapsed: 1, turns: 1, toolCalls: 1, status: 'ok' });
		expect(r.difficulty).toBeNull();
		expect(r.formatted).toContain('[Difficulty: not reported]');
	});
});

// ── PART C: adaptive routing in orchestrator prompt ───────────────────────
describe('PART C — adaptive routing instruction (prompt-builder)', () => {
	it('does NOT hard-code the fixed 3-step scout→coder→reviewer sequence', () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: false });
		// The old fixed example (diagnose → analyze → implement → review) must be gone.
		expect(systemPrompt).not.toContain('step 1: delegate("scout", ...)');
		expect(systemPrompt).not.toContain('step 3: delegate("coder", ...)');
		expect(systemPrompt).not.toContain('step 4: delegate("reviewer", ...)');
		expect(systemPrompt).not.toContain('Diagnose root cause');
	});

	it('contains adaptive-routing wording', () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: false });
		expect(systemPrompt).toContain('Adaptive Routing');
		expect(systemPrompt).toContain('START CHEAP');
		expect(systemPrompt).toContain('ESCALATE ONLY ON SIGNALS');
		expect(systemPrompt).toContain('READ THE DIFFICULTY SIGNAL');
		expect(systemPrompt).toContain('Do NOT blindly run all three stages');
	});

	it('keeps the existing non-routing sections intact', () => {
		const { systemPrompt } = buildOrchestratorPrompt({ basePrompt: '', fusionEnabled: false });
		expect(systemPrompt).toContain('Delegate only');
		expect(systemPrompt).toContain('## Capabilities');
		expect(systemPrompt).toContain('fusion()');
		expect(systemPrompt).toContain('### Scope requirement');
		expect(systemPrompt).toContain('# Recalibration');
		expect(systemPrompt).toContain('# Execution Monitoring');
		expect(systemPrompt).toContain('# Delegation Error Protocol');
	});
});

// ── PART D: stop-aware persistence nudge (escalation-bypass fix) ─────────────
describe('PART D — stop-aware persistence nudge', () => {
	it('suppresses the nudge when the worker explicitly reported a stop (STOPPED:)', () => {
		const stopReport = '## Findings\n- summary: blocked on foreign claim\n\n(STOPPED: task stop-condition met — standing by)';
		expect(reportsExplicitStop(stopReport)).toBe(true);
		expect(shouldNudge('stop', true, false, stopReport)).toBe(false);
	});

	it('detects the remaining explicit-stop phrasings', () => {
		expect(reportsExplicitStop('I hit a stop-condition and stopped')).toBe(true);
		expect(reportsExplicitStop('Standing by for further instructions')).toBe(true);
		expect(reportsExplicitStop('Awaiting orchestrator input')).toBe(true);
		expect(reportsExplicitStop('Escalating per the worker protocol')).toBe(true);
		expect(reportsExplicitStop('\u26d4 NO ORCHESTRATOR ANSWER AVAILABLE')).toBe(true);
		expect(reportsExplicitStop('')).toBe(false);
		expect(reportsExplicitStop(undefined)).toBe(false);
	});

	it('still nudges a lazy incomplete stop with no stop report', () => {
		const lazy = 'I read a few files and ran out of ideas.';
		expect(reportsExplicitStop(lazy)).toBe(false);
		expect(shouldNudge('stop', true, false, lazy)).toBe(true);
		expect(shouldNudge('stop', true, false, undefined)).toBe(true);
	});

	it('never nudges when steps are complete or a nudge already happened', () => {
		expect(shouldNudge('stop', false, false, 'STOPPED: done')).toBe(false);
		expect(shouldNudge('stop', true, true, 'lazy output')).toBe(false);
	});

	it('the nudge text itself carries the non-resume clause for unguarded stops', () => {
		expect(PERSISTENCE_NUDGE_MESSAGE).toContain('Continue: finish all remaining steps');
		expect(PERSISTENCE_NUDGE_MESSAGE).toContain('do NOT resume');
	});

	it('specialist prompts forbid treating nudges/answers as authorization to bypass stop-conditions', () => {
		for (const name of ['coder', 'scout'] as const) {
			const prompt = renderSpecialistPrompt(name);
			expect(prompt).toContain('NOT authorization to bypass task stop-conditions or claim locks');
		}
	});
});
