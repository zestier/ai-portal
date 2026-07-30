import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import {
	findUnknownPlaceholders,
	listBuiltInPromptTemplates,
	unknownPlaceholderMessage,
	type PromptTemplateListItem
} from '$lib/prompt-templates';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { requireUserId } from '$lib/server/auth/require';
import { parseBody } from '$lib/server/validate';
import { PORTAL_TOOL_GROUP_IDS } from '$lib/tools/groups';

export const GET: RequestHandler = ({ locals }) => {
	const userId = requireUserId(locals);
	const builtInTemplates = listBuiltInPromptTemplates();
	// The launcher only deals with chat templates; ticket-action templates are
	// surfaced as ticket buttons, not in the chat-template picker.
	const customTemplates = promptTemplates.list(userId, { type: 'chat' }).map(
		(template): PromptTemplateListItem => ({
			...template,
			source: 'custom'
		})
	);
	return json({
		builtInTemplates,
		customTemplates,
		templates: [...builtInTemplates, ...customTemplates]
	});
};

const CreateBody = z
	.object({
		type: z.enum(['chat', 'ticket-action']).optional().default('chat'),
		title: z.string().trim().min(1).max(120),
		description: z.string().trim().max(500).optional(),
		prompt: z.string().trim().min(1).max(20_000),
		launchBehavior: z.enum(['send', 'draft', 'review']).optional(),
		conversationMode: z.enum(['interactive', 'plan', 'autopilot', 'best-effort']).optional(),
		model: z.string().trim().max(200).nullable().optional(),
		disabledToolGroups: z
			.array(z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]))
			.optional(),
		workspaceMode: z.enum(['shared', 'worktree']).nullable().optional(),
		pinned: z.boolean().optional(),
		orderIndex: z.number().int().min(-1_000_000).max(1_000_000).optional()
	})
	.superRefine((body, ctx) => {
		const unknown = findUnknownPlaceholders(body.prompt, body.type);
		if (unknown.length > 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['prompt'],
				message: unknownPlaceholderMessage(body.type, unknown)
			});
		}
	});

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, CreateBody);
	const template = promptTemplates.create(userId, {
		title: body.title,
		prompt: body.prompt,
		type: body.type,
		...(body.description !== undefined ? { description: body.description } : {}),
		...(body.launchBehavior !== undefined ? { launchBehavior: body.launchBehavior } : {}),
		...(body.conversationMode !== undefined ? { conversationMode: body.conversationMode } : {}),
		...(body.model !== undefined ? { model: body.model } : {}),
		...(body.disabledToolGroups !== undefined
			? { disabledToolGroups: body.disabledToolGroups }
			: {}),
		...(body.workspaceMode !== undefined ? { workspaceMode: body.workspaceMode } : {}),
		...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
		...(body.orderIndex !== undefined ? { orderIndex: body.orderIndex } : {})
	});
	return json({ ok: true, template: { ...template, source: 'custom' } }, { status: 201 });
};
