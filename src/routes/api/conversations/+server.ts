import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as settings from '$lib/server/db/repos/settings';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
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
import { audit } from '$lib/server/audit';

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
	memoryExtractorBackend: z.enum(MEMORY_EXTRACTOR_BACKEND_IDS).optional(),
	/**
	 * Optional chat prompt-template to seed conversation settings from. When it
	 * resolves to one of the caller's own chat templates, its
	 * `disabledToolGroups` preset is copied onto the new conversation.
	 */
	promptTemplateId: z.string().min(1).optional()
});

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, CreateBody);
	const cfg = loadConfig();
	const userSettings = settings.get(userId) ?? settings.defaults();
	const provider = body.provider ?? userSettings.defaultProvider ?? getDefaultProviderId();
	const model = body.model ?? userSettings.defaultModel ?? cfg.DEFAULT_MODEL;

	// Seed tool-group scoping from a chat template when one is supplied and owned
	// by the caller. Non-chat / missing / other-user templates seed nothing.
	let disabledToolGroups: string[] = [];
	if (body.promptTemplateId) {
		const tpl = promptTemplates.get(body.promptTemplateId, userId);
		if (tpl && tpl.type === 'chat') disabledToolGroups = tpl.disabledToolGroups;
	}

	const id = convs.newId();
	// Precedence: explicit body.workdir > user's defaultWorkdir > PROJECT_ROOT.
	const requested = body.workdir ?? userSettings.defaultWorkdir ?? null;
	let workdir: string;
	if (requested) {
		const res = resolveAndValidate(requested);
		if (!res.ok) {
			audit({
				event_type: 'workdir_override',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: requested,
				outcome: 'failure',
				detail: { context: 'conversation_create', reason: res.reason }
			});
			throw error(400, res.reason);
		}
		workdir = res.path;
		audit({
			event_type: 'workdir_override',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: workdir,
			outcome: 'success',
			detail: { context: 'conversation_create', source: body.workdir ? 'explicit' : 'user_default' }
		});
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
			body.memoryExtractorBackend ?? userSettings.defaultMemoryExtractorBackend ?? null,
		disabledToolGroups
	});
	return json({ ok: true, conversation: conv }, { status: 201 });
};
