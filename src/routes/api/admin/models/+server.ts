// GET/POST /api/admin/models — read the portal model catalog and mutate it
// (providers, models, and delete-model). Gated to the same admin set as
// /api/admin/stats.

import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/server/config';
import { canRedeployUser } from '$lib/server/redeploy';
import {
	deleteModel,
	getCatalog,
	saveModel,
	saveProvider
} from '$lib/server/models/catalog-service';
import * as providersRepo from '$lib/server/db/repos/providers';
import type { ProviderApi } from '$lib/types';

const PROVIDER_APIS = [
	'anthropic-messages',
	'openai-completions',
	'openai-responses',
	'google-generative-ai'
] as const;

const ProviderSchema = z
	.object({
		action: z.literal('provider'),
		id: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.regex(/^[a-z0-9][a-z0-9_-]*$/, 'provider id: lowercase letters, digits, - and _ only'),
		name: z.string().trim().min(1).max(100),
		api: z.enum(PROVIDER_APIS),
		baseUrl: z.string().trim().max(500).optional(),
		headers: z.record(z.string(), z.string()).optional(),
		authHeader: z.boolean().optional(),
		builtin: z.boolean().optional().default(false),
		enabled: z.boolean().optional().default(true)
	})
	.superRefine((v, ctx) => {
		// Custom providers need a base URL to serialize (pi requires it for custom models).
		if (!v.builtin && v.enabled && !v.baseUrl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['baseUrl'],
				message: 'Custom providers require a base URL.'
			});
		}
	});

const CostSchema = z.object({
	input: z.number().min(0),
	output: z.number().min(0),
	cacheRead: z.number().min(0),
	cacheWrite: z.number().min(0)
});

const ModelSchema = z.object({
	action: z.literal('model'),
	providerId: z.string().trim().min(1).max(64),
	id: z.string().trim().min(1).max(200),
	name: z.string().trim().min(1).max(200),
	purpose: z.string().trim().max(300).nullable().optional(),
	enabled: z.boolean().optional(),
	cost: CostSchema.optional(),
	contextWindow: z.number().int().positive().nullable().optional(),
	maxTokens: z.number().int().positive().nullable().optional(),
	reasoning: z.boolean().optional(),
	input: z.array(z.enum(['text', 'image'])).optional(),
	thinkingLevelMap: z.record(z.string(), z.string().nullable()).nullable().optional(),
	compat: z.record(z.string(), z.unknown()).nullable().optional(),
	samplingParams: z.record(z.string(), z.unknown()).nullable().optional(),
	sortOrder: z.number().int().optional()
});

function admin(locals: App.Locals): void {
	const cfg = loadConfig();
	if (!canRedeployUser(locals.user, cfg)) {
		throw error(403, 'Model configuration requires admin access.');
	}
}

export const GET: RequestHandler = ({ locals }) => {
	admin(locals);
	return json(getCatalog());
};

export const POST: RequestHandler = async ({ locals, request }) => {
	admin(locals);
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') {
		throw error(400, 'Expected a JSON body.');
	}

	if (body.action === 'provider') {
		const parsed = ProviderSchema.safeParse(body);
		if (!parsed.success) {
			throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
		}
		const v = parsed.data;
		const provider = await saveProvider({
			id: v.id,
			name: v.name,
			api: v.api,
			baseUrl: v.baseUrl ?? null,
			headers: v.headers ?? {},
			authHeader: v.authHeader ?? false,
			builtin: v.builtin,
			enabled: v.enabled
		});
		return json({ ok: true, provider });
	}

	if (body.action === 'model') {
		const parsed = ModelSchema.safeParse(body);
		if (!parsed.success) {
			throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
		}
		const v = parsed.data;
		const model = await saveModel(v.providerId, {
			id: v.id,
			name: v.name,
			...(v.purpose !== undefined ? { purpose: v.purpose } : {}),
			...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
			...(v.cost !== undefined ? { cost: v.cost } : {}),
			...(v.contextWindow !== undefined ? { contextWindow: v.contextWindow } : {}),
			...(v.maxTokens !== undefined ? { maxTokens: v.maxTokens } : {}),
			...(v.reasoning !== undefined ? { reasoning: v.reasoning } : {}),
			...(v.input !== undefined ? { input: v.input } : {}),
			...(v.thinkingLevelMap !== undefined ? { thinkingLevelMap: v.thinkingLevelMap } : {}),
			...(v.compat !== undefined ? { compat: v.compat } : {}),
			...(v.samplingParams !== undefined ? { samplingParams: v.samplingParams } : {}),
			...(v.sortOrder !== undefined ? { sortOrder: v.sortOrder } : {})
		});
		return json({ ok: true, model });
	}

	if (body.action === 'delete-model') {
		const parsed = z
			.object({
				action: z.literal('delete-model'),
				providerId: z.string().trim().min(1).max(64),
				id: z.string().trim().min(1).max(200)
			})
			.safeParse(body);
		if (!parsed.success) throw error(400, 'Expected { action, providerId, id }.');
		if (!providersRepo.get(parsed.data.providerId)) throw error(404, 'Provider not found.');
		await deleteModel(parsed.data.providerId, parsed.data.id);
		return json({ ok: true });
	}

	throw error(400, 'Unknown action.');
};

// Re-exported for callers that want the provider API union.
export type { ProviderApi };
