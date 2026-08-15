// GET/POST /api/admin/extensions — list and mutate the operator-managed pi
// extension set (Settings → Extensions). Gated to the same admin set as
// /api/admin/models (`canRedeployUser`).
//
// POST actions: create / update / toggle / delete / verify. `verify` runs a
// throwaway loader and reports `{loaded, errors}` — never throws, never
// affects live sessions.

import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { requireUserId } from '$lib/server/auth/require';
import { loadConfig } from '$lib/server/config';
import { canRedeployUser } from '$lib/server/redeploy';
import { extensionId } from '$lib/ids';
import * as extensions from '$lib/server/extensions';
import * as extensionsRepo from '$lib/server/db/repos/extensions';

function admin(locals: App.Locals): number {
	const userId = requireUserId(locals);
	const cfg = loadConfig();
	if (!canRedeployUser(locals.user, cfg)) {
		throw error(403, 'Extension configuration requires admin access.');
	}
	return userId;
}

const CreateSchema = z.object({
	action: z.literal('create'),
	name: z.string().trim().min(1).max(120),
	kind: z.enum(['file', 'inline', 'package']),
	value: z.string(),
	enabled: z.boolean().optional().default(true),
	sortOrder: z.number().int().optional()
});

const UpdateSchema = z.object({
	action: z.literal('update'),
	id: z.string(),
	name: z.string().trim().min(1).max(120).optional(),
	value: z.string().optional(),
	enabled: z.boolean().optional(),
	sortOrder: z.number().int().optional()
});

const ToggleSchema = z.object({
	action: z.literal('toggle'),
	id: z.string(),
	enabled: z.boolean()
});

const DeleteSchema = z.object({
	action: z.literal('delete'),
	id: z.string()
});

const VerifySchema = z.object({
	action: z.literal('verify'),
	id: z.string().optional()
});

function parseExtId(raw: string): number {
	try {
		return extensionId.parse(raw);
	} catch {
		throw error(400, `Invalid extension id: ${raw} — expected EX<number>.`);
	}
}

export const GET: RequestHandler = ({ locals, url }) => {
	const userId = admin(locals);
	const status = url.searchParams.get('status') === 'all' ? 'all' : 'open';
	return json({ extensions: extensionsRepo.list(userId, { status }) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = admin(locals);
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') {
		throw error(400, 'Expected a JSON body.');
	}

	if (body.action === 'create') {
		const parsed = CreateSchema.safeParse(body);
		if (!parsed.success) {
			throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
		}
		const v = parsed.data;
		const invalid = extensions.validateExtensionValue(v.kind, v.value);
		if (invalid) throw error(400, invalid);
		const extension = extensionsRepo.create(userId, {
			name: v.name,
			kind: v.kind,
			value: v.value,
			enabled: v.enabled,
			...(v.sortOrder !== undefined ? { sortOrder: v.sortOrder } : {})
		});
		await extensions.materializeInlineFiles(userId);
		return json({ ok: true, extension }, { status: 201 });
	}

	if (body.action === 'update') {
		const parsed = UpdateSchema.safeParse(body);
		if (!parsed.success) {
			throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
		}
		const v = parsed.data;
		const intId = parseExtId(v.id);
		const existing = extensionsRepo.get(userId, intId);
		if (!existing) throw error(404, `Extension not found: ${v.id}`);
		if (v.value !== undefined) {
			const invalid = extensions.validateExtensionValue(existing.kind, v.value);
			if (invalid) throw error(400, invalid);
		}
		const extension = extensionsRepo.update(userId, intId, {
			...(v.name !== undefined ? { name: v.name } : {}),
			...(v.value !== undefined ? { value: v.value } : {}),
			...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
			...(v.sortOrder !== undefined ? { sortOrder: v.sortOrder } : {})
		});
		await extensions.materializeInlineFiles(userId);
		return json({ ok: true, extension });
	}

	if (body.action === 'toggle') {
		const parsed = ToggleSchema.safeParse(body);
		if (!parsed.success) throw error(400, 'Expected { action: "toggle", id, enabled }.');
		const intId = parseExtId(parsed.data.id);
		const extension = extensionsRepo.setEnabled(userId, intId, parsed.data.enabled);
		if (!extension) throw error(404, `Extension not found: ${parsed.data.id}`);
		await extensions.materializeInlineFiles(userId);
		return json({ ok: true, extension });
	}

	if (body.action === 'delete') {
		const parsed = DeleteSchema.safeParse(body);
		if (!parsed.success) throw error(400, 'Expected { action: "delete", id }.');
		const intId = parseExtId(parsed.data.id);
		extensionsRepo.remove(userId, intId);
		await extensions.materializeInlineFiles(userId);
		return json({ ok: true });
	}

	if (body.action === 'verify') {
		const parsed = VerifySchema.safeParse(body);
		if (!parsed.success) throw error(400, 'Expected { action: "verify", id? }.');
		// `verify` never throws; errors are reported in the payload (200).
		const result = await extensions.verify(userId, parsed.data.id);
		return json({ ok: true, loaded: result.loaded, errors: result.errors });
	}

	throw error(400, 'Unknown action.');
};
