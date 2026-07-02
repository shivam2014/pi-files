/**
 * Side-effectful scope application for delegation.
 * Calls AskResolver gate and ScopeManager write.
 */

import type { Scope } from "./scope-manager.ts";
import { resolve } from "./ask-resolver.ts";
import { ScopeManager } from "./scope-manager.ts";

/**
 * Apply resolved scope: run AskResolver gate, write scope file.
 *
 * @returns { proceed: true } if delegation should continue,
 *          { proceed: false, reason } if orchestrator must clarify first
 */
export function applyScope(
	resolvedScope: Scope | null,
	task: string,
	specialistName: string,
	isReadOnly: boolean,
	cwd: string,
): { proceed: boolean; reason?: string } {
	// Null scope → no gate check, no write — proceed
	if (resolvedScope === null) {
		return { proceed: true };
	}

	// AskResolver gate — check if scope is clear before delegating
	const gateResult = resolve(task, resolvedScope);
	// Read-only specialists can't write files — vague scope isn't a problem
	if (gateResult === "ask" && !isReadOnly) {
		return { proceed: false, reason: "scope_vague" };
	}

	// Write scope for scope-guard enforcement before delegation
	new ScopeManager(cwd).writeScope(resolvedScope);

	return { proceed: true };
}
