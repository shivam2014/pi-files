/**
 * Nyro Model Sync Extension
 * 
 * Auto-discovers models from Nyro's /v1/models endpoint on every startup.
 * Replaces static model definitions in models.json with dynamic fetch.
 * 
 * Pattern: Async extension factory — pi awaits this before continuing startup.
 * See: docs/custom-provider.md
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Actual Nyro /v1/models response — flat fields, NOT nested under wrappers. */
interface NyroModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  max_context_length?: number;
  max_output_tokens?: number;
  input_cost?: number;
  output_cost?: number;
}

interface NyroModelsResponse {
  object: string;
  data: NyroModel[];
}

const NYRO_BASE_URL = "http://localhost:19530/v1";

// Generic compat for all nyro-proxied models. Required to prevent Pi from
// sending "developer" role messages (non-OpenAI APIs reject them).
const NYRO_BASE_COMPAT = {
  supportsLongCacheRetention: true,
  sendSessionAffinityHeaders: true,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
};

// DeepSeek models additionally need custom reasoning format handling.
const DEEPSEEK_COMPAT = {
  ...NYRO_BASE_COMPAT,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  reasoningEffortMap: {
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
  },
};

// Kimi models (Moonshot) use the same thinking toggle as DeepSeek.
// Confirmed by pi issues #5531, #4251, #5309.
const KIMI_COMPAT = {
  ...NYRO_BASE_COMPAT,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
};

// GLM models (Zhipu AI) don't support prompt_cache_retention field.
const GLM_COMPAT = {
  ...NYRO_BASE_COMPAT,
  supportsLongCacheRetention: false,
};

// Moonshot Flavored JSON Schema (MFJS) normalizer.
// Moonshot/Kimi rejects standard JSON Schema constructs that OpenAI accepts.
// This normalizes tool parameter schemas to MFJS compliance.
// Reference: https://github.com/MoonshotAI/walle/blob/main/docs/mfjs-spec.md
const MFJS_FORBIDDEN_KEYWORDS = new Set([
  "const", "oneOf", "allOf", "nullable", "prefixItems",
  "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "format", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "uniqueItems", "title", "$schema",
  "$comment", "default", "examples",
]);

function normalizeSchemaForMoonshot(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeSchemaForMoonshot);

  const out: any = {};

  for (const [key, value] of Object.entries(schema)) {
    // Strip forbidden keywords
    if (MFJS_FORBIDDEN_KEYWORDS.has(key)) continue;

    // Recurse into known container keywords
    if (key === "properties" && typeof value === "object" && value !== null) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalizeSchemaForMoonshot(v)])
      );
      continue;
    }
    if ((key === "items" || key === "additionalProperties") && typeof value === "object") {
      out[key] = normalizeSchemaForMoonshot(value);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map(normalizeSchemaForMoonshot);
      continue;
    }

    out[key] = value;
  }

  // Fix: anyOf/oneOf with parent type → move type into each branch
  if (out.type && (out.anyOf || out.oneOf)) {
    const combinerKey = out.anyOf ? "anyOf" : "oneOf";
    const parentType = out.type;
    delete out.type;
    for (const branch of out[combinerKey]) {
      if (!branch.type) branch.type = parentType;
    }
  }

  // Strip $ref siblings (description after $ref causes conflicts)
  if (out.$ref) {
    delete out.description;
    delete out.title;
  }

  // Infer missing type from enum/const values
  if (!out.type && out.enum && Array.isArray(out.enum) && out.enum.length > 0) {
    const first = out.enum[0];
    if (typeof first === "string") out.type = "string";
    else if (typeof first === "number") out.type = "number";
    else if (typeof first === "boolean") out.type = "boolean";
    else if (Array.isArray(first)) out.type = "array";
    else if (typeof first === "object") out.type = "object";
  }

  // Collapse const to enum
  if (out.const !== undefined) {
    out.enum = [out.const];
    delete out.const;
  }

  return out;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  try {
    const res = await fetch(`${NYRO_BASE_URL}/models`);
    if (!res.ok) {
      console.error(`[nyro-sync] Fetch failed: ${res.status} ${res.statusText}. Using static models.json fallback.`);
      return;
    }

    const payload = (await res.json()) as NyroModelsResponse;
    if (!payload.data || !Array.isArray(payload.data) || payload.data.length === 0) {
      console.error("[nyro-sync] Nyro API returned 0 models. Using static models.json fallback.");
      return;
    }

    const models = payload.data.map((m: NyroModel) => {
      // Nyro API fields are flat at top level (not nested under
      // capabilities/metadata/pricing). Always set ALL required
      // ProviderModelConfig fields to prevent compaction crashes
      // (e.g. model.cost.input on undefined).
      const isDeepSeek = m.id.toLowerCase().includes("deepseek");
      const isGlm = m.id.toLowerCase().includes("glm");
      const isKimi = m.id.toLowerCase().includes("kimi");

      const model: ProviderModelConfig & Record<string, any> = {
        id: m.id,
        name: m.id,
        reasoning: isDeepSeek ? true : (m.reasoning ?? false),
        input: (m.input_modalities as ("text" | "image")[] | undefined) ?? ["text"],
        contextWindow: m.max_context_length ?? 128000,
        maxTokens: m.max_output_tokens ?? 4096,
        cost: {
          input: m.input_cost ?? 0,
          output: m.output_cost ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        compat: isDeepSeek ? DEEPSEEK_COMPAT : isKimi ? KIMI_COMPAT : isGlm ? GLM_COMPAT : NYRO_BASE_COMPAT,
      };

      if (m.tool_call !== undefined) model.tool_call = m.tool_call;

      // thinkingLevelMap for DeepSeek reasoning models
      if (isDeepSeek) {
        model.thinkingLevelMap = {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: "max",
        };
      }

      return model;
    });

    pi.registerProvider("nyro", {
      baseUrl: NYRO_BASE_URL,
      apiKey: "nyro",
      api: "openai-completions",
      models,
    });

	    // before_provider_request hook:
	    // - Kimi + DeepSeek: strip temperature/top_p + normalize tool schemas
	    // - Session affinity headers stripped by nyro router middleware
	    pi.on("before_provider_request", (event: any, ctx: any) => {
	      const model = ctx?.model;
	      if (!model) return;
	      const baseUrl = (model as any).baseUrl ?? "";
	      if (typeof baseUrl !== "string" || !baseUrl.includes("localhost:19530")) return;
	      const id = model.id?.toLowerCase() ?? "";
	      const payload = event?.payload;
	      if (!payload || typeof payload !== "object") return;

      // Kimi + DeepSeek: strip temperature/top_p
      // Console Go rejects top_p=0 (valid range is (0, 1.0])
      // See github.com/anomalyco/opencode/issues/37231
      if (id.includes("kimi") || id.includes("deepseek")) {
        delete payload.temperature;
        delete payload.top_p;
      }

      // Kimi + DeepSeek: normalize tool schemas to Moonshot Flavored JSON Schema
      if ((id.includes("kimi") || id.includes("deepseek")) && payload.tools && Array.isArray(payload.tools)) {
        for (const tool of payload.tools) {
          if (tool?.function?.parameters) {
            tool.function.parameters = normalizeSchemaForMoonshot(tool.function.parameters);
          }
        }
      }
    });

    console.log(`[nyro-sync] Registered ${models.length} models from Nyro`);
  } catch (err: any) {
    console.error(`[nyro-sync] Sync failed: ${err.message ?? String(err)}. Using static models.json fallback.`);
  }
}