import { describe, it, expect, beforeEach, vi } from "vitest";
import { _sessionModels, getSessionModels, setSessionModels, saveOrchestratorConfig } from "./orchestrator-config.ts";
import { registerModelCommands } from "./model-commands.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void>;

function register(): CommandHandler {
	let handler: CommandHandler | undefined;
	const pi = {
		registerCommand: (_name: string, def: { handler: CommandHandler }) => {
			handler = def.handler;
		},
	};
	registerModelCommands(pi as any);
	if (!handler) throw new Error("command handler not registered");
	return handler;
}

function makeCtx(sessionId: string) {
	return {
		sessionManager: { sessionId },
		ui: { notify: () => {} },
	} as any;
}

describe("model-commands session overrides", () => {
	beforeEach(() => {
		_sessionModels.clear();
		vi.restoreAllMocks();
	});

	it("set default stores a delegate override for this session only", async () => {
		const h = register();
		await h("set default anthropic/claude-sonnet-4", makeCtx("s1"));
		expect(getSessionModels({ sessionManager: { sessionId: "s1" } })).toEqual({
			delegate: "anthropic/claude-sonnet-4",
		});
	});

	it("set <specialist> stores a specialist override for this session only", async () => {
		const h = register();
		await h("set scout anthropic/claude-haiku-3", makeCtx("s1"));
		expect(getSessionModels({ sessionManager: { sessionId: "s1" } })).toEqual({
			specialists: { scout: "anthropic/claude-haiku-3" },
		});
	});

	it("a different session sees no override after set", async () => {
		const h = register();
		await h("set scout anthropic/claude-haiku-3", makeCtx("s1"));
		expect(getSessionModels({ sessionManager: { sessionId: "s2" } })).toBeUndefined();
	});

	it("set accumulates into an existing session override", async () => {
		const h = register();
		await h("set default anthropic/claude-sonnet-4", makeCtx("s1"));
		await h("set scout anthropic/claude-haiku-3", makeCtx("s1"));
		expect(getSessionModels({ sessionManager: { sessionId: "s1" } })).toEqual({
			delegate: "anthropic/claude-sonnet-4",
			specialists: { scout: "anthropic/claude-haiku-3" },
		});
	});

	it("handleModelSet does NOT write the global orchestrator.yml (saveOrchestratorConfig not called)", async () => {
		const h = register();
		const saveSpy = vi.spyOn(
			await import("./orchestrator-config.ts"),
			"saveOrchestratorConfig",
		);
		await h("set scout anthropic/claude-haiku-3", makeCtx("s1"));
		await h("set default anthropic/claude-sonnet-4", makeCtx("s1"));
		expect(saveSpy).not.toHaveBeenCalled();
	});

	it("rejects an invalid model id without storing anything", async () => {
		const h = register();
		await h("set scout not-a-valid-id", makeCtx("s1"));
		expect(getSessionModels({ sessionManager: { sessionId: "s1" } })).toBeUndefined();
	});

	it("reset clears only this session's override, leaving others intact", async () => {
		const h = register();
		setSessionModels({ sessionManager: { sessionId: "s1" } }, { delegate: "model/a" });
		setSessionModels({ sessionManager: { sessionId: "s2" } }, { delegate: "model/b" });
		await h("reset", makeCtx("s1"));
		expect(getSessionModels({ sessionManager: { sessionId: "s1" } })).toBeUndefined();
		expect(getSessionModels({ sessionManager: { sessionId: "s2" } })).toEqual({
			delegate: "model/b",
		});
	});

	it("reset does NOT write the global orchestrator.yml (saveOrchestratorConfig not called)", async () => {
		const h = register();
		const saveSpy = vi.spyOn(
			await import("./orchestrator-config.ts"),
			"saveOrchestratorConfig",
		);
		await h("reset", makeCtx("s1"));
		expect(saveSpy).not.toHaveBeenCalled();
	});

	it("reset is a no-op-safe call when no override exists", async () => {
		const h = register();
		await h("reset", makeCtx("ghost-session"));
		expect(_sessionModels.size).toBe(0);
	});
});
