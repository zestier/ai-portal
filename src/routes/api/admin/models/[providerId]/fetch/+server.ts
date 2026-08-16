// POST /api/admin/models/[providerId]/fetch — query the provider backend for
// its model list and import the results into the portal catalog.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/server/config';
import { canRedeployUser } from '$lib/server/redeploy';
import { fetchAndImportCatalog } from '$lib/server/models/catalog-service';
import * as providersRepo from '$lib/server/db/repos/providers';

export const POST: RequestHandler = async ({ locals, params }) => {
	const cfg = loadConfig();
	if (!canRedeployUser(locals.user, cfg)) {
		throw error(403, 'Model configuration requires admin access.');
	}
	if (!providersRepo.get(params.providerId)) throw error(404, 'Provider not found.');
	const result = await fetchAndImportCatalog(params.providerId);
	return json(result);
};
