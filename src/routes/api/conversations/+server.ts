import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as settings from '$lib/server/db/repos/settings';
import { loadConfig } from '$lib/server/config';
import { getDefaultProviderId } from '$lib/server/providers';
import {
	BACKEND_PROVIDER_IDS,
	MEMORY_EXTRACTOR_BACKEND_IDS,
	normalizeBackendProvider
} from '$lib/types';
import { projectRoot, resolveAndValidate } from '$lib/server/workdir';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';

export const GET: RequestHandler = ({ locals, url }) => {
	const userId = requireUserId(locals);
	const includeArchived = url.searchParams.get('archived') === '1';
	return json({ conversations: convs.list(userId, { includeArchived }) });
};

const CreateBody = z.object({
	title: z.string().min(1).max(200).default('New chat'),
	provider: z.enum(BACKEND_PROVIDER_IDS).optional(),
	model: z.string().min(1).optional(),
	workdir: z.string().min(1).optional(),
	mode: z.enum(['interactive', 'plan', 'autopilot', 'best-effort']).optional(),
	memoryExtractorModel: z.string().min(1).optional(),
	memoryExtractorBackend: z.enum(MEMORY_EXTRACTOR_BACKEND_IDS).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, CreateBody);
	const cfg = loadConfig();
	const userSettings = settings.get(userId) ?? settings.defaults();
	const provider = body.provider ?? userSettings.defaultProvider ?? getDefaultProviderId();
	const model = body.model ?? userSettings.defaultModel ?? cfg.DEFAULT_MODEL;

	const id = convs.newId();
	// Precedence: explicit body.workdir > user's defaultWorkdir > PROJECT_ROOT.
	const requested = body.workdir ?? userSettings.defaultWorkdir ?? null;
	let workdir: string;
	if (requested) {
		const res = resolveAndValidate(requested);
		if (!res.ok) throw error(400, res.reason);
		workdir = res.path;
	} else {
		workdir = projectRoot();
	}

	const conv = convs.create(userId, {
		id,
		title: body.title,
		workdir,
		provider: normalizeBackendProvider(provider),
		model,
		mode: body.mode ?? userSettings.defaultConversationMode,
		// Seed-only, mirroring model/mode precedence: explicit create-body field
		// wins, else the user's default, else NULL (resolved from env at runtime).
		memoryExtractorModel:
			body.memoryExtractorModel ?? userSettings.defaultMemoryExtractorModel ?? null,
		memoryExtractorBackend:
			body.memoryExtractorBackend ?? userSettings.defaultMemoryExtractorBackend ?? null
	});
	return json({ ok: true, conversation: conv }, { status: 201 });
};
