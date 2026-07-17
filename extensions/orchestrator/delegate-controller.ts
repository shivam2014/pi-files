/**
 * Delegate controller — thin orchestrator for specialist subagent delegation.
 * Routes to DelegatePipeline; this module exists so delegate-tool.ts's import
 * stays stable.
 */
import type { DelegateControllerContext, BatchDelegationEntry } from "./types.ts";
import { Scope, ScopeManager } from "./scope-manager.ts";
import { DelegatePipeline, type ExecuteDelegateResult } from "./delegate-pipeline.ts";
import { getSessionMode } from "./orchestrator-config";

/**
 * Execute a delegation to a specialist subagent.
 *
 * @param params - Delegation parameters (specialist, task, optional scope, optional signal, optional batch)
 * @param ctx - Agent context (cwd, modelRegistry, model, ui, etc.)
 * @param onUpdate - Callback for progress updates during execution
 * @returns Result with content and details
 */
export async function executeDelegate(
	params: {
		specialist?: string;
		task?: string;
		skills?: string[];
		scope?: Scope;
		signal?: AbortSignal;
		batch?: BatchDelegationEntry[];
	},
	ctx: DelegateControllerContext,
	onUpdate: (update: any) => void,
): Promise<ExecuteDelegateResult> {
	const pipeline = new DelegatePipeline({ scopeManager: new ScopeManager(ctx.cwd) });

	// Batch mode
	if (params.batch && params.batch.length > 0) {
		// Batch only allowed in parallel mode
		const mode = getSessionMode(ctx);
		if (mode !== "parallel") {
			return {
				content: [{ type: "text", text: "⚠️ Batch delegation requires parallel mode. Use /delegate-mode parallel to enable." }],
				details: { error: "batch_requires_parallel_mode" },
			};
		}
		return pipeline.runBatch(params.batch, ctx, onUpdate, params.signal);
	}

	// Single delegation mode
	if (!params.specialist || !params.task) {
		return {
			content: [{ type: "text", text: "⚠️ specialist and task are required when batch is not provided." }],
			details: { status: "error" },
		};
	}
	try {
		return await pipeline.run(params as any, ctx, onUpdate);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text", text: message }],
			details: { status: "error" },
		};
	}
}
