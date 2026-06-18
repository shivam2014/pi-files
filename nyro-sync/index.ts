/**
 * Nyro Model Sync Extension
 * 
 * Auto-discovers models from Nyro's /v1/models endpoint on every startup.
 * Replaces static model definitions in models.json with dynamic fetch.
 * 
 * Pattern: Async extension factory — pi awaits this before continuing startup.
 * See: docs/custom-provider.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface NyroModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  capabilities?: {
    reasoning?: boolean;
    tool_call?: boolean;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  metadata?: {
    context_length?: number;
    max_output_tokens?: number;
  };
  pricing?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

interface NyroModelsResponse {
  object: string;
  data: NyroModel[];
}

const NYRO_BASE_URL = "http://localhost:19530/v1";

export default async function (pi: ExtensionAPI): Promise<void> {
  try {
    const res = await fetch(`${NYRO_BASE_URL}/models`);
    if (!res.ok) {
      console.warn(`[nyro-sync] Failed to fetch models: ${res.status} ${res.statusText}`);
      return;
    }

    const payload = (await res.json()) as NyroModelsResponse;
    if (!payload.data || !Array.isArray(payload.data) || payload.data.length === 0) {
      console.warn("[nyro-sync] No models returned from Nyro API");
      return;
    }

    const models = payload.data.map((m: NyroModel) => {
      const model: Record<string, any> = {
        id: m.id,
        name: m.id,
        reasoning: m.capabilities?.reasoning ?? false,
        input: m.capabilities?.input_modalities ?? ["text"],
      };

      // Optional fields — only include if present
      if (m.capabilities?.tool_call !== undefined) model.tool_call = m.capabilities.tool_call;
      if (m.metadata?.context_length) model.contextWindow = m.metadata.context_length;
      if (m.metadata?.max_output_tokens) model.maxTokens = m.metadata.max_output_tokens;

      // Cost — only include if non-zero (local models are free)
      if (m.pricing && (m.pricing.input || m.pricing.output)) {
        model.cost = {
          input: m.pricing.input ?? 0,
          output: m.pricing.output ?? 0,
        };
        if (m.pricing.cache_read) model.cost.cacheRead = m.pricing.cache_read;
        if (m.pricing.cache_write) model.cost.cacheWrite = m.pricing.cache_write;
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
    console.warn(`[nyro-sync] Failed to sync models: ${err.message ?? String(err)}`);
  }
}
