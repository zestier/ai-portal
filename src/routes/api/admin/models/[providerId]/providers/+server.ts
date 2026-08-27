// GET /api/admin/models/[providerId]/providers — provider names for the
// OpenRouter routing picker, derived on demand from the provider's /models
// endpoint (the distinct endpoints[].provider_name values).

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadConfig } from "$lib/server/config";
import { canRedeployUser } from "$lib/server/redeploy";
import {
  DEFAULT_BASE_URLS,
  fetchOpenRouterProviders,
} from "$lib/server/models/fetch-catalog";
import * as providersRepo from "$lib/server/db/repos/providers";

export const GET: RequestHandler = async ({ locals, params }) => {
  const cfg = loadConfig();
  if (!canRedeployUser(locals.user, cfg)) {
    throw error(403, "Model configuration requires admin access.");
  }
  const provider = providersRepo.get(params.providerId);
  if (!provider) throw error(404, "Provider not found.");
  if (provider.id !== "openrouter") return json({ providers: [] });
  if (!provider.hasKey) throw error(400, "Save an API key first.");
  const baseUrl = provider.baseUrl ?? DEFAULT_BASE_URLS[provider.id];
  const key = providersRepo.getApiKey(provider.id)!;
  const providers = await fetchOpenRouterProviders(baseUrl, key);
  return json({ providers });
};
