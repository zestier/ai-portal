// GET /api/admin/models/[providerId]/pi-catalog — the runtime's current
// (bundled) catalog for a built-in provider, so the UI can offer one-click
// import without hitting the provider backend. POST imports those models into
// the portal catalog.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserId } from '$lib/server/auth/require';
import { loadConfig } from '$lib/server/config';
import { canRedeployUser } from '$lib/server/redeploy';
import { getModelRuntime } from '$lib/server/pi';
import { importFromPiCatalog } from '$lib/server/models/catalog-service';
import * as providersRepo from '$lib/server/db/repos/providers';

function admin(locals: App.Locals): void {
	requireUserId(locals);
	const cfg = loadConfig();
	if (!canRedeployUser(locals.user, cfg)) {
		throw error(403, 'Model configuration requires admin access.');
	}
}

function requireBuiltin(providerId: string): void {
	const provider = providersRepo.get(providerId);
	if (!provider) throw error(404, 'Provider not found.');
	if (!provider.builtin) throw error(400, 'Only built-in providers have a bundled pi catalog.');
}

export const GET: RequestHandler = async ({ locals, params }) => {
	admin(locals);
	requireBuiltin(params.providerId);
	const runtime = await getModelRuntime();
	const models = runtime.getModels(params.providerId).map((m) => ({
		id: m.id,
		name: m.name ?? m.id,
		reasoning: m.reasoning,
		input: m.input,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		cost: m.cost
	}));
	return json({ models });
};

export const POST: RequestHandler = async ({ locals, params }) => {
	admin(locals);
	requireBuiltin(params.providerId);
	return json(await importFromPiCatalog(params.providerId));
};
