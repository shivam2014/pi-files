/**
 * Per-specialist default scope policies.
 * Extracted from resolve-delegation-scope.ts during scope consolidation (Issue #96).
 */

import type { Scope } from "./scope-manager.ts";

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

/** Default scope for read-only specialists (scout, reviewer, researcher) */
export function getReadOnlyDefaultScope(): Scope {
	return {
		filesToModify: [],
		filesToCreate: [],
		directories: [],
		maxFiles: 10,
		requiresApprovalBeyondScope: false,
		changeType: 'multi-file',
		maxLinesPerFile: 400,
		gateMode: 'relaxed',
	};
}
