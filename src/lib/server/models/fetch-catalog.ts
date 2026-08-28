// Portal-side provider catalog fetching.
//
// pi does NOT list models from provider backends — built-in catalogs are
// bundled statically. This module implements the "query the backend" half of
// the Models feature: given a provider with a stored key, hit the provider's
// model-list endpoint and map whatever metadata it exposes (context window,
// max output tokens, pricing) into FetchedModel entries the UI can upsert into
// the portal catalog.
//
// Coverage per API type:
//   anthropic-messages  — GET /v1/models  → id, display_name, context_window, max_output_tokens
//   openrouter          — GET /api/v1/models → id, name, context_length, pricing (per token)
//   openai-*            — GET /models     → id only (no context/pricing from the API)
//   google-generative-ai— GET /models     → name, displayName

import type { FetchedModel, ManagedProvider } from "$lib/types";
import * as providersRepo from "../db/repos/providers";

export interface FetchCatalogResult {
  models: FetchedModel[];
  /** Where the models came from, e.g. "api.anthropic.com/v1/models". */
  source: string;
}

/** Default base URLs for known built-in providers when the operator leaves it unset. */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

const ANTHROPIC_VERSION = "2023-06-01";
const FETCH_TIMEOUT_MS = 20_000;

/** Append a path to a base URL regardless of trailing slashes. */
function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      `Catalog request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Catalog request to ${url} failed (${res.status}): ${body}`,
    );
  }
  return res.json();
}

interface AnthropicModel {
  id: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
}

/** GET /v1/models (paginated with limit + has_more). */
async function fetchAnthropic(
  baseUrl: string,
  key: string,
): Promise<FetchCatalogResult> {
  const models: FetchedModel[] = [];
  let cursor: string | undefined;
  // Anthropic's list is small; loop defensively against runaway pagination.
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("after_id", cursor);
    const url = `${endpoint(baseUrl, "v1/models")}?${params.toString()}`;
    const json = (await getJson(url, {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    })) as { data?: AnthropicModel[]; has_more?: boolean; last_id?: string };
    for (const m of json.data ?? []) {
      const model: FetchedModel = { id: m.id };
      if (m.display_name) model.name = m.display_name;
      if (m.context_window) model.contextWindow = m.context_window;
      if (m.max_output_tokens) model.maxTokens = m.max_output_tokens;
      models.push(model);
    }
    if (!json.has_more || !json.last_id) break;
    cursor = json.last_id;
  }
  return {
    models,
    source: `${new URL(endpoint(baseUrl, "v1/models")).host}/v1/models`,
  };
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
  };
}

/** OpenRouter's /models endpoint is the richest generic source: context + pricing. */
async function fetchOpenRouter(
  baseUrl: string,
  key: string,
): Promise<FetchCatalogResult> {
  const json = (await getJson(endpoint(baseUrl, "models"), {
    authorization: `Bearer ${key}`,
  })) as { data?: OpenRouterModel[] };
  const models: FetchedModel[] = [];
  for (const m of json.data ?? []) {
    const model: FetchedModel = { id: m.id };
    if (m.name) model.name = m.name;
    if (m.context_length) model.contextWindow = m.context_length;
    if (m.pricing) {
      // OpenRouter pricing is per token; pi's cost is per million tokens.
      const input = Number(m.pricing.prompt);
      const output = Number(m.pricing.completion);
      if (Number.isFinite(input) && input >= 0) {
        model.cost = {
          input: input * 1_000_000,
          output: Number.isFinite(output) ? output * 1_000_000 : 0,
        };
      }
    }
    models.push(model);
  }
  return {
    models,
    source: `${new URL(endpoint(baseUrl, "models")).host}/models`,
  };
}

export async function fetchOpenRouterProviders(
  baseUrl: string,
  key: string,
  modelId: string,
): Promise<string[]> {
  if (!key) {
    throw new Error("No API key stored — save an API key first.");
  }
  const json = (await getJson(
    endpoint(baseUrl, `models/${modelId}/endpoints`),
    {
      authorization: `Bearer ${key}`,
    },
  )) as { data?: { endpoints?: { provider_id?: string }[] } };
  const seen = new Set<string>();
  for (const ep of json.data?.endpoints ?? []) {
    // openRouterRouting order/only/ignore take provider ids (slugs, e.g.
    // "deepseek", "together"), not provider_name display names — surface only
    // the slug; skip any endpoint that has no provider_id.
    const slug = ep.provider_id?.trim();
    if (slug) seen.add(slug);
  }
  return [...seen].sort();
}

/** Generic OpenAI-compatible /models: ids only (Ollama, vLLM, gateways, OpenAI). */
async function fetchOpenAiCompatible(
  baseUrl: string,
  key: string,
): Promise<FetchCatalogResult> {
  const json = (await getJson(endpoint(baseUrl, "models"), {
    authorization: `Bearer ${key}`,
  })) as { data?: { id: string; owned_by?: string }[] };
  const models: FetchedModel[] = (json.data ?? []).map((m) => ({ id: m.id }));
  return {
    models,
    source: `${new URL(endpoint(baseUrl, "models")).host}/models`,
  };
}

interface GoogleModel {
  name?: string; // "models/gemini-2.0-flash"
  displayName?: string;
}

/** GET /models?key=… — Google uses a query-string API key. */
async function fetchGoogle(
  baseUrl: string,
  key: string,
): Promise<FetchCatalogResult> {
  const url = `${endpoint(baseUrl, "models")}?key=${encodeURIComponent(key)}`;
  const json = (await getJson(url, {})) as { models?: GoogleModel[] };
  const models: FetchedModel[] = [];
  for (const m of json.models ?? []) {
    const id = m.name?.replace(/^models\//, "");
    if (!id) continue;
    const model: FetchedModel = { id };
    if (m.displayName) model.name = m.displayName;
    models.push(model);
  }
  return {
    models,
    source: `${new URL(endpoint(baseUrl, "models")).host}/models`,
  };
}

/**
 * Fetch the model list for a portal provider using its stored key. Throws with
 * a user-facing message when the key is missing or the request fails.
 */
export async function fetchProviderCatalog(
  provider: ManagedProvider,
): Promise<FetchCatalogResult> {
  const key = providersRepo.getApiKey(provider.id);
  if (!key) {
    throw new Error(
      `No API key stored for provider "${provider.id}" — save one first.`,
    );
  }
  const baseUrl = provider.baseUrl ?? DEFAULT_BASE_URLS[provider.id];
  if (!baseUrl) {
    throw new Error(
      `No base URL for provider "${provider.id}" — set one to fetch its catalog.`,
    );
  }
  switch (provider.api) {
    case "anthropic-messages":
      return fetchAnthropic(baseUrl, key);
    case "google-generative-ai":
      return fetchGoogle(baseUrl, key);
    case "openai-completions":
    case "openai-responses":
      if (provider.id === "openrouter") return fetchOpenRouter(baseUrl, key);
      return fetchOpenAiCompatible(baseUrl, key);
  }
}
