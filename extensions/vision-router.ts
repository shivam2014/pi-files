/**
 * Vision Router Extension
 *
 * Routes commands/tool calls through a vision-capable model from pi's model registry.
 * Config: ~/.pi/agent/vision-router.json (global) + .pi/vision-router.json (project)
 *
 * Commands:
 *   /vision <query>       — route to vision model
 *   /vision-config         — pick any model (vision ones highlighted)
 *   vision_query (tool)   — LLM-routable vision tool
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface VisionRouterConfig {
  /** "provider/modelId" — looked up in model registry */
  visionModel?: string;
  /** System instructions for the vision model */
  instructions?: string;
}

const DEFAULT_INSTRUCTIONS =
  "You are a vision-specialist model. Analyze images and answer questions about them with detailed, accurate descriptions.";

function loadConfig(cwd: string): VisionRouterConfig {
  const globalPath = join(getAgentDir(), "vision-router.json");
  const projectPath = join(cwd, ".pi", "vision-router.json");
  let config: VisionRouterConfig = {};
  if (existsSync(globalPath)) {
    try { config = { ...config, ...JSON.parse(readFileSync(globalPath, "utf-8")) }; }
    catch (e) { console.error("Failed to load global vision-router config:", e); }
  }
  if (existsSync(projectPath)) {
    try { config = { ...config, ...JSON.parse(readFileSync(projectPath, "utf-8")) }; }
    catch (e) { console.error("Failed to load project vision-router config:", e); }
  }
  return config;
}

function saveConfig(config: VisionRouterConfig, cwd: string): void {
  const projectDir = join(cwd, ".pi");
  if (!existsSync(projectDir)) {
    try { mkdirSync(projectDir, { recursive: true }); } catch { /* ignore */ }
  }
  writeFileSync(join(projectDir, "vision-router.json"), JSON.stringify(config, null, 2));
}

/** Parse "provider/modelId" string into [provider, modelId] */
function parseModelRef(ref: string): [string, string] | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) return null;
  return [ref.slice(0, slash), ref.slice(slash + 1)];
}

/** Fetch model capabilities from nyro's /v1/models endpoint */
async function fetchNyroCapabilities(): Promise<Map<string, string[]>> {
  try {
    const response = await fetch("http://localhost:19530/v1/models");
    const data = await response.json();
    const caps = new Map<string, string[]>();
    for (const model of data.data || []) {
      if (model.input_modalities) {
        caps.set(model.id, model.input_modalities);
      }
    }
    return caps;
  } catch {
    return new Map();
  }
}

interface ModelWithVisionStatus {
  model: Model<Api>;
  visionCapable: boolean;
}

/** Get ALL models, each tagged with vision-capable status */
function getAllModelsWithVisionStatus(
  ctx: ExtensionContext,
  nyroCaps: Map<string, string[]>,
): ModelWithVisionStatus[] {
  const models = ctx.modelRegistry.getAvailable();
  return models.map((m) => {
    const piVision = m.input?.includes("image") ?? false;
    const nyroInput = nyroCaps.get(m.id);
    const nyroVision = nyroInput?.includes("image") ?? false;
    return {
      model: m,
      visionCapable: piVision || nyroVision,
    };
  });
}

/** Resolve the configured vision model — try getModel() first, fall back to registry */
function resolveVisionModel(config: VisionRouterConfig, ctx: ExtensionContext): Model<Api> | null {
  if (!config.visionModel) return null;
  const parsed = parseModelRef(config.visionModel);
  if (!parsed) return null;
  const [provider, modelId] = parsed;
  // getModel() for built-in models; modelRegistry.find() for custom models from models.json
  return (getModel as any)(provider, modelId) ?? ctx.modelRegistry.find(provider, modelId) ?? null;
}

