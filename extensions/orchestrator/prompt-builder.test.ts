import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock specialists module ──────────────────────────────────────────────
vi.mock('./specialists', () => ({
	listSpecialists: vi.fn(() => ['scout', 'coder']),
	SPECIALISTS: {
		scout: {
			name: 'scout',
			description: 'Read-only investigator',
			tools: ['read', 'grep', 'find'],
		},
		coder: {
			name: 'coder',
			description: 'Implementation specialist',
			tools: ['read', 'edit', 'write'],
		},
	},
}));

import { buildOrchestratorPrompt } from './prompt-builder';

describe('buildOrchestratorPrompt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes delegation instructions in output', () => {
		const result = buildOrchestratorPrompt({ basePrompt: '' });
		expect(result.systemPrompt).toContain('## Orchestrator Mode');
		expect(result.systemPrompt).toContain('DELEGATE ONLY');
		expect(result.systemPrompt).toContain('delegate(specialist, task)');
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
		expect(result.systemPrompt).not.toContain('multi-model advice');
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
		expect(result.systemPrompt).not.toContain('DELEGATE ONLY');
	});

	it('appends instructions after existing basePrompt content', () => {
		const basePrompt = 'Existing system prompt content';
		const result = buildOrchestratorPrompt({ basePrompt });
		expect(result.systemPrompt).toContain(basePrompt);
		expect(result.systemPrompt).toContain('## Orchestrator Mode');
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
