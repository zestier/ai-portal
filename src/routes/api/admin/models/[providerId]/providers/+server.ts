// GET /api/admin/models/[providerId]/providers — provider ids (slugs) for the
// OpenRouter routing picker, derived on demand from a model's /endpoints
// endpoint (the distinct endpoints[].provider_id values).

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadConfig } from "$lib/server/config";
import { canRedeployUser } from "$lib/server/redeploy";
import {
  DEFAULT_BASE_URLS,
  fetchOpenRouterProviders,
} from "$lib/server/models/fetch-catalog";
import * as providersRepo from "$lib/server/db/repos/providers";

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const cfg = loadConfig();
  if (!canRedeployUser(locals.user, cfg)) {
    throw error(403, "Model configuration requires admin access.");
  }
  const provider = providersRepo.get(params.providerId);
  if (!provider) throw error(404, "Provider not found.");
  if (provider.id !== "openrouter") return json({ providers: [] });
  if (!provider.hasKey) throw error(400, "Save an API key first.");
  const modelId = url.searchParams.get("model");
  if (!modelId) throw error(400, "model query param is required.");
  const baseUrl = provider.baseUrl ?? DEFAULT_BASE_URLS[provider.id];
  const key = providersRepo.getApiKey(provider.id)!;
  const providers = await fetchOpenRouterProviders(baseUrl, key, modelId);
  return json({ providers });
};
