import { describe, it, expect } from 'vitest';
import { DelegateFeedBuilder } from './delegate-feed-builder';

describe('DelegateFeedBuilder', () => {
  describe('construction', () => {
    it('creates an instance', () => {
      const builder = new DelegateFeedBuilder();
      expect(builder).toBeInstanceOf(DelegateFeedBuilder);
    });

    it('starts with no feed state', () => {
      const builder = new DelegateFeedBuilder();
      expect(builder.getState()).toBeNull();
    });

    it('starts with empty history', () => {
      const builder = new DelegateFeedBuilder();
      expect(builder.getToolCallHistory()).toEqual([]);
    });
  });

  describe('startDelegation', () => {
    it('creates a feed state with specialist and task as goal', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix auth middleware');
      const state = builder.getState();
      expect(state).not.toBeNull();
      expect(state!.goal).toContain('coder');
      expect(state!.goal).toContain('fix auth middleware');
    });

    it('records specialist and task', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('scout', 'find files');
      expect(builder.getSpecialist()).toBe('scout');
      expect(builder.getTask()).toBe('find files');
    });

    it('initializes with one step matching the task', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'implement feature');
      const state = builder.getState()!;
      expect(state.steps.length).toBe(1);
      expect(state.steps[0].label).toContain('implement feature');
    });

    it('can be called multiple times (resets state)', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'first task');
      builder.startDelegation('scout', 'second task');
      expect(builder.getSpecialist()).toBe('scout');
      expect(builder.getTask()).toBe('second task');
    });
  });

  describe('onToolCall', () => {
    it('adds a substep for the tool call', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/auth.ts' });
      const state = builder.getState()!;
      expect(state.steps[0].substeps.length).toBeGreaterThanOrEqual(1);
    });

    it('uses toolCallToSubstep for the substep label', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/auth.ts' });
      const state = builder.getState()!;
      const substep = state.steps[0].substeps[0];
      expect(substep.label).toContain('Reading');
      expect(substep.label).toContain('auth.ts');
    });

    it('handles multiple tool calls', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/a.ts' });
      builder.onToolCall('grep', { pattern: 'foo' });
      builder.onToolCall('edit', { path: 'src/a.ts' });
      const state = builder.getState()!;
      expect(state.steps[0].substeps.length).toBe(3);
    });

    it('records tool call in history', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/a.ts' });
      builder.onToolCall('bash', { command: 'npm test' });
      const history = builder.getToolCallHistory();
      expect(history).toEqual([
        { tool: 'read', input: { path: 'src/a.ts' } },
        { tool: 'bash', input: { command: 'npm test' } },
      ]);
    });

    it('completes previous substep before adding new one', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/a.ts' });
      builder.onToolCall('grep', { pattern: 'foo' });
      const state = builder.getState()!;
      // First substep should be completed
      expect(state.steps[0].substeps[0].completed).toBe(true);
      // Second substep should be active (not completed)
      expect(state.steps[0].substeps[1].completed).toBe(false);
    });

    it('no-op if delegation not started', () => {
      const builder = new DelegateFeedBuilder();
      builder.onToolCall('read', { path: 'src/a.ts' });
      expect(builder.getState()).toBeNull();
      expect(builder.getToolCallHistory()).toEqual([]);
    });
  });

  describe('onComplete', () => {
    it('completes the feed', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/a.ts' });
      builder.onComplete('All done');
      const state = builder.getState()!;
      expect(state.steps[0].completed).toBe(true);
    });

    it('completes any remaining active substeps', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/a.ts' });
      builder.onComplete('Done');
      const state = builder.getState()!;
      // Active substep should be completed
      expect(state.steps[0].substeps[0].completed).toBe(true);
    });

    it('records the output preview on last substep', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('edit', { path: 'src/a.ts' });
      builder.onComplete('Fixed the auth bug');
      const state = builder.getState()!;
      const lastSubstep = state.steps[0].substeps[state.steps[0].substeps.length - 1];
      expect(lastSubstep.completed).toBe(true);
    });

    it('handles complete without tool calls', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'trivial task');
      builder.onComplete('Done');
      const state = builder.getState()!;
      expect(state.steps[0].completed).toBe(true);
    });

    it('no-op if delegation not started', () => {
      const builder = new DelegateFeedBuilder();
      builder.onComplete('Done');
      expect(builder.getState()).toBeNull();
    });
  });

  describe('onAskOrchestratorComplete', () => {
    it('completes the active substep with orchestrator answer as label', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onAskOrchestrator('What does this function do?');
      builder.onAskOrchestratorComplete('It does X');
      const state = builder.getState()!;
      const substep = state.steps[0].substeps[0];
      expect(substep.completed).toBe(true);
      expect(substep.label).toContain('Orchestrator: It does X');
    });

    it('no-op if delegation not started', () => {
      const builder = new DelegateFeedBuilder();
      builder.onAskOrchestratorComplete('answer');
      expect(builder.getState()).toBeNull();
    });
  });

  describe('onReportFinding', () => {
    it('adds a substep with the question label', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onAskOrchestrator('What does this function do?');
      const state = builder.getState()!;
      expect(state.steps[0].substeps.length).toBe(1);
      expect(state.steps[0].substeps[0].label).toContain('Asking orchestrator: What does this function do?');
    });

    it('no-op if delegation not started', () => {
      const builder = new DelegateFeedBuilder();
      builder.onAskOrchestrator('question?');
      expect(builder.getState()).toBeNull();
    });
  });

  describe('setDetail', () => {
    it('updates output preview on active substep', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/auth.ts' });
      builder.setDetail('Processing file X');
      const state = builder.getState()!;
      const substep = state.steps[0].substeps[0];
      expect(substep.outputPreview).toBe('Processing file X');
    });

    it('no-op if delegation not started', () => {
      const builder = new DelegateFeedBuilder();
      builder.setDetail('detail');
      expect(builder.getState()).toBeNull();
    });
  });

  describe('onReportFinding', () => {
    it('adds a substep with finding summary', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onReportFinding({ summary: 'Bug found', key_files: ['auth.ts'] });
      const state = builder.getState()!;
      expect(state.steps[0].substeps.length).toBe(1);
      expect(state.steps[0].substeps[0].label).toContain('Finding: Bug found');
    });

    it('no-op if delegation not started', () => {
      const builder = new DelegateFeedBuilder();
      builder.onReportFinding({ summary: 'nope', key_files: [] });
      expect(builder.getState()).toBeNull();
    });
  });

  describe('render', () => {
    it('returns empty string if no delegation started', () => {
      const builder = new DelegateFeedBuilder();
      expect(builder.render()).toBe('');
    });

    it('returns a string with the goal after starting delegation', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      const rendered = builder.render();
      expect(typeof rendered).toBe('string');
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered).toContain('fix bug');
    });

    it('includes tool call info after onToolCall', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/auth.ts' });
      const rendered = builder.render();
      expect(rendered).toContain('auth.ts');
    });

    it('shows completed state after onComplete', () => {
      const builder = new DelegateFeedBuilder();
      builder.startDelegation('coder', 'fix bug');
      builder.onToolCall('read', { path: 'src/a.ts' });
      builder.onComplete('Done');
      const rendered = builder.render();
      expect(rendered).toContain('fix bug');
      // Should contain completion indicator (checkmark)
      expect(rendered).toContain('✓');
    });
  });

  describe('full lifecycle', () => {
    it('handles a complete delegation lifecycle', () => {
      const builder = new DelegateFeedBuilder();

      // Start
      builder.startDelegation('coder', 'implement login feature');

      // Tool calls
      builder.onToolCall('read', { path: 'src/auth.ts' });
      builder.onToolCall('grep', { pattern: 'login' });
      builder.onToolCall('edit', { path: 'src/auth.ts' });
      builder.onToolCall('bash', { command: 'npm test' });

      // Complete
      builder.onComplete('Login feature implemented');

      // Verify
      expect(builder.getSpecialist()).toBe('coder');
      expect(builder.getTask()).toBe('implement login feature');
      expect(builder.getToolCallHistory()).toHaveLength(4);

      const state = builder.getState()!;
      expect(state.steps[0].completed).toBe(true);
      expect(state.steps[0].substeps.every((s: { completed: boolean }) => s.completed)).toBe(true);

      const rendered = builder.render();
      expect(rendered).toContain('implement login feature');
      expect(rendered).toContain('✓');
    });

    it('supports multiple sequential delegations', () => {
      const builder = new DelegateFeedBuilder();

      builder.startDelegation('coder', 'first task');
      builder.onToolCall('read', { path: 'a.ts' });
      builder.onComplete('done');
      expect(builder.getState()!.steps[0].completed).toBe(true);

      builder.startDelegation('scout', 'second task');
      builder.onToolCall('bash', { command: 'find . -name "*.ts"' });
      builder.onComplete('done');
      expect(builder.getSpecialist()).toBe('scout');
      expect(builder.getState()!.goal).toContain('second task');
    });
  });
});
