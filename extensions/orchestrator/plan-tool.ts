import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { setupPlanPanel, summarizeGoal, addSteps, resolvePlanPanel, modifyStep, removeStep, insertSteps } from "./plan-panel.ts";
import { debugLog } from "./debug.ts";
import { STEP_KIND_SCHEMA } from "./types.ts";
import type { SessionContext, PlanStepInput, LoopUntilStepInput, LoopUntilConfig } from "./types.ts";

function deriveGoal(goal: string | undefined, steps: string[] | undefined, ctx?: SessionContext): string {
    if (goal?.trim()) return goal.trim();
    const stepsText = steps?.filter(Boolean).join(" ").trim();
    if (stepsText) return summarizeGoal(stepsText, ctx) ?? "Untitled plan";
    return "Untitled plan";
}

// Validation helper for structured loop inputs
function validateLoopConfig(config: LoopUntilConfig): string | null {
    if (!config.criterion || config.criterion.trim().length === 0) {
        return 'Loop criterion must be non-empty';
    }
    if (!config.evaluator || config.evaluator.trim().length === 0) {
        return 'Loop evaluator specialist must be specified';
    }
    if (!config.iterationTemplate) {
        return 'Loop iteration template is required';
    }
    if (!config.iterationTemplate.specialist) {
        return 'Iteration template specialist is required';
    }
    if (!config.iterationTemplate.task) {
        return 'Iteration template task is required';
    }
    if (config.maxIterations !== undefined && (config.maxIterations < 1 || config.maxIterations > 50)) {
        return 'maxIterations must be between 1 and 50';
    }
    if (config.satisficingPasses !== undefined && (config.satisficingPasses < 1 || config.satisficingPasses > 10)) {
        return 'satisficingPasses must be between 1 and 10';
    }
    return null;
}

/** Check if a plan step input is a structured loop input */
function isLoopStep(step: any): boolean {
    return typeof step === 'object' && step !== null && 'kind' in step && step.kind === 'loop_until';
}

/** Extract string labels from mixed step input array */
function extractLabels(steps: any[]): string[] {
    return steps.map(s => typeof s === 'string' ? s : (s?.label ?? String(s)));
}

export const PLAN_TOOLS = ['plan', 'plan_add_steps', 'advance_plan_step', 'insert_step', 'remove_step', 'modify_step'] as const;

