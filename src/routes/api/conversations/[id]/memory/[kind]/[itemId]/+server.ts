import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { conversationId as convCodec, memoryEntityId, memoryFactId } from '$lib/ids';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as memory from '$lib/server/db/repos/memory';
import { parseBody } from '$lib/server/validate';

const RawPatchBody = z.unknown();
const ItemStatus = z.enum(['active', 'superseded', 'disputed', 'deleted']);
const OpenLoopStatus = z.enum(['open', 'resolved', 'closed', 'deleted']);
const Visibility = z.enum(['session', 'global', 'private', 'hidden', 'gm']);
const GlobalKind = z.enum(['preference', 'decision', 'fact', 'style', 'constraint']);

// Known memory-kind path segments accepted by this route. Mirrors the aliases
// handled by the memory repo's normalizeKind (entity/fact/open_loop) plus the
// special-cased globalMemories. Unknown kinds are rejected with 400 before
// dispatch rather than falling through to a misleading 404.
const MemoryKindParam = z.enum([
	'globalMemories',
	'entities',
	'entity',
	'facts',
	'fact',
	'openLoops',
	'open-loops',
	'open_loop'
]);

function assertKnownKind(kind: string): void {
	if (!MemoryKindParam.safeParse(kind).success) {
		throw error(400, `Unknown memory kind: ${kind}`);
	}
}

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

const OpenLoopPatch = z
	.object({
		loopType: z.string().trim().min(1).max(100).optional(),
		title: z.string().trim().min(3).max(300).optional(),
		description: z.string().max(4000).optional(),
		status: OpenLoopStatus.optional(),
		priority: z.number().int().min(-100).max(100).optional(),
		relatedEntityIds: z
			.array(z.union([z.string(), z.number()]))
			.max(100)
			.optional()
	})
	.strict();

const GlobalMemoryPatch = z
	.object({
		kind: GlobalKind,
		memoryKey: z.string().trim().min(1).max(200),
		value: z.unknown()
	})
	.strict();

// Parse a memory item id from its URL segment. Entities and facts carry
// E/F-handles on the wire; open loops and global memories keep int ids
// (kind-scoped, server-minted — see `src/lib/ids.ts`).
function parseMemoryItemId(kind: string, raw: string | undefined): number | null {
	if (!raw) return null;
	if (
		kind === 'globalMemories' ||
		kind === 'openLoops' ||
		kind === 'open-loops' ||
		kind === 'open_loop'
	) {
		const id = Number(raw);
		return Number.isSafeInteger(id) && id > 0 ? id : null;
	}
	const codec = kind === 'entities' || kind === 'entity' ? memoryEntityId : memoryFactId;
	return codec.tryParse(raw);
}

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	assertKnownKind(params.kind);
	const itemId = parseMemoryItemId(params.kind, params.itemId);
	if (itemId === null) throw error(404, 'Memory item not found.');
	const body = await parseBody(request, RawPatchBody);
	const updated = updateMemoryItem(
		convCodec.parse(conv.id),
		conv.userId,
		params.kind,
		itemId,
		body
	);
	if (!updated) throw error(404, 'Memory item not found.');
	return json({
		item: updated,
		memory: memory.listSnapshot(convCodec.parse(conv.id), { userId: conv.userId })
	});
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	assertKnownKind(params.kind);
	const itemId = parseMemoryItemId(params.kind, params.itemId);
	if (itemId === null) throw error(404, 'Memory item not found.');
	const deleted =
		params.kind === 'globalMemories'
			? memory.deleteGlobalMemory(conv.userId, itemId)
			: memory.deleteItem(convCodec.parse(conv.id), params.kind, itemId);
	if (!deleted) throw error(404, 'Memory item not found.');
	return json({
		ok: true,
		memory: memory.listSnapshot(convCodec.parse(conv.id), { userId: conv.userId })
	});
};

function updateMemoryItem(
	conversationId: number,
	userId: number,
	kind: string,
	itemId: number,
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
			...(parsed.displayName !== undefined ? { displayName: parsed.displayName } : {}),
			...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
			...(parsed.status !== undefined ? { status: parsed.status } : {}),
			...(parsed.entityType !== undefined ? { entityType: parsed.entityType } : {}),
			...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {})
		});
	}
	if (kind === 'facts' || kind === 'fact') {
		const parsed = parsePatchBody(FactPatch, body);
		return memory.updateFact(conversationId, itemId, {
			...(parsed.predicate !== undefined ? { predicate: parsed.predicate } : {}),
			...(parsed.value !== undefined ? { value: parsed.value } : {}),
			...(parsed.status !== undefined ? { status: parsed.status } : {}),
			...(parsed.visibility !== undefined ? { visibility: parsed.visibility } : {}),
			...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {})
		});
	}
	if (kind === 'openLoops' || kind === 'open-loops' || kind === 'open_loop') {
		const parsed = parsePatchBody(OpenLoopPatch, body);
		return memory.updateOpenLoop(conversationId, itemId, {
			...(parsed.loopType !== undefined ? { loopType: parsed.loopType } : {}),
			...(parsed.title !== undefined ? { title: parsed.title } : {}),
			...(parsed.description !== undefined ? { description: parsed.description } : {}),
			...(parsed.status !== undefined ? { status: parsed.status } : {}),
			...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
			...(parsed.relatedEntityIds !== undefined
				? { relatedEntityIds: parsed.relatedEntityIds }
				: {})
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
