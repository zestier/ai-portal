import { getDb } from '../../index';
import { memoryPatchItemId } from '$lib/ids';
import { appendSessionMemoryLog } from './common';
import {
	codecFor,
	convInt,
	resolveId,
	rowToPatch,
	rowToPatchItem,
	safeJson,
	type CreatePatchInput,
	type MemoryPatch,
	type MemoryPatchItem,
	type PatchItemRow,
	type PatchRow
} from './rows';
import { deleteItem } from './log';

export function createPatch(conversationId: string | number, input: CreatePatchInput): MemoryPatch {
	const now = Date.now();
	const intConv = convInt(conversationId);
	const info = getDb()
		.prepare(
			`INSERT INTO memory_patches(
			   conversation_id, turn_id, status, summary, raw_patch_json,
			   validation_result_json, extractor_kind, extractor_model, extractor_confidence,
			   extractor_diagnostics_json, created_at, committed_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			intConv,
			input.turnId ?? null,
			input.status,
			input.summary ?? '',
			safeJson(input.rawPatch ?? {}),
			safeJson(input.validationResult ?? {}),
			input.extractorKind ?? null,
			input.extractorModel ?? null,
			input.extractorConfidence ?? null,
			safeJson(input.extractorDiagnostics ?? []),
			now,
			input.committedAt ?? null
		);
	const id = Number(info.lastInsertRowid);
	const row = getDb().prepare('SELECT * FROM memory_patches WHERE id = ?').get(id) as PatchRow;
	appendSessionMemoryLog(getDb(), intConv, {
		eventKind: 'patch.create',
		itemType: 'patch',
		itemId: id,
		sourceMessageId: input.sourceMessageId ?? null,
		turnId: input.turnId ?? null,
		payload: { patch: rowToPatch(row) }
	});
	return rowToPatch(row);
}

export function listPatches(
	conversationId: string | number,
	opts: { limit?: number } = {}
): MemoryPatch[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_patches
			  WHERE conversation_id = ?
			  ORDER BY created_at DESC LIMIT ?`
		)
		.all(convInt(conversationId), opts.limit ?? 50) as PatchRow[];
	return rows.map(rowToPatch);
}

export function updatePatchStatus(
	conversationId: number,
	patchId: number,
	status: MemoryPatch['status'],
	validationResult?: unknown
): MemoryPatch | null {
	const now = Date.now();
	const result = getDb()
		.prepare(
			`UPDATE memory_patches
			    SET status = ?,
			        validation_result_json = CASE WHEN ? IS NULL THEN validation_result_json ELSE ? END,
			        committed_at = CASE WHEN ? IN ('committed', 'partially_committed') THEN COALESCE(committed_at, ?) ELSE committed_at END
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(
			status,
			validationResult === undefined ? null : safeJson(validationResult),
			validationResult === undefined ? null : safeJson(validationResult),
			status,
			now,
			patchId,
			conversationId
		);
	if (result.changes === 0) return null;
	const row = getDb()
		.prepare('SELECT * FROM memory_patches WHERE id = ? AND conversation_id = ?')
		.get(patchId, conversationId) as PatchRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'patch.update',
		itemType: 'patch',
		itemId: patchId,
		payload: { patch: rowToPatch(row) }
	});
	return rowToPatch(row);
}

export function recordPatchItem(
	conversationId: number,
	input: { patchId: number; itemType: string; itemId: string | number; action: string }
): MemoryPatchItem {
	const now = Date.now();
	const itemId = resolveId(input.itemId, codecFor(input.itemType) ?? memoryPatchItemId) ?? 0;
	const info = getDb()
		.prepare(
			`INSERT INTO memory_patch_items(patch_id, conversation_id, item_type, item_id, action, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(input.patchId, conversationId, input.itemType, itemId, input.action, now);
	const id = Number(info.lastInsertRowid);
	const row = getDb()
		.prepare('SELECT * FROM memory_patch_items WHERE id = ?')
		.get(id) as PatchItemRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'patch_item.create',
		itemType: 'patch_item',
		itemId: id,
		payload: { item: rowToPatchItem(row) }
	});
	return rowToPatchItem(row);
}

export function listPatchItems(
	conversationId: string | number,
	opts: { patchId?: number; limit?: number } = {}
): MemoryPatchItem[] {
	const intConv = convInt(conversationId);
	const rows = opts.patchId
		? (getDb()
				.prepare(
					`SELECT * FROM memory_patch_items
					  WHERE conversation_id = ? AND patch_id = ?
					  ORDER BY created_at DESC LIMIT ?`
				)
				.all(intConv, opts.patchId, opts.limit ?? 200) as PatchItemRow[])
		: (getDb()
				.prepare(
					`SELECT * FROM memory_patch_items
					  WHERE conversation_id = ?
					  ORDER BY created_at DESC LIMIT ?`
				)
				.all(intConv, opts.limit ?? 200) as PatchItemRow[]);
	return rows.map(rowToPatchItem);
}

export function reviewPatchItem(
	conversationId: string | number,
	patchItemId: string | number,
	decision: 'approve' | 'reject'
): { item: MemoryPatchItem | null; affected: boolean } {
	const intConv = convInt(conversationId);
	const intPatchItemId = resolveId(patchItemId, memoryPatchItemId);
	if (!intPatchItemId) return { item: null, affected: false };
	const current = getDb()
		.prepare('SELECT * FROM memory_patch_items WHERE id = ? AND conversation_id = ?')
		.get(intPatchItemId, intConv) as PatchItemRow | undefined;
	if (!current) return { item: null, affected: false };
	let affected = false;
	const status = decision === 'approve' ? 'approved' : 'rejected';
	if (
		decision === 'reject' &&
		current.review_status !== 'rejected' &&
		current.action === 'create'
	) {
		affected = deleteItem(intConv, current.item_type, current.item_id);
	}
	getDb()
		.prepare(
			`UPDATE memory_patch_items
			    SET review_status = ?, reviewed_at = ?
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(status, Date.now(), intPatchItemId, intConv);
	const item = getDb()
		.prepare('SELECT * FROM memory_patch_items WHERE id = ? AND conversation_id = ?')
		.get(intPatchItemId, intConv) as PatchItemRow;
	appendSessionMemoryLog(getDb(), intConv, {
		eventKind: 'patch_item.review',
		itemType: 'patch_item',
		itemId: intPatchItemId,
		payload: { item: rowToPatchItem(item), decision, affected }
	});
	return { item: rowToPatchItem(item), affected };
}