export function registerPlanTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "plan",
        label: "plan",
        description: "Declare the plan (goal + steps) before delegating work. Call this first.",
        parameters: Type.Object({
            goal: Type.String({
                description: "One-line summary of the overall goal",
            }),
            steps: Type.Array(
                Type.Union([
                    Type.String(),
                    Type.Object({
                        label: Type.String({ description: 'Step label shown in the plan panel' }),
                        kind: Type.Literal('loop_until', { description: 'Loop step — repeats body with completion condition' }),
                        loopUntil: Type.Object({
                            criterion: Type.String({ description: 'Human-readable success condition' }),
                            evaluator: Type.String({ description: 'Specialist name that evaluates results (default: reviewer)' }),
                            maxIterations: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: 'Safety cap on iterations (default: 10)' })),
                            maxTokens: Type.Optional(Type.Number({ description: 'Token budget for entire loop' })),
                            mode: Type.Optional(Type.Union([
                                Type.Literal('single-pass'),
                                Type.Literal('satisficing'),
                            ], { description: 'Evaluation mode (default: satisficing)' })),
                            satisficingPasses: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: 'Consecutive passes required (default: 2)' })),
                            iterationTemplate: Type.Object({
                                specialist: Type.String({ description: 'Specialist to delegate to each iteration' }),
                                task: Type.String({ description: 'Task template. Use {{iteration.N}} for iteration number.' }),
                            }),
                        }),
                    }),
                    Type.Object({
                        label: Type.String({ description: 'Step label shown in the plan panel' }),
                        kind: Type.Literal('delegation', { description: 'Delegation step — subagent-owned, auto-advances' }),
                    }),
                    Type.Object({
                        label: Type.String({ description: 'Step label shown in the plan panel' }),
                        kind: Type.Literal('orchestrator', { description: 'Orchestrator step — self-owned, call advance_plan_step' }),
                    }),
                ]),
                { description: 'Step labels (strings) or structured step objects (for loops)' },
            ),
            // #100: kind param on plan() is intentional — allows orchestrator to classify
            // initial steps at creation time, not just via plan_add_steps/insert_step.
            // Keeps the API consistent across all plan-modifying tools.
            kind: STEP_KIND_SCHEMA,
        }),
        promptGuidelines: [
            "Create plan: plan({ goal: 'Fix auth bug', steps: ['Read auth middleware', 'Fix token validation', 'Write tests'] })",
            "One-line goal, array of step labels describing what you'll delegate",
            "Must be called before delegate() — delegate rejects if no active plan",
            "Plan persists after all steps complete — keep delegating without re-planning. Use plan_add_steps() to add new steps if needed.",
            "Output: Returns plan registration status with goal and step count in text format",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const effectiveGoal = deriveGoal(params.goal, extractLabels(params.steps), ctx as SessionContext);
            if (!params.steps || params.steps.length === 0) {
                setupPlanPanel(effectiveGoal, ["Planning..."], ctx);
                return { content: [{ type: "text", text: `Plan set (no steps provided): ${effectiveGoal}` }], details: {} };
            }
            const processedSteps: string[] = [];
            const loopConfigs: Map<number, any> = new Map();
            for (let i = 0; i < params.steps.length; i++) {
                const step = params.steps[i];
                if (typeof step === 'string') {
                    processedSteps.push(step);
                } else if (isLoopStep(step)) {
                    const loopCfg = (step as any).loopUntil;
                    const error = validateLoopConfig(loopCfg);
                    if (error) {
                        return { content: [{ type: 'text', text: `Loop validation error: ${error}` }], details: { error } };
                    }
                    processedSteps.push((step as any).label);
                    loopConfigs.set(i, loopCfg);
                } else {
                    processedSteps.push(String(step));
                }
            }
            setupPlanPanel(effectiveGoal, processedSteps, ctx);
            // Store loop configs for later retrieval by delegate/runner
            const panel = resolvePlanPanel(ctx as SessionContext);
            if (panel && loopConfigs.size > 0) {
                // Attach loop configs to panel metadata for downstream access
                (panel as any)._loopConfigs = Object.fromEntries(loopConfigs);
            }
            return {
                content: [{ type: "text", text: `Plan set: ${effectiveGoal} (${processedSteps.length} steps)` }],
                details: { goal: effectiveGoal, steps: processedSteps, kind: params.kind },
            };
        },
        renderCall(args, theme, context) {
            return new Text(`⠋ Plan: ${deriveGoal(args.goal, extractLabels(args.steps))} (${args.steps.length} steps)`, 0, 0);
        },
        renderResult(result, options, theme, context) {
            const first = result.content?.[0];
            const text = first && first.type === "text" ? first.text : "Plan set";
            return new Text(`✓ ${text}`, 0, 0);
        },
    });
    registerPlanAddStepsTool(pi);
    registerInsertStepTool(pi);
    registerAdvancePlanStepTool(pi);
    registerModifyStepTool(pi);
    registerRemoveStepTool(pi);
}

export function registerInsertStepTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: 'insert_step',
        label: 'Insert Plan Steps',
        description: 'Insert steps at a specific position in the current plan. Use when subagent findings require inserting work between existing steps.',
        parameters: Type.Object({
            steps: Type.Array(Type.String(), { description: 'Step labels to insert' }),
            after: Type.Optional(Type.String({ description: 'Insert after this step label (must match an existing step exactly). Mutually exclusive with index.' })),
            index: Type.Optional(Type.Number({ description: 'Insert at this 0-based position (0 = beginning, steps.length = end). Mutually exclusive with after.' })),
            kind: STEP_KIND_SCHEMA,
        }),
        promptGuidelines: [
            "Insert: insert_step({ steps: ['new step'], after: 'existing step label' })",
            "Insert by index: insert_step({ steps: ['new step'], index: 2 })",
            "Exactly one of 'after' or 'index' must be provided",
            "The 'after' label must match an existing step exactly",
            "Optional kind: tool_call, agent_call, or user_action",
            "Output: Returns updated plan with inserted steps and count",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const result = insertSteps(params.steps, { after: params.after, index: params.index }, ctx as SessionContext);
            if (result.error) {
                return {
                    content: [{ type: 'text', text: result.error }],
                    details: { error: result.error },
                };
            }
            const target = params.after ? `after '${params.after}'` : `at index ${params.index}`;
            return {
                content: [{ type: 'text', text: `Inserted ${result.inserted} step(s) ${target}.` }],
                details: { inserted: result.inserted, after: params.after, index: params.index, totalSteps: result.inserted },
            };
        },
    });
}

