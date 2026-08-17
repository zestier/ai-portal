import type { PageServerLoad } from "./$types";
import * as settings from "$lib/server/db/repos/settings";
import { effectiveWorkdir } from "$lib/server/workdir";
import { loadConfig } from "$lib/server/config";
import { getDeployMetadata } from "$lib/server/deploy";
import { log } from "$lib/server/log";
import { canRedeployUser } from "$lib/server/redeploy";
import { listBuiltInPromptTemplates } from "$lib/prompt-templates";
import * as promptTemplates from "$lib/server/db/repos/prompt-templates";
import * as memoryProfiles from "$lib/server/memory/profiles";
import { listEnabledModelOptions } from "$lib/server/models/catalog-service";
import { portalToolCatalog } from "$lib/server/tools/catalog";
import { getWorkspaceFileStatus } from "$lib/server/permissions/workspace-file-gate";
import { markSeedGrants } from "./actions";

export { actions } from "./actions";

export const load: PageServerLoad = async ({ locals }) => {
  const userId = locals.userId;
  const cfg = loadConfig();
  const currentSettings = settings.get(userId) ?? settings.defaults();

  // Make sure the ticket-action defaults exist so the Prompts tab can manage
  // them even before the user has visited a page that lazy-seeds them.
  promptTemplates.ensureTicketActionDefaults(userId);

  // Garbage-collect expired grants on load so the management table
  // doesn't show TTL'd rows the matcher is already ignoring.
  const purged = settings.pruneExpiredGrants();
  if (purged > 0) log.info("settings.grants_pruned", { count: purged });

  return {
    settings: currentSettings,
    recentDecisions: settings.listRecentDecisionsForUser(userId, 25),
    grants: markSeedGrants(settings.listGrantsForUser(userId)),
    workspaceFile: getWorkspaceFileStatus(
      userId,
      effectiveWorkdir(currentSettings.defaultWorkdir),
    ),
    portalTools: portalToolCatalog(),
    builtInPromptTemplates: listBuiltInPromptTemplates(),
    promptTemplates: promptTemplates.list(userId, { status: "all" }),
    customMemoryProfiles: memoryProfiles.listCustomProfiles(userId, {
      status: "all",
    }),
    modelOptions: listEnabledModelOptions(),
    enableRedeploy: cfg.ENABLE_REDEPLOY && canRedeployUser(locals.user, cfg),
    deploy: getDeployMetadata(),
  };
};
