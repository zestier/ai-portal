import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as memory from '$lib/server/db/repos/memory';
import { parseBody } from '$lib/server/validate';

const RawPatchBody = z.unknown();
const ItemStatus = z.enum(['active', 'superseded', 'disputed', 'deleted']);
const OpenLoopStatus = z.enum(['open', 'resolved', 'closed', 'deleted']);
const Visibility = z.enum(['session', 'global', 'private', 'hidden', 'gm']);
const GlobalKind = z.enum(['preference', 'decision', 'fact', 'style', 'constraint']);

const EntityPatch = z
	.object({
		displayName: z.string().trim().min(1).max(200).optional(),
		summary: z.string().max(4000).optional(),
		status: ItemStatus.optional(),
		entityType: z.string().trim().min(1).max(80).optional(),
		metadata: z.unknown().optional()
	})
	.strict();

const FactPatch = z
	.object({
		predicate: z.string().trim().min(1).max(100).optional(),
		value: z.unknown().optional(),
		status: ItemStatus.optional(),
		visibility: Visibility.optional(),
		confidence: z.number().min(0).max(1).optional()
	})
	.strict();

const DecisionPatch = z
	.object({
		subject: z.string().trim().min(1).max(200).optional(),
		decision: z.string().trim().min(1).max(4000).optional(),
		rationale: z.string().max(4000).optional(),
		status: ItemStatus.optional()
	})
	.strict();

const OpenLoopPatch = z
	.object({
		loopType: z.string().trim().min(1).max(100).optional(),
		title: z.string().trim().min(3).max(300).optional(),
		description: z.string().max(4000).optional(),
		status: OpenLoopStatus.optional(),
		priority: z.number().int().min(-100).max(100).optional(),
		relatedEntityIds: z.array(z.string().trim().min(1).max(200)).max(100).optional()
	})
	.strict();

const GlobalMemoryPatch = z
	.object({
		kind: GlobalKind,
		memoryKey: z.string().trim().min(1).max(200),
		value: z.unknown()
	})
	.strict();

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const body = await parseBody(request, RawPatchBody);
	const updated = updateMemoryItem(conv.id, conv.userId, params.kind, params.itemId, body);
	if (!updated) throw error(404, 'Memory item not found.');
	return json({ item: updated, memory: memory.listSnapshot(conv.id, { userId: conv.userId }) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const deleted =
		params.kind === 'globalMemories'
			? memory.deleteGlobalMemory(conv.userId, params.itemId)
			: memory.deleteItem(conv.id, params.kind, params.itemId);
	if (!deleted) throw error(404, 'Memory item not found.');
	return json({ ok: true, memory: memory.listSnapshot(conv.id, { userId: conv.userId }) });
};

function updateMemoryItem(
	conversationId: string,
	userId: string,
	kind: string,
	itemId: string,
	body: unknown
) {
	if (kind === 'globalMemories') {
		const parsed = parsePatchBody(GlobalMemoryPatch, body);
		const result = memory.updateGlobalMemory(userId, itemId, {
			kind: parsed.kind,
			memoryKey: parsed.memoryKey,
			value: parsed.value,
			sourceConversationId: conversationId
		});
		if (result.status === 'conflict') throw error(409, 'Global memory key already exists.');
		return result.status === 'updated' ? result.memory : null;
	}
	if (kind === 'entities' || kind === 'entity') {
		const parsed = parsePatchBody(EntityPatch, body);
		return memory.updateEntity(conversationId, itemId, {
			displayName: parsed.displayName,
			summary: parsed.summary,
			status: parsed.status,
			entityType: parsed.entityType,
			metadata: parsed.metadata
		});
	}
	if (kind === 'facts' || kind === 'fact') {
		const parsed = parsePatchBody(FactPatch, body);
		return memory.updateFact(conversationId, itemId, {
			predicate: parsed.predicate,
			value: parsed.value,
			status: parsed.status,
			visibility: parsed.visibility,
			confidence: parsed.confidence
		});
	}
	if (kind === 'decisions' || kind === 'decision') {
		const parsed = parsePatchBody(DecisionPatch, body);
		return memory.updateDecision(conversationId, itemId, {
			subject: parsed.subject,
			decision: parsed.decision,
			rationale: parsed.rationale,
			status: parsed.status
		});
	}
	if (kind === 'openLoops' || kind === 'open-loops' || kind === 'open_loop') {
		const parsed = parsePatchBody(OpenLoopPatch, body);
		return memory.updateOpenLoop(conversationId, itemId, {
			loopType: parsed.loopType,
			title: parsed.title,
			description: parsed.description,
			status: parsed.status,
			priority: parsed.priority,
			relatedEntityIds: parsed.relatedEntityIds
		});
	}
	return null;
}

function parsePatchBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		const path = first?.path.join('.');
		const message = path ? `${path}: ${first?.message}` : (first?.message ?? 'Invalid memory item');
		throw error(400, message);
	}
	return parsed.data;
}
