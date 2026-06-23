/**
 * SkillPacks — distilled discipline text lifted from Matt Pocock's coding-agent
 * skills, compressed into imperative rule strings that keep weaker models on the rails.
 *
 * Design (see AGENTS.md philosophy):
 * - Tool-level, not prompt-level. The delegate tool takes a `packs` param (like `scope`).
 *   Packs exist structurally or they don't. The orchestrator declares them; if omitted,
 *   `suggestPacks(task)` auto-selects by keyword as a fallback.
 * - Per-delegation composition (1–3 packs), never all into every base prompt.
 *   Token budget is sacred for Flash-class models.
 * - Packs are short, imperative, numbered — weak models follow rules, not prose.
 *
 * A "pack" is one named discipline string. Compose only the relevant packs onto a
 * specialist's base systemPrompt at delegation time. This is the deep module:
 * small interface (compose/suggest), deep implementation (the verbatim rules below).
 *
 * Source skills (under ~/.pi/agent/skills/):
 *   clarification  ← grilling (one-question protocol)
 *   minimalAction  ← diagnosing-bugs "no red-capable command, no Phase 2" + decision-mapping
 *   tdd            ← tdd (vertical slices)
 *   diagnosis      ← diagnosing-bugs Phases 1–4
 *   reviewTwoAxis  ← review (Standards vs Spec, never rerank)
 *   prototype      ← prototype (throwaway, OPPOSITE of normal rules)
 *   implementCadence ← implement (typecheck/single-test/full-suite/review lifecycle)
 *   researcherHygiene ← teach RESOURCES-FORMAT (annotate sources, no bare links)
 *   agentBrief     ← triage AGENT-BRIEF (behavioral, no file paths/line numbers, ACs)
 *   domainModeling ← domain-modeling (active glossary, 3-condition ADR gate)
 *   handoff        ← handoff (save to temp, suggested skills, reference by path, redact)
 *   qaIssue        ← qa (no file paths, mandatory repro, prefer many thin issues)
 */

/** Max tokens a single pack should occupy — weak models follow short rules. */
const PACK_WORD_BUDGET = 160;

