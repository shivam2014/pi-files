import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { setupPlanPanel } from "./plan-panel.ts";

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
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            if (!params.steps || params.steps.length === 0) {
                setupPlanPanel(params.goal || "Plan", ["Planning..."], ctx);
                return { content: [{ type: "text", text: "Plan set (no steps provided)" }], details: {} };
            }
            setupPlanPanel(params.goal, params.steps, ctx);
            return {
                content: [{ type: "text", text: `Plan set: ${params.goal} (${params.steps.length} steps)` }],
                details: { goal: params.goal, steps: params.steps },
            };
        },
        renderCall(args, theme, context) {
            return new Text(`⠋ Plan: ${args.goal} (${args.steps.length} steps)`, 0, 0);
        },
        renderResult(result, options, theme, context) {
            const first = result.content?.[0];
            const text = first && first.type === "text" ? first.text : "Plan set";
            return new Text(`✓ ${text}`, 0, 0);
        },
    });
}
