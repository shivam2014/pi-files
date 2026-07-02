/**
 * Pure scope normalization for delegation.
 * No side effects — no AskResolver gate, no ScopeManager write.
 */

import type { Scope } from "./scope-manager.ts";
import type { Specialist } from "./types.ts";

/** Default scope for writer specialist when no explicit scope is provided */
export function getDefaultWriterScope(cwd: string): Scope {
	return {
		filesToModify: [],
		filesToCreate: [],
		directories: [cwd],
		maxFiles: 20,
		requiresApprovalBeyondScope: true,
		changeType: 'multi-file',
		maxLinesPerFile: 400,
		gateMode: 'strict',
		boundaries: `Doc-friendly default scope. You may create and modify:\n- *.md files in the current working directory\n- files under docs/ recursively\n- common documentation filenames such as README, AGENTS.md, CLAUDE.md, LICENSE, CONTRIBUTING.md, CHANGELOG.md, CODE_OF_CONDUCT.md, and SECURITY.md`,
	};
}

/**
 * Normalize an explicit scope by filling in defaults for missing fields.
 */
function normalizeExplicitScope(scope: Scope): Scope {
	return {
		...scope,
		filesToModify: scope.filesToModify ?? [],
		filesToCreate: scope.filesToCreate ?? [],
		directories: scope.directories ?? [],
		maxFiles: scope.maxFiles ?? 10,
		requiresApprovalBeyondScope: scope.requiresApprovalBeyondScope ?? true,
		changeType: scope.changeType ?? "multi-file",
		maxLinesPerFile: scope.maxLinesPerFile ?? 400,
		gateMode: scope.gateMode,
		boundaries: scope.boundaries,
	};
}

/**
 * Resolve scope for a delegation. Pure function — no side effects.
 *
 * Returns:
 * - null → caller should trigger error (e.g. coder without scope)
 * - Scope object → use this scope
 *
 * @returns Scope | null — null means "error, scope required but missing"
 */
export function resolveScope(
	params: { specialist: string; scope?: Scope },
	specialistDef: Specialist,
	cwd: string,
): Scope | null {
	const isReadOnly = !specialistDef.tools.includes('edit') && !specialistDef.tools.includes('write');

	if (params.specialist === "coder") {
		return params.scope ? normalizeExplicitScope(params.scope) : null;
	}

	if (params.specialist === "writer") {
		return params.scope ? normalizeExplicitScope(params.scope) : getDefaultWriterScope(cwd);
	}

	// Read-only specialists (scout, reviewer, researcher) get relaxed defaults
	if (isReadOnly) {
		if (!params.scope || (params.scope.filesToModify.length === 0 && params.scope.filesToCreate.length === 0)) {
			return { filesToModify: [], filesToCreate: [], directories: [], maxFiles: 10, requiresApprovalBeyondScope: false, changeType: 'multi-file', maxLinesPerFile: 400, gateMode: 'relaxed' };
		}
		return normalizeExplicitScope(params.scope);
	}

	// Other specialists: explicit scope or null
	return params.scope ? normalizeExplicitScope(params.scope) : null;
}