export const SKILL_PACKS = {
	/**
	 * One-question clarification protocol (from grilling).
	 * Applied wherever a specialist can call ask_orchestrator.
	 * KILLS the "please provide more info" non-question anti-pattern.
	 */
	clarification: `## Clarification protocol
Ask ONE question at a time. Wait for the answer before continuing. For every question, give your recommended answer first.
Self-serve before asking: if a question can be answered by reading CONTEXT.md, docs/adr/, or the codebase, do that instead of asking.
When you must ask, call ask_orchestrator({ question, context }) with ONE specific, answerable question — never "please provide more info" or compound questions.`,

	/**
	 * Minimal-action discipline (from diagnosing-bugs + decision-mapping).
	 * KILLS the documented Flash failure: told "read issue #3", read 8 unrelated files.
	 */
	minimalAction: `## Minimal action
Before each tool call, ask: what is the single smallest action that answers THIS step?
Prefer ONE targeted command over reading many files. "Read issue #3" means run \`gh issue view 3\`, not read 8 source files to "understand context".
If you have read more than 3 files without narrowing the question, STOP and call ask_orchestrator. Broad exploration is drift, not diligence.`,

	/**
	 * TDD discipline (from tdd). Per-delegation for coder on test-bearing work.
	 */
	tdd: `## TDD — vertical slices only
One test → one implementation → repeat. NEVER write all tests then all implementation (horizontal slicing produces bad tests).
Per cycle: write ONE failing test → run it, see it fail → write minimal code to pass → run, see it pass → refactor ONLY while GREEN.
Tests verify behavior through public interfaces. If renaming an internal function breaks a test, that test is wrong — fix the test.
Mock at system boundaries only (external APIs, DB, time, filesystem). Never mock your own modules or internal collaborators.
Don't anticipate future tests. Don't add speculative features.`,

	/**
	 * Bug diagnosis Phases 1–4 (from diagnosing-bugs). Scout read-only work.
	 * Phase 5 (write regression test + fix) escalates to coder.
	 */
	diagnosis: `## Diagnosis — feedback loop first
Build a feedback loop FIRST. Find ONE command that reproduces the symptom (failing test / curl / CLI). No loop, no diagnosis.
Do NOT read code to theorize before that command exists AND you have run it at least once. Paste the command and its output.
Generate 3–5 ranked falsifiable hypotheses BEFORE testing any. Format: "If X is the cause, changing Y makes the bug disappear." If you can't state a prediction, the hypothesis is a vibe — discard it.
Instrument ONE variable at a time. Tag every debug log \`[DEBUG-a4f2]\` so you can remove it. Never "log everything and grep".
If you can't build a loop, STOP — say so explicitly and call ask_orchestrator for access or a captured artifact.
You are read-only: the regression test + fix escalate to coder.`,

	/**
	 * Two-axis review (from review). Replaces single-axis Critical/Warnings/Suggestions.
	 * Output sections: ## Standards and ## Spec — never merge or rerank across axes.
	 */
	reviewTwoAxis: `## Two-axis review (keep axes separate — never merge or rerank)
### Standards axis
Does the code conform to documented standards? Report per file/hunk. Cite the standard (file + rule). Distinguish hard violations from judgement calls. Skip anything the linter/formatter enforces.
### Spec axis
Does the diff implement the originating issue/PRD/spec? Report: (a) requirements missing or partial; (b) behaviour present but NOT asked for = scope creep; (c) implemented but wrong. Quote the spec line for each finding.
Cap each axis ~400 words. End with: total findings + worst issue PER axis. No overall winner across axes.
Output:
## Standards
<findings, or "none">
## Spec
<findings, or "none">`,

	/**
	 * Prototype sub-mode (from prototype). OPPOSITE of normal coder rules.
	 * Only inject on explicitly-throwaway work — never combine with tdd.
	 */
	prototype: `## Prototype — throwaway code answering ONE question
This is THROWAWAY code. Mark it clearly. One command to run. No persistence. No tests. No error handling beyond runnable. No abstractions.
After every action, print the full relevant state.
Isolate real logic in a PURE module behind a small interface (could be lifted out). The TUI/shell around it is throwaway; the logic module shouldn't be.
The ANSWER is the only thing worth keeping. Never promote prototype code directly to production.`,

	/**
	 * Implement lifecycle cadence (from implement). Always-on for coder.
	 */
	implementCadence: `## Implementation cadence
Make EXACTLY the described changes — nothing extra, no gold-plating, no speculative abstractions.
Typecheck regularly. Run the single relevant test file regularly. Run the full suite ONCE at the end.
When done, the orchestrator delegates review — do not self-declare "done" without verification passing.`,

	/**
	 * Researcher hygiene (from teach RESOURCES-FORMAT). Always-on for researcher.
	 */
	researcherHygiene: `## Research hygiene
Never trust your parametric knowledge — verify against sources.
Annotate EVERY source. A bare link is useless in three months; always add a one-line note on why the source matters.
Prune ruthlessly. Five sharp sources beat thirty mediocre ones. Cross-reference claims against the codebase when a local equivalent exists — if the code contradicts a source, surface the contradiction.`,

	/**
	 * Agent-brief writing (from triage AGENT-BRIEF). For writer producing specs/issues.
	 */
	agentBrief: `## Durable artifact rules
Write for durability, not precision:
- No file paths or line numbers — they go stale. Describe behaviors, not code locations.
- Use the project's domain language (check CONTEXT.md). "The sync service fails to apply the patch", not "applyPatch() throws on line 42".
- Every acceptance criterion must be concrete and independently verifiable. Good: "\`gh issue list --label needs-triage\` returns triaged issues". Bad: "triage works correctly".
- State what is OUT OF SCOPE explicitly — prevents gold-plating.
Reproduction steps are mandatory for bug reports.`,

	/**
	 * Domain modeling (from domain-modeling). For writer maintaining CONTEXT.md / ADRs.
	 */
	domainModeling: `## Domain modeling — active glossary
CONTEXT.md is a GLOSSARY and nothing else: tight definitions (1–2 sentences), opinionated, with _Avoid:_ alias lists. No implementation details, no specs.
Update the glossary INLINE as terms crystallize — don't batch. Challenge fuzzy language: "you say 'account' — Customer or User? Those are different."
Offer an ADR ONLY when ALL three are true: hard to reverse, surprising without context, the result of a real trade-off. If any is missing, skip the ADR. An ADR can be one paragraph — the value is recording THAT and WHY, not filling out sections.`,

	/**
	 * Handoff writing (from handoff). For writer producing handoff docs.
	 */
	handoff: `## Handoff doc
Save to the OS temp directory, NOT the workspace.
Do NOT duplicate content already in PRDs/plans/ADRs/issues/commits/diffs — reference them by path or URL.
Include a "suggested skills" section naming skills the next session should invoke.
Redact secrets (API keys, passwords, PII).`,

	/**
	 * QA issue filing (from qa). For writer/researcher filing GitHub issues.
	 */
	qaIssue: `## Issue filing rules
Prefer MANY thin issues over few thick ones — each independently fixable and verifiable.
Create issues in dependency order so you can reference real issue numbers in "Blocked by". Mark blocking relationships honestly.
Rules for all issue bodies:
- No file paths or line numbers.
- Describe behaviors, not code.
- Reproduction steps are MANDATORY.
- Keep it concise — readable in 30 seconds.
Don't over-interview: at most 2–3 short clarifying questions, focused on expected vs actual and repro.`,

	/**
	 * Glossary terms (structural, not free-text). Orchestrator injects task-relevant
	 * terms from CONTEXT.md so the weak model uses the right domain vocabulary
	 * without loading the whole file. The {{TERMS}} placeholder is replaced.
	 */
	glossaryTerms: `## Project domain terms
Use these project domain terms EXACTLY. Do not invent synonyms or rename them.
{{TERMS}}`,
} as const;

