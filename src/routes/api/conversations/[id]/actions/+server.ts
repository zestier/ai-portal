import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { authorizeConversationWorkdir } from "$lib/server/conversation-auth";
import { loadConfig } from "$lib/server/config";
import { canRedeployUser } from "$lib/server/redeploy";
import { loadActionsConfig } from "$lib/server/actions/config";

/**
 * List the project actions defined in the conversation's `.zap/actions.toml`.
 * Returns the metadata the UI needs to render buttons (id/label/description/
 * permission) plus `canRunAdmin` so the client can disable admin-only buttons
 * for non-admin users. Enforcement still happens on POST; this is UX only.
 *
 * A parse/validation failure surfaces as `configError` rather than a hard
 * failure, so a broken config doesn't blank the whole panel.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const { workdir } = authorizeConversationWorkdir(params.id, locals.userId);
  const cfg = loadConfig();
  const canRunAdmin = canRedeployUser(locals.user, cfg);

  const result = await loadActionsConfig(workdir);
  if (!result.ok) {
    return json({ actions: [], canRunAdmin, configError: result.error });
  }
  const actions = result.actions.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description ?? null,
    permission: a.permission,
    inputs: a.inputs.map((i) => ({
      name: i.name,
      label: i.label,
      type: i.type,
      required: i.required,
      default: i.default ?? null,
      options: i.options ?? null,
      placeholder: i.placeholder ?? null,
    })),
    commands: a.steps.map((s) => [s.command, ...s.args].join(" ")),
  }));
  return json({ actions, canRunAdmin });
};
