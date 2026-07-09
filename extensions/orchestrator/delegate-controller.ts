/**
 * Delegate controller — thin orchestrator for specialist subagent delegation.
 * Routes to DelegatePipeline; this module exists so delegate-tool.ts's import
 * stays stable.
 */
import type { DelegateControllerContext } from "./types.ts";
import { Scope, ScopeManager } from "./scope-manager.ts";
import { DelegatePipeline, type ExecuteDelegateResult } from "./delegate-pipeline.ts";

/**
 * Execute a delegation to a specialist subagent.
 *
 * @param params - Delegation parameters (specialist, task, optional scope, optional signal)
 * @param ctx - Agent context (cwd, modelRegistry, model, ui, etc.)
 * @param onUpdate - Callback for progress updates during execution
 * @returns Result with content and details
 */
export async function executeDelegate(
	params: { specialist: string; task: string; skills?: string[]; scope?: Scope; signal?: AbortSignal },
	ctx: DelegateControllerContext,
	onUpdate: (update: any) => void,
): Promise<ExecuteDelegateResult> {
	const pipeline = new DelegatePipeline({ scopeManager: new ScopeManager(ctx.cwd) });
	try {
		return await pipeline.run(params, ctx, onUpdate);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text", text: message }],
			details: { status: "error" },
		};
	}
}
