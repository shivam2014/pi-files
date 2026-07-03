import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { setupPlanPanel, summarizeGoal, addSteps } from "./plan-panel.ts";
import { debugLog } from "./debug.ts";
import type { SessionContext } from "./types.ts";

function deriveGoal(goal: string | undefined, steps: string[] | undefined, ctx?: SessionContext): string {
    if (goal?.trim()) return goal.trim();
    const stepsText = steps?.filter(Boolean).join(" ").trim();
    if (stepsText) return summarizeGoal(stepsText) ?? "Untitled plan";
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
        }),
        promptGuidelines: [
            "Create plan: plan({ goal: 'Fix auth bug', steps: ['Read auth middleware', 'Fix token validation', 'Write tests'] })",
            "One-line goal, array of step labels describing what you'll delegate",
            "Must be called before delegate() — delegate rejects if no active plan",
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
                details: { goal: effectiveGoal, steps: params.steps },
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
}

export function registerPlanAddStepsTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "plan_add_steps",
        label: "Add Plan Steps",
        description: "Add new steps to the current active plan. Duplicate step labels are skipped.",
        parameters: Type.Object({
            steps: Type.Array(Type.String()),
        }),
        promptGuidelines: [
            "Add steps: plan_add_steps({ steps: ['New step 1', 'New step 2'] })",
            "Appends to existing plan — duplicate labels are automatically skipped",
            "Use when delegation findings reveal new work needed",
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            addSteps(params.steps, ctx as SessionContext);
            return {
                content: [{ type: "text", text: `Added ${params.steps.length} step(s) to plan.` }],
                details: {},
            };
        },
    });
}
