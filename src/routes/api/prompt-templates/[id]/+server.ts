import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { promptTemplateId } from '$lib/ids';
import { findUnknownPlaceholders, unknownPlaceholderMessage } from '$lib/prompt-templates';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { requireUserId } from '$lib/server/auth/require';
import { parseBody } from '$lib/server/validate';
import { PORTAL_TOOL_GROUP_IDS } from '$lib/tools/groups';
import { APPROVAL_MODES, SESSION_MODES } from '$lib/types';

export const GET: RequestHandler = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const id = promptTemplateId.tryParse(params.id);
	if (id === null) throw error(404);
	const template = promptTemplates.get(id, userId);
	if (!template) throw error(404);
	return json({ template: { ...template, source: 'custom' } });
};

const PatchBody = z
	.object({
		title: z.string().trim().min(1).max(120).optional(),
		description: z.string().trim().max(500).optional(),
		prompt: z.string().trim().min(1).max(20_000).optional(),
		launchBehavior: z.enum(['send', 'draft', 'review']).optional(),
		conversationMode: z.enum(SESSION_MODES).nullable().optional(),
		approvalMode: z.enum(APPROVAL_MODES).nullable().optional(),
		model: z.string().trim().max(200).nullable().optional(),
		disabledToolGroups: z
			.array(z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]))
			.optional(),
		workspaceMode: z.enum(['shared', 'worktree']).nullable().optional(),
		status: z.enum(['open', 'archived']).optional(),
		pinned: z.boolean().optional(),
		orderIndex: z.number().int().min(-1_000_000).max(1_000_000).optional()
	})
	.refine(
		(body) =>
			body.title !== undefined ||
			body.description !== undefined ||
			body.prompt !== undefined ||
			body.launchBehavior !== undefined ||
			body.conversationMode !== undefined ||
			body.approvalMode !== undefined ||
			body.model !== undefined ||
			body.disabledToolGroups !== undefined ||
			body.workspaceMode !== undefined ||
			body.status !== undefined ||
			body.pinned !== undefined ||
			body.orderIndex !== undefined,
		{ message: 'No fields to update' }
	);

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const userId = requireUserId(locals);
	const id = promptTemplateId.tryParse(params.id);
	if (id === null) throw error(404);
	const body = await parseBody(request, PatchBody);
	const current = promptTemplates.get(id, userId);
	if (!current) throw error(404);
	if (body.prompt !== undefined) {
		const unknown = findUnknownPlaceholders(body.prompt, current.type);
		if (unknown.length > 0) {
			throw error(400, unknownPlaceholderMessage(current.type, unknown));
		}
	}
	const template = promptTemplates.update(id, userId, {
		...(body.title !== undefined ? { title: body.title } : {}),
		...(body.description !== undefined ? { description: body.description } : {}),
		...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
		...(body.launchBehavior !== undefined ? { launchBehavior: body.launchBehavior } : {}),
		...(body.conversationMode !== undefined ? { conversationMode: body.conversationMode } : {}),
		...(body.approvalMode !== undefined ? { approvalMode: body.approvalMode } : {}),
		...(body.model !== undefined ? { model: body.model } : {}),
		...(body.disabledToolGroups !== undefined
			? { disabledToolGroups: body.disabledToolGroups }
			: {}),
		...(body.workspaceMode !== undefined ? { workspaceMode: body.workspaceMode } : {}),
		...(body.status !== undefined ? { status: body.status } : {}),
		...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
		...(body.orderIndex !== undefined ? { orderIndex: body.orderIndex } : {})
	});
	if (!template) throw error(404);
	return json({ ok: true, template: { ...template, source: 'custom' } });
};

export const DELETE: RequestHandler = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const id = promptTemplateId.tryParse(params.id);
	if (id === null) throw error(404);
	const template = promptTemplates.archive(id, userId);
	if (!template) throw error(404);
	return json({ ok: true, template: { ...template, source: 'custom' } });
};
