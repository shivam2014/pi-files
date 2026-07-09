import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { setupPlanPanel, summarizeGoal, addSteps, resolvePlanPanel } from "./plan-panel.ts";
import { debugLog } from "./debug.ts";
import { STEP_KIND_SCHEMA } from "./types.ts";
import type { SessionContext } from "./types.ts";

function deriveGoal(goal: string | undefined, steps: string[] | undefined, ctx?: SessionContext): string {
    if (goal?.trim()) return goal.trim();
    const stepsText = steps?.filter(Boolean).join(" ").trim();
    if (stepsText) return summarizeGoal(stepsText, ctx) ?? "Untitled plan";
    return "Untitled plan";
}

export function registerPlanTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "plan",
        label: "plan",
        description: "Declare the plan (goal + steps) before delegating work. Call this first.",
        parameters: Type.Object({
            goal: Type.String({
                description: "One-line summary of the overall goal",
            }),
            steps: Type.Array(Type.String(), {
                description: "Ordered list of steps to accomplish the goal",
            }),
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
            const effectiveGoal = deriveGoal(params.goal, params.steps, ctx as SessionContext);
            if (!params.steps || params.steps.length === 0) {
                setupPlanPanel(effectiveGoal, ["Planning..."], ctx);
                return { content: [{ type: "text", text: `Plan set (no steps provided): ${effectiveGoal}` }], details: {} };
            }
            setupPlanPanel(effectiveGoal, params.steps, ctx);
            return {
                content: [{ type: "text", text: `Plan set: ${effectiveGoal} (${params.steps.length} steps)` }],
                details: { goal: effectiveGoal, steps: params.steps, kind: params.kind },
            };
        },
        renderCall(args, theme, context) {
            return new Text(`⠋ Plan: ${deriveGoal(args.goal, args.steps)} (${args.steps.length} steps)`, 0, 0);
        },
        renderResult(result, options, theme, context) {
            const first = result.content?.[0];
            const text = first && first.type === "text" ? first.text : "Plan set";
            return new Text(`✓ ${text}`, 0, 0);
        },
    });
    registerPlanAddStepsTool(pi);
    registerInsertStepTool(pi);
}

export function registerInsertStepTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: 'insert_step',
        description: 'Insert steps at a specific position in the current plan. Use when subagent findings require inserting work between existing steps.',
        parameters: Type.Object({
            steps: Type.Array(Type.String(), { description: 'Step labels to insert' }),
            after: Type.String({ description: 'Insert after this step label (must match an existing step exactly)' }),
            kind: STEP_KIND_SCHEMA,
        }),
        promptGuidelines: [
            "Insert: insert_step({ steps: ['new step'], after: 'existing step label' })",
            "Inserts steps immediately after the specified step in the plan",
            "The 'after' label must match an existing step exactly",
            "Optional kind: tool_call, agent_call, or user_action",
            "Output: Returns updated plan with inserted steps and count",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const panel = resolvePlanPanel(ctx as SessionContext);
            if (!panel) {
                return {
                    content: [{ type: 'text', text: 'No active plan. Call plan() first.' }],
                    details: { error: 'No active plan. Call plan() first.' },
                };
            }
            const state = panel.getPlanState();
            if (!state) {
                return {
                    content: [{ type: 'text', text: 'No active plan. Call plan() first.' }],
                    details: { error: 'Plan state is empty. Call plan() first.' },
                };
            }
            const afterIdx = state.steps.findIndex(s => s.label === params.after);
            if (afterIdx < 0) {
                return {
                    content: [{ type: 'text', text: `Step '${params.after}' not found in plan.` }],
                    details: { error: `Step '${params.after}' not found in current plan.` },
                };
            }
            let inserted = 0;
            for (const label of params.steps) {
                if (state.steps.some(s => s.label === label)) continue;
                const newStep: any = {
                    label,
                    completed: false,
                    errored: false,
                    active: false,
                    startTime: Date.now(),
                };
                if (params.kind) newStep.kind = params.kind;
                state.steps.splice(afterIdx + 1 + inserted, 0, newStep);
                inserted++;
            }
            return {
                content: [{ type: 'text', text: `Inserted ${inserted} step(s) after '${params.after}'.` }],
                details: { inserted, after: params.after, totalSteps: state.steps.length },
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