export function registerPlanAddStepsTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "plan_add_steps",
        label: "Add Plan Steps",
        description: "Add new steps to the current active plan. Duplicate step labels are skipped.",
        parameters: Type.Object({
            steps: Type.Array(Type.String()),
            kind: STEP_KIND_SCHEMA,
        }),
        promptGuidelines: [
            "Add steps: plan_add_steps({ steps: ['New step 1', 'New step 2'] })",
            "Appends to existing plan — duplicate labels are automatically skipped",
            "Use when delegation findings reveal new work needed",
            "Output: Returns count of steps added, skipping any duplicates",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            addSteps(params.steps, ctx as SessionContext);
            return {
                content: [{ type: "text", text: `Added ${params.steps.length} step(s) to plan.` }],
                details: { kind: params.kind },
            };
        },
    });
}

export function registerAdvancePlanStepTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: 'advance_plan_step',
        label: 'Advance Plan Step',
        description: 'Mark the currently active plan step as complete and advance to the next pending step. Do not call for delegation steps (handled by delegate pipeline).',
        parameters: Type.Object({}),
        promptGuidelines: [
            "advance_plan_step() — no parameters",
            "Marks the active step complete and activates the next pending step",
            "Do NOT call for delegation steps — those are managed by the delegate pipeline",
            "Output: Returns step label that was advanced",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const panel = resolvePlanPanel(ctx as SessionContext);
            if (!panel) {
                return {
                    content: [{ type: 'text', text: 'No active plan. Call plan() first.' }],
                    details: { error: 'No active plan.' },
                };
            }
            const result = panel.advanceStep();
            if (result.status === 'error') {
                return {
                    content: [{ type: 'text', text: result.error === 'No active plan' ? 'No active plan. Call plan() first.' : 'No active step to advance.' }],
                    details: { error: result.error },
                };
            } else if (result.status === 'skipped') {
                return {
                    content: [{ type: 'text', text: 'Step managed by delegate pipeline — no-op.' }],
                    details: { status: 'no-op', reason: result.reason },
                };
            } else {
                return {
                    content: [{ type: 'text', text: `Step completed: '${result.label}'` }],
                    details: { completed: result.label },
                };
            }
        },
    });
}

export function registerModifyStepTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: 'modify_step',
        label: 'Modify Plan Step',
        description: 'Modify the label and/or kind of an existing step in the current plan.',
        parameters: Type.Object({
            index: Type.Number({ description: '1-based step index to modify' }),
            label: Type.String({ description: 'New label for the step' }),
            kind: STEP_KIND_SCHEMA,
        }),
        promptGuidelines: [
            "Modify: modify_step({ index: 2, label: 'New label' })",
            "Updates the label (and optionally kind) of the step at the given 1-based index",
            "Output: Returns success or error with reason",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const result = modifyStep(params.index, params.label, params.kind, ctx as SessionContext);
            if (result.success) {
                return {
                    content: [{ type: 'text', text: `Step ${params.index} modified: '${params.label}'` }],
                    details: { index: params.index, label: params.label, kind: params.kind },
                };
            }
            return {
                content: [{ type: 'text', text: result.error ?? 'Failed to modify step' }],
                details: { error: result.error },
            };
        },
    });
}

export function registerRemoveStepTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: 'remove_step',
        label: 'Remove Plan Step',
        description: 'Remove a pending or completed step from the current plan. Cannot remove the active step.',
        parameters: Type.Object({
            index: Type.Number({ description: '1-based step index to remove' }),
        }),
        promptGuidelines: [
            "Remove: remove_step({ index: 3 })",
            "Removes the step at the given 1-based index (cannot remove active step)",
            "Output: Returns success or error with reason",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const result = removeStep(params.index, ctx as SessionContext);
            if (result.success) {
                return {
                    content: [{ type: 'text', text: `Step ${params.index} removed.` }],
                    details: { index: params.index },
                };
            }
            return {
                content: [{ type: 'text', text: result.error ?? 'Failed to remove step' }],
                details: { error: result.error },
            };
        },
    });
}
