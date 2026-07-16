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
// sending "developer" role messages (non-OpenAI APIs reject them) and to
// enable cache/session-affinity headers.
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
};

// GLM models (Zhipu AI) don't support prompt_cache_retention field.
const GLM_COMPAT = {
  ...NYRO_BASE_COMPAT,
  supportsLongCacheRetention: false,
};

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
        compat: isDeepSeek ? DEEPSEEK_COMPAT : isGlm ? GLM_COMPAT : NYRO_BASE_COMPAT,
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

    console.log(`[nyro-sync] Registered ${models.length} models from Nyro`);
  } catch (err: any) {
    console.error(`[nyro-sync] Sync failed: ${err.message ?? String(err)}. Using static models.json fallback.`);
  }
}
