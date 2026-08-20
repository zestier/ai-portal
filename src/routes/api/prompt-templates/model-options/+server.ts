import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listEnabledModelOptions } from "$lib/server/models/catalog-service";

/**
 * GET /api/prompt-templates/model-options — the list of enabled portal models
 * (`providerId/modelId`) offered by the launch review dialog's model picker.
 * A thin wrapper over the catalog service so the client doesn't depend on the
 * admin-gated catalog endpoint.
 */
export const GET: RequestHandler = () => {
  return json({ modelOptions: listEnabledModelOptions() });
};