export default function (pi: ExtensionAPI) {
  let config: VisionRouterConfig = {};
  let visionModel: Model<Api> | null = null;
  let nyroCaps: Map<string, string[]> = new Map();

  async function routeToVisionModel(
    query: string,
    images: Array<{ data: string; mimeType: string }>,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const model = visionModel ?? resolveVisionModel(config, ctx);
    if (!model) {
      throw new Error(
        config.visionModel
          ? `Vision model "${config.visionModel}" not found in registry. Run /vision-config to pick a model.`
          : "No vision model configured. Run /vision-config to pick one.",
      );
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(
        auth.ok
          ? `No API key for ${model.provider}/${model.id}`
          : auth.error,
      );
    }

    const content: any[] = [{ type: "text", text: query }];
    for (const img of images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }

    const response = await complete(
      model,
      {
        systemPrompt: config.instructions ?? DEFAULT_INSTRUCTIONS,
        messages: [{ role: "user", content, timestamp: Date.now() }],
      },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );

    if (response.stopReason === "aborted") return "[Aborted]";
    return response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }

  function updateStatus(ctx: ExtensionContext) {
    const label = config.visionModel ?? "none";
    ctx.ui.setStatus("vision-router", ctx.ui.theme.fg("accent", `vision:${label}`));
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    visionModel = config.visionModel ? resolveVisionModel(config, ctx) : null;
    nyroCaps = await fetchNyroCapabilities();
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    visionModel = config.visionModel ? resolveVisionModel(config, ctx) : null;
    nyroCaps = await fetchNyroCapabilities();
    updateStatus(ctx);
  });

  pi.registerCommand("vision", {
    description: "Route a query through the vision model. Usage: /vision <question>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) { ctx.ui.notify("Usage: /vision <question>", "error"); return; }

      const model = visionModel ?? resolveVisionModel(config, ctx);
      const label = model ? `${model.provider}/${model.id}` : config.visionModel ?? "unconfigured";

      ctx.ui.notify(`Routing to ${label}...`, "info");
      try {
        const result = await routeToVisionModel(query, [], ctx);
        if (ctx.mode === "tui") await ctx.ui.editor(`Vision (${label}) Response`, result);
        else ctx.ui.notify(result.slice(0, 200), "info");
      } catch (err) {
        ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "vision_query",
    label: "Vision Query",
    description: "Route a question with optional base64 images through the configured vision model. Use for image analysis, diagrams, screenshots.",
    promptSnippet: "Use vision_query when the user asks about images, screenshots, diagrams, or visual content.",
    promptGuidelines: [
      "For image analysis, use vision_query instead of guessing visual details.",
      "Pass base64 image data with correct mimeType.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Question for the vision model" }),
      images: Type.Optional(Type.Array(Type.Object({
        data: Type.String({ description: "Base64-encoded image data" }),
        mimeType: Type.String({ description: "MIME type: image/png, image/jpeg, etc." }),
      }), { description: "Images to analyze" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await routeToVisionModel(params.query, params.images ?? [], ctx);
        const model = visionModel ?? resolveVisionModel(config, ctx);
        return {
          content: [{ type: "text", text: result }],
          details: {
            model: model ? `${model.provider}/${model.id}` : config.visionModel ?? "unconfigured",
            imageCount: params.images?.length ?? 0,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Vision query failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
        };
      }
    },
  });

  pi.registerCommand("vision-config", {
    description: "Pick any model from the registry (vision-capable models shown first)",
    handler: async (_args, ctx) => {
      const allModels = getAllModelsWithVisionStatus(ctx, nyroCaps);

      if (allModels.length === 0) {
        ctx.ui.notify("No models found in registry. Add models to your registry first.", "warning");
        return;
      }

      // Sort: vision-capable first, then text-only
      allModels.sort((a, b) => {
        if (a.visionCapable !== b.visionCapable) return a.visionCapable ? -1 : 1;
        return a.model.id.localeCompare(b.model.id);
      });

      const current = config.visionModel ?? "";

      if (ctx.mode === "tui") {
        // Build select options with ✓ marker for vision models
        const options = allModels.map((entry) => {
          const ref = `${entry.model.provider}/${entry.model.id}`;
          const isCurrent = ref === current;
          const visionMarker = entry.visionCapable ? "✓" : " ";
          const currentMarker = isCurrent ? " ◄" : "";
          return `${visionMarker} ${ref}${currentMarker} — ${entry.model.name}`;
        });

        const selected = await ctx.ui.select("Select Model (✓ = vision-capable)", options);
        if (!selected) return; // cancelled

        // Extract "provider/modelId" — skip leading "✓ " or "  "
        let trimmed = selected;
        if (trimmed.startsWith("✓ ") || trimmed.startsWith("  ")) trimmed = trimmed.slice(2);
        // Strip trailing " ◄" current marker
        if (trimmed.endsWith(" ◄")) trimmed = trimmed.slice(0, -3);
        const dashIdx = trimmed.indexOf(" — ");
        const modelRef = dashIdx > 0 ? trimmed.slice(0, dashIdx) : trimmed;

        config.visionModel = modelRef;
        visionModel = resolveVisionModel(config, ctx);
        saveConfig(config, ctx.cwd);
        updateStatus(ctx);
        ctx.ui.notify(`Vision model set to ${modelRef}`, "info");
      } else {
        // Non-TUI: list all models grouped by capability
        const visionList = allModels
          .filter((e) => e.visionCapable)
          .map((e) => `  ✓ ${e.model.provider}/${e.model.id} — ${e.model.name}`)
          .join("\n");
        const textList = allModels
          .filter((e) => !e.visionCapable)
          .map((e) => `    ${e.model.provider}/${e.model.id} — ${e.model.name}`)
          .join("\n");
        const parts = [];
        if (visionList) parts.push("Vision-capable:\n" + visionList);
        if (textList) parts.push("Text-only:\n" + textList);
        ctx.ui.notify(`All models:\n${parts.join("\n\n")}\n\nSet visionModel in ~/.pi/agent/vision-router.json`, "info");
      }
    },
  });
}
