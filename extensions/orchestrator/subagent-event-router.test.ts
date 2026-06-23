import { describe, it, expect, vi } from 'vitest';
import { SubagentEventRouter } from './subagent-event-router';

describe('SubagentEventRouter', () => {
	it('creates an instance with empty state', () => {
		const router = new SubagentEventRouter();
		expect(router).toBeInstanceOf(SubagentEventRouter);
	});

	it('on() registers a handler that fires on emit()', () => {
		const router = new SubagentEventRouter();
		const handler = vi.fn();
		router.on('progress', handler);
		router.emit({
			type: 'progress',
			specialist: 'tester',
			timestamp: 100,
			data: {},
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('emit() passes correct event data to handler', () => {
		const router = new SubagentEventRouter();
		const handler = vi.fn();
		router.on('tool_call_start', handler);
		const event = {
			type: 'tool_call_start' as const,
			specialist: 'coder',
			timestamp: 42,
			data: { tool: 'read', args: '{ "path": "x" }' },
		};
		router.emit(event);
		expect(handler).toHaveBeenCalledWith(event);
	});

	it('off() unregisters a handler so it no longer fires', () => {
		const router = new SubagentEventRouter();
		const handler = vi.fn();
		router.on('error', handler);
		router.emit({ type: 'error', specialist: 'x', timestamp: 1, data: {} });
		expect(handler).toHaveBeenCalledTimes(1);
		router.off('error', handler);
		router.emit({ type: 'error', specialist: 'x', timestamp: 2, data: {} });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('on() returns an unregister function that stops handler from firing', () => {
		const router = new SubagentEventRouter();
		const handler = vi.fn();
		const unsub = router.on('finding', handler);
		router.emit({ type: 'finding', specialist: 's', timestamp: 1, data: {} });
		expect(handler).toHaveBeenCalledTimes(1);
		unsub();
		router.emit({ type: 'finding', specialist: 's', timestamp: 2, data: {} });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('multiple handlers on same event type all fire', () => {
		const router = new SubagentEventRouter();
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		router.on('progress', handler1);
		router.on('progress', handler2);
		router.emit({ type: 'progress', specialist: 's', timestamp: 1, data: {} });
		expect(handler1).toHaveBeenCalledTimes(1);
		expect(handler2).toHaveBeenCalledTimes(1);
	});

	it('different event types are isolated — only matching type fires', () => {
		const router = new SubagentEventRouter();
		const handler = vi.fn();
		router.on('error', handler);
		router.emit({ type: 'progress', specialist: 's', timestamp: 1, data: {} });
		expect(handler).not.toHaveBeenCalled();
	});

	it('clear() removes all handlers across all types', () => {
		const router = new SubagentEventRouter();
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		router.on('progress', handler1);
		router.on('error', handler2);
		router.clear();
		router.emit({ type: 'progress', specialist: 's', timestamp: 1, data: {} });
		router.emit({ type: 'error', specialist: 's', timestamp: 2, data: {} });
		expect(handler1).not.toHaveBeenCalled();
		expect(handler2).not.toHaveBeenCalled();
	});

	it('emit() does not throw for type with no registered handlers', () => {
		const router = new SubagentEventRouter();
		expect(() => {
			router.emit({ type: 'ask_orchestrator', specialist: 's', timestamp: 1, data: {} });
		}).not.toThrow();
	});
});
