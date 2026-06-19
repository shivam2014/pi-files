import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all 5 register functions using vi.hoisted ──────────────────────
const { mockRegisterDelegateTool, mockRegisterPlanTool, mockRegisterCommands, mockRegisterFusionCommands, mockRegisterFusionTool } = vi.hoisted(() => ({
	mockRegisterDelegateTool: vi.fn(),
	mockRegisterPlanTool: vi.fn(),
	mockRegisterCommands: vi.fn(),
	mockRegisterFusionCommands: vi.fn(),
	mockRegisterFusionTool: vi.fn(),
}));

vi.mock('./delegate-tool', () => ({
	registerDelegateTool: mockRegisterDelegateTool,
}));
vi.mock('./plan-tool', () => ({
	registerPlanTool: mockRegisterPlanTool,
}));
vi.mock('./commands', () => ({
	registerCommands: mockRegisterCommands,
}));
vi.mock('./fusion-commands', () => ({
	registerFusionCommands: mockRegisterFusionCommands,
}));
vi.mock('./fusion-tool', () => ({
	registerFusionTool: mockRegisterFusionTool,
}));

import { registerAllTools } from './registration-hub';

describe('registerAllTools', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function createMockPi(): any {
		return {
			registerTool: vi.fn(),
			getAllTools: vi.fn(() => []),
			on: vi.fn(),
			setActiveTools: vi.fn(),
			registerShortcut: vi.fn(),
		};
	}

	it('calls registerDelegateTool with pi', () => {
		const pi = createMockPi();
		registerAllTools(pi, '/test/cwd');
		expect(mockRegisterDelegateTool).toHaveBeenCalledTimes(1);
		expect(mockRegisterDelegateTool).toHaveBeenCalledWith(pi);
	});

	it('calls registerPlanTool with pi', () => {
		const pi = createMockPi();
		registerAllTools(pi, '/test/cwd');
		expect(mockRegisterPlanTool).toHaveBeenCalledTimes(1);
		expect(mockRegisterPlanTool).toHaveBeenCalledWith(pi);
	});

	it('calls registerCommands with pi', () => {
		const pi = createMockPi();
		registerAllTools(pi, '/test/cwd');
		expect(mockRegisterCommands).toHaveBeenCalledTimes(1);
		expect(mockRegisterCommands).toHaveBeenCalledWith(pi);
	});

	it('calls registerFusionCommands with pi', () => {
		const pi = createMockPi();
		registerAllTools(pi, '/test/cwd');
		expect(mockRegisterFusionCommands).toHaveBeenCalledTimes(1);
		expect(mockRegisterFusionCommands).toHaveBeenCalledWith(pi);
	});

	it('calls registerFusionTool with pi and cwd', () => {
		const pi = createMockPi();
		registerAllTools(pi, '/test/cwd');
		expect(mockRegisterFusionTool).toHaveBeenCalledTimes(1);
		expect(mockRegisterFusionTool).toHaveBeenCalledWith(pi, '/test/cwd');
	});

	it('calls all 5 register functions exactly once', () => {
		const pi = createMockPi();
		registerAllTools(pi, '/some/path');
		expect(mockRegisterDelegateTool).toHaveBeenCalledTimes(1);
		expect(mockRegisterPlanTool).toHaveBeenCalledTimes(1);
		expect(mockRegisterCommands).toHaveBeenCalledTimes(1);
		expect(mockRegisterFusionCommands).toHaveBeenCalledTimes(1);
		expect(mockRegisterFusionTool).toHaveBeenCalledTimes(1);
	});
});