export type SkillPackName = keyof typeof SKILL_PACKS;

/**
 * Compose selected packs onto a base system prompt.
 * Dedupes, preserves stable declaration order, caps per-pack size defensively.
 * Returns the base prompt unchanged if no packs resolve.
 *
 * @param basePrompt The specialist's base systemPrompt.
 * @param packs Pack names to append (unknown names are ignored — fail soft).
 * @param packReplacements Optional {packName: replacements} for templates like glossaryTerms.
 */
export function composePacks(
	basePrompt: string,
	packs: string[] | undefined,
	packReplacements?: Partial<Record<SkillPackName, string>>,
): string {
	if (!packs || packs.length === 0) return basePrompt;

	const seen = new Set<string>();
	const blocks: string[] = [];
	for (const name of packs) {
		const key = name as SkillPackName;
		if (!(key in SKILL_PACKS) || seen.has(key)) continue;
		seen.add(key);
		let text: string = SKILL_PACKS[key];
		const repl = packReplacements?.[key];
		if (repl !== undefined) {
			text = text.replace("{{TERMS}}", repl);
		}
		blocks.push(text);
	}
	if (blocks.length === 0) return basePrompt;
	return `${basePrompt}\n\n${blocks.join("\n\n")}`;
}

/**
 * Keyword heuristic for auto-selecting packs when the orchestrator omits `packs`.
 * Deliberately conservative — false positives inject unwanted discipline. The
 * orchestrator's explicit `packs` always wins over this.
 *
 * @param task The delegation task text.
 * @returns 0–3 suggested pack names. Never includes mutually-exclusive packs
 *          (e.g. tdd + prototype) together.
 */
export function suggestPacks(task: string): string[] {
	const t = task.toLowerCase();
	const suggestions: string[] = [];

	const has = (...words: string[]) => words.some(w => t.includes(w));

	// Bug/diagnosis work → scout discipline
	if (has("bug", "crash", "error", "regress", "flaky", "race condition", "deadlock", "hang")) {
		suggestions.push("diagnosis");
	}
	// Test-bearing implementation
	if (has("test", "spec", "unit test", "integration test", "tdd", "red-green")) {
		suggestions.push("tdd");
	}
	// Review
	if (has("review", "diff", "pull request", " pr ", "pr:", "critique")) {
		suggestions.push("reviewTwoAxis");
	}
	// Explicitly throwaway
	if (has("prototype", "spike", "throwaway", "throw-away", "proof of concept", "poc")) {
		suggestions.push("prototype");
	}
	// Issue/bug filing
	if (has("file issue", "file an issue", "create issue", "gh issue create", "triage")) {
		suggestions.push("qaIssue");
	}
	// Handoff doc
	if (has("handoff", "hand-off", "summarize this session", "compact the conversation")) {
		suggestions.push("handoff");
	}
	// Spec/brief authoring
	if (has("write a spec", "agent brief", "prd", "acceptance criteria", "spec for")) {
		suggestions.push("agentBrief");
	}

	// Mutual exclusion: never tdd + prototype together (opposite disciplines).
	if (suggestions.includes("prototype") && suggestions.includes("tdd")) {
		suggestions.splice(suggestions.indexOf("tdd"), 1);
	}

	// Cap at 3 — per-delegation token budget.
	return suggestions.slice(0, 3);
}

/** List all available pack names (for docs / introspection). */
export function listPacks(): string[] {
	return Object.keys(SKILL_PACKS);
}

/** Type guard: is the given name a valid pack? */
export function isPack(name: string): name is SkillPackName {
	return name in SKILL_PACKS;
}

// Re-export the budget for tests / assertions.
export const _PACK_WORD_BUDGET = PACK_WORD_BUDGET;
