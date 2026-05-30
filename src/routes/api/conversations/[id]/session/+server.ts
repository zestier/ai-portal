import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as pool from '$lib/server/runtime/pool';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { getProvider } from '$lib/server/providers';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { parseBody } from '$lib/server/validate';
import { log } from '$lib/server/log';

// PATCH /api/conversations/:id/session — flip per-conversation SDK settings.
//
// Persists to the conversations row so a future open() picks them up, AND
// (when a live SDK session is cached in the pool) pushes the change to the
// running session so the active turn / next message reflects the new setting
// without needing the session to be recreated. Model changes recreate the
// provider session before the next turn because providers do not expose a
// cross-runtime live set-model control.

const PatchBody = z
	.object({
		model: z.string().trim().min(1).optional(),
		mode: z.enum(['interactive', 'plan', 'autopilot', 'best-effort']).optional(),
		memoryMode: z.enum(['off', 'lightweight', 'project', 'story', 'strict']).optional(),
		memoryExtractorModel: z
			.string()
			.trim()
			.transform((value) => (value ? value : null))
			.nullable()
			.optional(),
		globalMemoryEnabled: z.boolean().optional(),
		approveAllTools: z.boolean().optional()
	})
	.refine(
		(b) =>
			b.model !== undefined ||
			b.mode !== undefined ||
			b.memoryMode !== undefined ||
			b.memoryExtractorModel !== undefined ||
			b.globalMemoryEnabled !== undefined ||
			b.approveAllTools !== undefined,
		{
			message: 'No fields to update'
		}
	);

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const body = await parseBody(request, PatchBody);
	const provider = getProvider(conv.provider);
	const modelChanged = body.model !== undefined && body.model !== conv.model;
	const memoryChanged = body.memoryMode !== undefined && body.memoryMode !== conv.memoryMode;
	const extractorModelChanged =
		body.memoryExtractorModel !== undefined &&
		body.memoryExtractorModel !== conv.memoryExtractorModel;
	const globalMemoryChanged =
		body.globalMemoryEnabled !== undefined && body.globalMemoryEnabled !== conv.globalMemoryEnabled;
	const turn = getTurn(conv.id);
	if (
		(modelChanged || memoryChanged || extractorModelChanged || globalMemoryChanged) &&
		turn?.status === 'running'
	) {
		throw error(
			409,
			'Cannot change model, memory mode, harvester model, or global memory while a turn is running.'
		);
	}

	const persistedPatch = { ...body };
	convs.updateSessionSettings(conv.id, conv.userId, body);
	if (modelChanged || memoryChanged || extractorModelChanged || globalMemoryChanged) {
		await pool.release(conv.id);
	}
	const live =
		modelChanged || memoryChanged || extractorModelChanged || globalMemoryChanged
			? null
			: pool.getActive(conv.id);
	if (live) {
		// Best-effort: the bridge already logs detailed RPC failures, and
		// the DB row is the source of truth for the next open(). Don't fail
		// the request if the live SDK rejects (preview surface, capability-gated).
		if (body.mode !== undefined && live.setMode) {
			try {
				await live.setMode(body.mode);
			} catch (e) {
				log.warn('session.set_mode_failed', { conversationId: conv.id, err: String(e) });
			}
		}
		if (body.approveAllTools !== undefined && live.setApproveAll) {
			try {
				await live.setApproveAll(body.approveAllTools);
			} catch (e) {
				log.warn('session.set_approve_all_failed', {
					conversationId: conv.id,
					err: String(e)
				});
			}
		}
	}

	return json({
		ok: true,
		conversation: convs.get(conv.id, conv.userId),
		capabilities: provider.capabilities,
		unsupported: {
			mode:
				persistedPatch.mode !== undefined && !provider.capabilities.controls.mode
					? provider.capabilities.features.modes.description
					: undefined
		}
	});
};

// POST /api/conversations/:id/session — clear the SDK's session-scoped
// approvals. Useful after the user toggles approve-all off and wants a clean
// slate without ending the conversation.
export const POST: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const provider = getProvider(conv.provider);
	if (!provider.capabilities.controls.resetSessionApprovals) {
		return json({
			ok: true,
			supported: false,
			message: 'This provider has no session-scoped approval cache to reset.'
		});
	}
	const live = pool.getActive(conv.id);
	if (live?.resetSessionApprovals) {
		try {
			await live.resetSessionApprovals();
		} catch (e) {
			log.warn('session.reset_approvals_failed', {
				conversationId: conv.id,
				err: String(e)
			});
		}
	}
	return json({ ok: true, supported: true });
};
