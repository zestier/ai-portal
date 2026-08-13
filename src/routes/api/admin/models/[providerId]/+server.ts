// POST /api/admin/models/[providerId] — set/clear a provider API key (body
// { apiKey: string }; empty string clears). DELETE — remove the provider and
// its models.

import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { requireUserId } from '$lib/server/auth/require';
import { loadConfig } from '$lib/server/config';
import { canRedeployUser } from '$lib/server/redeploy';
import { deleteProvider, saveProviderKey } from '$lib/server/models/catalog-service';
import * as providersRepo from '$lib/server/db/repos/providers';

function admin(locals: App.Locals): void {
	requireUserId(locals);
	const cfg = loadConfig();
	if (!canRedeployUser(locals.user, cfg)) {
		throw error(403, 'Model configuration requires admin access.');
	}
}

const KeySchema = z.object({ apiKey: z.string().max(4096) });

export const POST: RequestHandler = async ({ locals, params, request }) => {
	admin(locals);
	if (!providersRepo.get(params.providerId)) throw error(404, 'Provider not found.');
	const body = await request.json().catch(() => null);
	const parsed = KeySchema.safeParse(body ?? {});
	if (!parsed.success) throw error(400, 'Expected { apiKey: string }.');
	try {
		await saveProviderKey(params.providerId, parsed.data.apiKey);
	} catch (e) {
		throw error(400, e instanceof Error ? e.message : String(e));
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	admin(locals);
	if (!providersRepo.get(params.providerId)) throw error(404, 'Provider not found.');
	await deleteProvider(params.providerId);
	return json({ ok: true });
};
