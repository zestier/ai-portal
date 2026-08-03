import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as pool from '$lib/server/runtime/pool';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { getProvider } from '$lib/server/providers';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { parseBody } from '$lib/server/validate';
import { APPROVAL_MODES, MEMORY_EXTRACTOR_BACKEND_IDS, SESSION_MODES } from '$lib/types';
import { PORTAL_TOOL_GROUP_IDS, sanitizeDisabledToolGroups } from '$lib/tools/groups';
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
		mode: z.enum(SESSION_MODES).optional(),
		memoryMode: z.enum(['off', 'lightweight', 'project', 'story', 'strict']).optional(),
		memoryExtractorModel: z
			.string()
			.trim()
			.transform((value) => (value ? value : null))
			.nullable()
			.optional(),
		memoryExtractorBackend: z.enum(MEMORY_EXTRACTOR_BACKEND_IDS).nullable().optional(),
		adversaryModel: z
			.string()
			.trim()
			.transform((value) => (value ? value : null))
			.nullable()
			.optional(),
		globalMemoryEnabled: z.boolean().optional(),
		approvalMode: z.enum(APPROVAL_MODES).optional(),
		disabledToolGroups: z
			.array(z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]))
			.optional()
	})
	.refine(
		(b) =>
			b.model !== undefined ||
			b.mode !== undefined ||
			b.memoryMode !== undefined ||
			b.memoryExtractorModel !== undefined ||
			b.memoryExtractorBackend !== undefined ||
			b.adversaryModel !== undefined ||
			b.globalMemoryEnabled !== undefined ||
			b.approvalMode !== undefined ||
			b.disabledToolGroups !== undefined,
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
	const extractorBackendChanged =
		body.memoryExtractorBackend !== undefined &&
		body.memoryExtractorBackend !== conv.memoryExtractorBackend;
	// Captured at session open (see `ProviderOpenOptions.adversaryModel`), so a
	// change only takes effect once the pooled session is released — hence it
	// joins the same guard/release set as the harvester settings rather than
	// silently appearing to apply.
	const adversaryModelChanged =
		body.adversaryModel !== undefined && body.adversaryModel !== conv.adversaryModel;
	const globalMemoryChanged =
		body.globalMemoryEnabled !== undefined && body.globalMemoryEnabled !== conv.globalMemoryEnabled;
	const toolGroupsChanged =
		body.disabledToolGroups !== undefined &&
		!sameGroupSet(sanitizeDisabledToolGroups(body.disabledToolGroups), conv.disabledToolGroups);
	const turn = getTurn(conv.id);
	if (
		(modelChanged ||
			memoryChanged ||
			extractorModelChanged ||
			extractorBackendChanged ||
			adversaryModelChanged ||
			globalMemoryChanged ||
			toolGroupsChanged) &&
		turn?.status === 'running'
	) {
		throw error(
			409,
			'Cannot change model, memory mode, harvester model, harvester backend, adversary model, global memory, or tool groups while a turn is running.'
		);
	}

	const persistedPatch = {
		...(body.model !== undefined ? { model: body.model } : {}),
		...(body.mode !== undefined ? { mode: body.mode } : {}),
		...(body.memoryMode !== undefined ? { memoryMode: body.memoryMode } : {}),
		...(body.memoryExtractorModel !== undefined
			? { memoryExtractorModel: body.memoryExtractorModel }
			: {}),
		...(body.memoryExtractorBackend !== undefined
			? { memoryExtractorBackend: body.memoryExtractorBackend }
			: {}),
		...(body.adversaryModel !== undefined ? { adversaryModel: body.adversaryModel } : {}),
		...(body.globalMemoryEnabled !== undefined
			? { globalMemoryEnabled: body.globalMemoryEnabled }
			: {}),
		...(body.approvalMode !== undefined ? { approvalMode: body.approvalMode } : {}),
		...(body.disabledToolGroups !== undefined
			? { disabledToolGroups: body.disabledToolGroups }
			: {})
	};
	convs.updateSessionSettings(conv.id, conv.userId, persistedPatch);
	if (
		modelChanged ||
		memoryChanged ||
		extractorModelChanged ||
		extractorBackendChanged ||
		adversaryModelChanged ||
		globalMemoryChanged ||
		toolGroupsChanged
	) {
		// Portal tools are fixed at createSession/resumeSession — there is no live
		// RPC to swap them — so releasing the pooled session is the mechanism that
		// makes the next turn reopen with the filtered tool set.
		await pool.release(conv.id);
	}
	const live =
		modelChanged ||
		memoryChanged ||
		extractorModelChanged ||
		extractorBackendChanged ||
		globalMemoryChanged ||
		toolGroupsChanged
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
		if (body.approvalMode !== undefined && live.setApprovalMode) {
			try {
				await live.setApprovalMode(body.approvalMode);
			} catch (e) {
				log.warn('session.set_approval_mode_failed', {
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
			...(persistedPatch.mode !== undefined && !provider.capabilities.controls.mode
				? { mode: provider.capabilities.features.modes.description }
				: {}),
			// Only `auto-approve` needs provider support; `ask` / `auto-deny` are
			// settled entirely by the portal's interactive adapter.
			...(persistedPatch.approvalMode === 'auto-approve' &&
			!provider.capabilities.controls.approvalMode
				? { approvalMode: provider.capabilities.features.approvalMode.description }
				: {})
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

// Order-insensitive equality for two disabled-group id lists (already
// sanitized). Used to decide whether a tool-group change actually mutated the
// set and therefore requires a session recreate.
function sameGroupSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((id) => set.has(id));
}
