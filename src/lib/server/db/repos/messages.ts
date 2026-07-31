import { ulid } from '../ids';
import { getDb } from '../index';
import * as toolAttachmentsRepo from './tool-attachments';
import type Database from 'better-sqlite3';
import type {
	Message,
	MessageStatus,
	Role,
	ToolCallRecord,
	FileEditRecord,
	ReasoningBlockRecord
} from '$lib/types';

interface MsgRow {
	id: string;
	conversation_id: string;
	role: string;
	content: string;
	status: string;
	error_code: string | null;
	created_at: number;
	reasoning: string | null;
	reasoning_duration_ms: number | null;
}

interface ToolRow {
	id: string;
	message_id: string;
	tool: string;
	args_json: string | null;
	result_json: string | null;
	args_bytes?: number;
	result_bytes?: number;
	status: string;
	started_at: number;
	ended_at: number | null;
	text_offset: number | null;
	parent_tool_call_id: string | null;
}

interface BackgroundAgentLifecycleRow {
	tool_call_id: string;
	agent_id: string;
	status: 'running' | 'completed' | 'failed';
	started_at: number;
	ended_at: number | null;
}

interface EditRow {
	id: string;
	message_id: string;
	path: string;
	diff: string | null;
	diff_bytes?: number;
	created_at: number;
	text_offset: number | null;
	parent_tool_call_id: string | null;
}

interface ReasoningRow {
	id: string;
	message_id: string;
	segment_index: number;
	text: string | null;
	text_bytes?: number;
	kind: string;
	text_offset: number | null;
	started_at: number;
	duration_ms: number | null;
	parent_tool_call_id: string | null;
}

// SQLite is built with a cap on bound parameters per statement
// (`SQLITE_MAX_VARIABLE_NUMBER`, often 999 in bundled builds). Conversations
// can accumulate more message / tool-call ids than that, so any `IN (?, ...)`
// list built from such an array has to be split into batches well under the
// limit to avoid `SQLITE_RANGE`.
const ID_BATCH_SIZE = 500;

function batchIds<T>(ids: readonly T[], size = ID_BATCH_SIZE): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < ids.length; i += size) {
		batches.push(ids.slice(i, i + size));
	}
	return batches;
}

// Runs a `SELECT ... IN (<placeholders>) ...` statement once per id batch and
// concatenates the rows. `buildSql` receives the comma-separated placeholder
// list for the current batch; `leadingParams` are bound ahead of the id list
// (any `?` the projection itself uses). Rows whose grouping key lives entirely
// within a single batch (e.g. all tool_calls for a given message_id) keep their
// relative order, since each id appears in exactly one batch.
function selectInBatches<R>(
	db: Database.Database,
	ids: readonly string[],
	buildSql: (placeholders: string) => string,
	leadingParams: readonly (string | number)[] = []
): R[] {
	const rows: R[] = [];
	for (const batch of batchIds(ids)) {
		const placeholders = batch.map(() => '?').join(',');
		// Append element-by-element rather than spreading: a batch is capped at
		// 500 ids, but the rows it returns are not, and `push(...rows)` would hit
		// the JS argument limit for very large result sets.
		for (const row of db.prepare(buildSql(placeholders)).all(...leadingParams, ...batch) as R[]) {
			rows.push(row);
		}
	}
	return rows;
}

function runInBatches(
	db: Database.Database,
	ids: readonly string[],
	buildSql: (placeholders: string) => string
): void {
	for (const batch of batchIds(ids)) {
		const placeholders = batch.map(() => '?').join(',');
		db.prepare(buildSql(placeholders)).run(...batch);
	}
}

function rowToMessage(r: MsgRow): Message {
	return {
		id: r.id,
		conversationId: r.conversation_id,
		role: r.role as Role,
		content: r.content,
		status: r.status as MessageStatus,
		errorCode: r.error_code,
		createdAt: r.created_at
	};
}

export interface ListByConversationOptions {
	// When set, each of these caps the inline size (in UTF-8 bytes) of the
	// matching column: anything larger is omitted from the returned records and
	// flagged with the corresponding `*Truncated` / `*Bytes` markers. Used by
	// the conversation page so opening a long thread doesn't serialize megabytes
	// of collapsed-by-default tool output. Callers that need the real text
	// (export, fork, provider transcript replay, memory) pass nothing and get
	// exactly today's shape.
	inlineMaxBytes?: {
		args: number;
		result: number;
		diff: number;
		reasoning: number;
	};
}

// `length()` counts characters for TEXT; casting to BLOB first makes it count
// UTF-8 bytes, which is what actually lands on the wire.
function byteLen(col: string): string {
	return `length(CAST(${col} AS blob))`;
}

// Projects one large column as "inline if small, NULL if large" plus its byte
// size, so the trim decision happens in SQLite rather than after the whole blob
// has been marshalled into JS.
function trimmedColumn(col: string, alias: string, keepWhen = ''): string {
	return (
		`CASE WHEN ${keepWhen}${byteLen(col)} > ? THEN NULL ELSE ${col} END AS ${col}, ` +
		`${byteLen(col)} AS ${alias}`
	);
}

// A `task` call's arguments ARE the subagent card's identity: its headline,
// agent_type / model / background pills and the "Retry extraction" affordance
// all render on the COLLAPSED card. Trimming them would leave a reloaded
// conversation full of unlabelled, un-retryable "subagent" rows, so they stay
// inline regardless of size. (`task` calls are a small minority, so this costs
// little.) Its result is only rendered once the card is opened, and is trimmed
// like any other.
const ALWAYS_INLINE_ARGS_TOOLS = "tool <> 'task' AND ";

// A `kind = 'content'` reasoning block is a sub-agent's spoken answer, rendered
// as markdown in the card's activity timeline with no expand step. Only real
// "thinking" blocks — collapsed until clicked — are trimmed.
//
// A block with no `duration_ms` is still open: the turn is streaming it right
// now, so it renders EXPANDED and the client keeps appending deltas to it. Its
// text has to arrive inline, or a reload mid-turn would append the rest of the
// thought onto an empty string and silently lose the streamed prefix. There is
// at most one such block per open, so keeping it costs nothing.
const ALWAYS_INLINE_REASONING = "kind <> 'content' AND duration_ms IS NOT NULL AND ";

export function listByConversation(
	conversationId: string,
	opts: ListByConversationOptions = {}
): Message[] {
	const db = getDb();
	const limits = opts.inlineMaxBytes;
	const trim = limits !== undefined;
	const rows = db
		.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC')
		.all(conversationId) as MsgRow[];
	const msgs = rows.map(rowToMessage);
	if (msgs.length === 0) return msgs;

	const toolCols = trim
		? `id, message_id, tool, ${trimmedColumn('args_json', 'args_bytes', ALWAYS_INLINE_ARGS_TOOLS)}, ` +
			`${trimmedColumn('result_json', 'result_bytes')}, ` +
			`status, started_at, ended_at, text_offset, parent_tool_call_id`
		: '*';
	const editCols = trim
		? `id, message_id, path, ${trimmedColumn('diff', 'diff_bytes')}, ` +
			`created_at, text_offset, parent_tool_call_id`
		: '*';
	const reasoningCols = trim
		? `id, message_id, segment_index, ` +
			`${trimmedColumn('text', 'text_bytes', ALWAYS_INLINE_REASONING)}, ` +
			`kind, text_offset, started_at, duration_ms, parent_tool_call_id`
		: '*';

	const ids = msgs.map((m) => m.id);
	const toolRows = selectInBatches<ToolRow>(
		db,
		ids,
		(placeholders) =>
			`SELECT ${toolCols} FROM tool_calls WHERE message_id IN (${placeholders}) ORDER BY started_at ASC`,
		// One bind per `CASE WHEN ... > ?`, in column order.
		limits ? [limits.args, limits.result] : []
	);
	const toolIds = toolRows.map((t) => t.id);
	const lifecycleRows = selectInBatches<BackgroundAgentLifecycleRow>(
		db,
		toolIds,
		(placeholders) =>
			`SELECT * FROM background_agent_lifecycles WHERE tool_call_id IN (${placeholders})`
	);
	const lifecycleByTool = new Map(lifecycleRows.map((r) => [r.tool_call_id, r]));
	const editRows = selectInBatches<EditRow>(
		db,
		ids,
		(placeholders) =>
			`SELECT ${editCols} FROM file_edits WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`,
		limits ? [limits.diff] : []
	);
	const reasoningRows = selectInBatches<ReasoningRow>(
		db,
		ids,
		(placeholders) =>
			`SELECT ${reasoningCols} FROM reasoning_blocks WHERE message_id IN (${placeholders}) ORDER BY segment_index ASC`,
		limits ? [limits.reasoning] : []
	);

	const byMsgT: Record<string, ToolCallRecord[]> = {};
	const attachmentsByTool = toolAttachmentsRepo.listMetaForToolCalls(toolIds);
	for (const t of toolRows) {
		const lifecycle = lifecycleByTool.get(t.id);
		const attachments = attachmentsByTool.get(t.id);
		// A NULL alongside a non-zero byte count means "trimmed", not "absent";
		// `result_json` is legitimately NULL while a call is still pending.
		const argsTruncated = trim && t.args_json === null && (t.args_bytes ?? 0) > 0;
		const resultTruncated = trim && t.result_json === null && (t.result_bytes ?? 0) > 0;
		(byMsgT[t.message_id] ??= []).push({
			id: t.id,
			messageId: t.message_id,
			tool: t.tool,
			argsJson: t.args_json,
			resultJson: t.result_json,
			...(argsTruncated ? { argsTruncated: true, argsBytes: t.args_bytes } : {}),
			...(resultTruncated ? { resultTruncated: true, resultBytes: t.result_bytes } : {}),
			status: t.status as ToolCallRecord['status'],
			startedAt: t.started_at,
			endedAt: t.ended_at,
			textOffset: t.text_offset,
			parentToolCallId: t.parent_tool_call_id,
			backgroundAgentStatus: lifecycle?.status ?? null,
			backgroundAgentId: lifecycle?.agent_id ?? null,
			backgroundAgentStartedAt: lifecycle?.started_at ?? null,
			backgroundAgentEndedAt: lifecycle?.ended_at ?? null,
			...(attachments && attachments.length > 0 ? { attachments } : {})
		});
	}
	const byMsgE: Record<string, FileEditRecord[]> = {};
	for (const e of editRows) {
		const diffTruncated = trim && e.diff === null && (e.diff_bytes ?? 0) > 0;
		(byMsgE[e.message_id] ??= []).push({
			id: e.id,
			messageId: e.message_id,
			path: e.path,
			diff: e.diff,
			...(diffTruncated ? { diffTruncated: true, diffBytes: e.diff_bytes } : {}),
			createdAt: e.created_at,
			textOffset: e.text_offset,
			parentToolCallId: e.parent_tool_call_id
		});
	}
	const byMsgR: Record<string, ReasoningBlockRecord[]> = {};
	for (const r of reasoningRows) {
		// `text` is NOT NULL in the schema, so a NULL here can only be the trim.
		const textTruncated = trim && r.text === null;
		(byMsgR[r.message_id] ??= []).push({
			id: r.id,
			messageId: r.message_id,
			segmentIndex: r.segment_index,
			text: r.text,
			...(textTruncated ? { textTruncated: true, textBytes: r.text_bytes } : {}),
			kind: r.kind === 'content' ? 'content' : 'reasoning',
			textOffset: r.text_offset,
			startedAt: r.started_at,
			durationMs: r.duration_ms,
			parentToolCallId: r.parent_tool_call_id
		});
	}
	for (const m of msgs) {
		m.toolCalls = byMsgT[m.id] ?? [];
		m.fileEdits = byMsgE[m.id] ?? [];
		m.reasoningBlocks = byMsgR[m.id] ?? [];
	}
	return msgs;
}

// Build a trigram FTS5 query for a literal substring search. Trigram matching
// needs at least 3 characters; shorter terms can't use the index, so we return
// null and the caller falls back to a plain scan. The whole term is sent as one
// quoted phrase (double quotes stripped — they're the phrase delimiter) so a
// multi-word query matches the literal substring including its spaces.
function ftsPhrase(term: string): string | null {
	if (term.length < 3) return null;
	return `"${term.replace(/"/g, '')}"`;
}

export function searchConversation(
	conversationId: string,
	query: string,
	opts: { limit?: number } = {}
): Message[] {
	const term = query.trim();
	if (!term) return [];
	const limit = opts.limit ?? 20;
	const phrase = ftsPhrase(term);
	// Sub-trigram (1-2 char) queries can't use the trigram index; fall back to a
	// scan to preserve the exact-literal contract for those rare short terms.
	if (!phrase) {
		const rows = getDb()
			.prepare(
				`SELECT * FROM messages
				  WHERE conversation_id = ?
				    AND instr(lower(content), lower(?)) > 0
				  ORDER BY created_at DESC, id DESC
				  LIMIT ?`
			)
			.all(conversationId, term, limit) as MsgRow[];
		return rows.map(rowToMessage).reverse();
	}
	// Trigram FTS5 MATCH narrows to messages whose content contains the literal
	// substring; instr then re-confirms the exact match (trigram is case-folded,
	// so e.g. "FOO" can MATCH "foo"). The index makes this fast on huge threads.
	const rows = getDb()
		.prepare(
			`SELECT m.* FROM messages_fts f
			   JOIN messages m ON m.id = f.message_id
			  WHERE f.conversation_id = ?
			    AND messages_fts MATCH ?
			    AND instr(lower(m.content), lower(?)) > 0
			  ORDER BY m.created_at DESC, m.id DESC
			  LIMIT ?`
		)
		.all(conversationId, phrase, term, limit) as MsgRow[];
	return rows.map(rowToMessage).reverse();
}

export interface AppendInput {
	role: Role;
	content: string;
	status?: MessageStatus;
	errorCode?: string | null;
}

export function append(conversationId: string, input: AppendInput): Message {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO messages(id, conversation_id, role, content, status, error_code, created_at, reasoning, reasoning_duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
		)
		.run(
			id,
			conversationId,
			input.role,
			input.content,
			input.status ?? 'complete',
			input.errorCode ?? null,
			now
		);
	return {
		id,
		conversationId,
		role: input.role,
		content: input.content,
		status: input.status ?? 'complete',
		errorCode: input.errorCode ?? null,
		createdAt: now
	};
}

export function updateStatus(id: string, status: MessageStatus, errorCode?: string | null) {
	getDb()
		.prepare('UPDATE messages SET status = ?, error_code = ? WHERE id = ?')
		.run(status, errorCode ?? null, id);
}

export function updateContent(
	id: string,
	content: string,
	status: MessageStatus,
	errorCode?: string | null
) {
	getDb()
		.prepare('UPDATE messages SET content = ?, status = ?, error_code = ? WHERE id = ?')
		.run(content, status, errorCode ?? null, id);
}

export function updateContentOnly(id: string, content: string) {
	getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
}

export function truncateAfterAndUpdateUserMessage(
	conversationId: string,
	messageId: string,
	content: string
): Message | null {
	const db = getDb();
	const tx = db.transaction(() => {
		const target = db
			.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?')
			.get(conversationId, messageId) as MsgRow | undefined;
		if (!target) return null;

		deleteMessagesAfter(db, conversationId, target);

		db.prepare(
			`UPDATE messages
			    SET content = ?,
			        status = 'complete',
			        error_code = NULL
			  WHERE id = ?`
		).run(content, messageId);

		return rowToMessage({
			...target,
			content,
			status: 'complete',
			error_code: null
		});
	});
	return tx();
}

function deleteMessagesAfter(db: Database.Database, conversationId: string, target: MsgRow): void {
	const later = db
		.prepare(
			`SELECT id FROM messages
			  WHERE conversation_id = ?
			    AND (created_at > ? OR (created_at = ? AND id > ?))`
		)
		.all(conversationId, target.created_at, target.created_at, target.id) as { id: string }[];
	const laterIds = later.map((r) => r.id);
	if (laterIds.length === 0) return;
	runInBatches(
		db,
		laterIds,
		(placeholders) => `DELETE FROM reasoning_blocks WHERE message_id IN (${placeholders})`
	);
	runInBatches(
		db,
		laterIds,
		(placeholders) => `DELETE FROM file_edits WHERE message_id IN (${placeholders})`
	);
	// Deleting tool_calls cascades (ON DELETE CASCADE) to its child tables:
	// background_agent_lifecycles (migration 044). No manual cleanup of those
	// children is needed here — adding one would be dead code.
	runInBatches(
		db,
		laterIds,
		(placeholders) => `DELETE FROM tool_calls WHERE message_id IN (${placeholders})`
	);
	runInBatches(
		db,
		laterIds,
		(placeholders) => `DELETE FROM messages WHERE id IN (${placeholders})`
	);
}

export function truncateAfterMessage(conversationId: string, messageId: string): boolean {
	const db = getDb();
	const tx = db.transaction(() => {
		const target = db
			.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?')
			.get(conversationId, messageId) as MsgRow | undefined;
		if (!target) return false;
		deleteMessagesAfter(db, conversationId, target);
		return true;
	});
	return tx();
}

// Writes always carry the real arguments: only the read side (a trimmed page
// payload) can produce a null `argsJson`, and `tool_calls.args_json` is NOT
// NULL. Requiring it here keeps a trimmed record from being wired into an
// insert/clone path and failing as a runtime constraint violation instead of a
// compile error.
type ToolCallInsert = Omit<ToolCallRecord, 'messageId'> & { argsJson: string };

export function insertToolCall(messageId: string, t: ToolCallInsert) {
	getDb()
		.prepare(
			`INSERT INTO tool_calls(
			   id, message_id, tool, args_json, result_json, status, started_at, ended_at,
			   text_offset, parent_tool_call_id
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			t.id,
			messageId,
			t.tool,
			t.argsJson,
			t.resultJson,
			t.status,
			t.startedAt,
			t.endedAt,
			t.textOffset,
			t.parentToolCallId ?? null
		);
}

export function upsertToolCall(messageId: string, t: ToolCallInsert) {
	getDb()
		.prepare(
			`INSERT INTO tool_calls(
			   id, message_id, tool, args_json, result_json, status, started_at, ended_at,
			   text_offset, parent_tool_call_id
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   message_id = excluded.message_id,
			   tool = excluded.tool,
			   args_json = excluded.args_json,
			   result_json = excluded.result_json,
			   status = excluded.status,
			   started_at = excluded.started_at,
			   ended_at = excluded.ended_at,
			   text_offset = excluded.text_offset,
			   parent_tool_call_id = excluded.parent_tool_call_id`
		)
		.run(
			t.id,
			messageId,
			t.tool,
			t.argsJson,
			t.resultJson,
			t.status,
			t.startedAt,
			t.endedAt,
			t.textOffset,
			t.parentToolCallId ?? null
		);
}

export function getToolCallArgs(id: string): unknown | null {
	const row = getDb().prepare('SELECT args_json FROM tool_calls WHERE id = ?').get(id) as
		| { args_json: string }
		| undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.args_json);
	} catch {
		return null;
	}
}

export function updateToolCall(
	id: string,
	patch: Partial<Pick<ToolCallRecord, 'resultJson' | 'status' | 'endedAt'>>
) {
	const fields: string[] = [];
	const values: unknown[] = [];
	if (patch.resultJson !== undefined) {
		fields.push('result_json = ?');
		values.push(patch.resultJson);
	}
	if (patch.status !== undefined) {
		fields.push('status = ?');
		values.push(patch.status);
	}
	if (patch.endedAt !== undefined) {
		fields.push('ended_at = ?');
		values.push(patch.endedAt);
	}
	if (fields.length === 0) return;
	values.push(id);
	getDb()
		.prepare(`UPDATE tool_calls SET ${fields.join(', ')} WHERE id = ?`)
		.run(...values);
}

export function updateBackgroundAgentLifecycle(
	toolCallId: string,
	agentId: string,
	status: 'running' | 'completed' | 'failed',
	now: number = Date.now()
) {
	const db = getDb();
	db.prepare(
		`INSERT INTO background_agent_lifecycles(
		   tool_call_id, agent_id, status, started_at, ended_at
		 )
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(tool_call_id) DO UPDATE SET
		   agent_id = excluded.agent_id,
		   status = CASE
		     WHEN background_agent_lifecycles.status IN ('completed', 'failed')
		       THEN background_agent_lifecycles.status
		     ELSE excluded.status
		   END,
		   started_at = min(background_agent_lifecycles.started_at, excluded.started_at),
		   ended_at = COALESCE(background_agent_lifecycles.ended_at, excluded.ended_at)`
	).run(toolCallId, agentId, status, now, status === 'running' ? null : now);
}

export interface ToolCallWithConversation extends ToolCallRecord {
	// This lookup always reads the stored row directly, so the args are never
	// the page payload's trimmed marker — narrow the type back to non-null for
	// the rerun flow, which needs the exact original arguments.
	argsJson: string;
	conversationId: string;
	conversationUserId: string;
	messageRole: Role;
}

export function getToolCallForConversation(
	conversationId: string,
	toolCallId: string
): ToolCallWithConversation | null {
	const db = getDb();
	const row = db
		.prepare(
			`SELECT tc.*,
			        m.conversation_id,
			        m.role AS message_role,
			        c.user_id AS conversation_user_id,
			        bal.agent_id AS background_agent_id,
			        bal.status AS background_agent_status,
			        bal.started_at AS background_agent_started_at,
			        bal.ended_at AS background_agent_ended_at
			   FROM tool_calls tc
			   JOIN messages m ON m.id = tc.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			   LEFT JOIN background_agent_lifecycles bal ON bal.tool_call_id = tc.id
			  WHERE tc.id = ? AND m.conversation_id = ?`
		)
		.get(toolCallId, conversationId) as
		| (ToolRow & {
				conversation_id: string;
				conversation_user_id: string;
				message_role: string;
				background_agent_id: string | null;
				background_agent_status: 'running' | 'completed' | 'failed' | null;
				background_agent_started_at: number | null;
				background_agent_ended_at: number | null;
		  })
		| undefined;
	if (!row) return null;
	return {
		id: row.id,
		messageId: row.message_id,
		tool: row.tool,
		// `SELECT tc.*` on a NOT NULL column: never actually null, and never
		// trimmed (this path doesn't go through listByConversation).
		argsJson: row.args_json ?? '',
		resultJson: row.result_json,
		status: row.status as ToolCallRecord['status'],
		startedAt: row.started_at,
		endedAt: row.ended_at,
		textOffset: row.text_offset,
		parentToolCallId: row.parent_tool_call_id,
		backgroundAgentStatus: row.background_agent_status,
		backgroundAgentId: row.background_agent_id,
		backgroundAgentStartedAt: row.background_agent_started_at,
		backgroundAgentEndedAt: row.background_agent_ended_at,
		conversationId: row.conversation_id,
		conversationUserId: row.conversation_user_id,
		messageRole: row.message_role as Role
	};
}

// Full text of one large field that a trimmed conversation payload omitted.
// Ownership is enforced in the query itself (tool call → message →
// conversation owner), so a mismatched user gets the same `null` an unknown id
// does and the endpoint can 404 without leaking existence.
export function getToolCallFieldForOwner(
	conversationId: string,
	toolCallId: string,
	userId: string,
	field: 'args' | 'result'
): { value: string | null } | null {
	const column = field === 'args' ? 'tc.args_json' : 'tc.result_json';
	const row = getDb()
		.prepare(
			`SELECT ${column} AS value
			   FROM tool_calls tc
			   JOIN messages m ON m.id = tc.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE tc.id = ? AND m.conversation_id = ? AND c.user_id = ?`
		)
		.get(toolCallId, conversationId, userId) as { value: string | null } | undefined;
	return row ?? null;
}

export function getFileEditDiffForOwner(
	conversationId: string,
	fileEditId: string,
	userId: string
): { value: string | null } | null {
	const row = getDb()
		.prepare(
			`SELECT fe.diff AS value
			   FROM file_edits fe
			   JOIN messages m ON m.id = fe.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE fe.id = ? AND m.conversation_id = ? AND c.user_id = ?`
		)
		.get(fileEditId, conversationId, userId) as { value: string | null } | undefined;
	return row ?? null;
}

export function getReasoningTextForOwner(
	conversationId: string,
	reasoningBlockId: string,
	userId: string
): { value: string | null } | null {
	const row = getDb()
		.prepare(
			`SELECT rb.text AS value
			   FROM reasoning_blocks rb
			   JOIN messages m ON m.id = rb.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE rb.id = ? AND m.conversation_id = ? AND c.user_id = ?`
		)
		.get(reasoningBlockId, conversationId, userId) as { value: string | null } | undefined;
	return row ?? null;
}

export function insertFileEdit(
	messageId: string,
	path: string,
	diff: string,
	textOffset: number | null = null,
	parentToolCallId: string | null = null
) {
	const id = ulid();
	getDb()
		.prepare(
			`INSERT INTO file_edits(id, message_id, path, diff, created_at, text_offset, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, messageId, path, diff, Date.now(), textOffset, parentToolCallId);
}

// Writes always carry real text: `reasoning_blocks.text` is NOT NULL, and only
// a *trimmed read* (see `inlineMaxBytes`) ever hands back a null.
type ReasoningBlockWrite = Omit<ReasoningBlockRecord, 'messageId' | 'text'> & { text: string };

export function upsertReasoningBlock(messageId: string, r: ReasoningBlockWrite) {
	getDb()
		.prepare(
			`INSERT INTO reasoning_blocks(id, message_id, segment_index, text, kind, text_offset, started_at, duration_ms, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   message_id = excluded.message_id,
			   segment_index = excluded.segment_index,
			   text = excluded.text,
			   kind = excluded.kind,
			   text_offset = excluded.text_offset,
			   started_at = excluded.started_at,
			   duration_ms = excluded.duration_ms,
			   parent_tool_call_id = excluded.parent_tool_call_id`
		)
		.run(
			r.id,
			messageId,
			r.segmentIndex,
			r.text,
			r.kind ?? 'reasoning',
			r.textOffset,
			r.startedAt,
			r.durationMs ?? null,
			r.parentToolCallId ?? null
		);
}

export function insertReasoningBlock(messageId: string, r: ReasoningBlockWrite) {
	getDb()
		.prepare(
			`INSERT INTO reasoning_blocks(id, message_id, segment_index, text, kind, text_offset, started_at, duration_ms, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			r.id,
			messageId,
			r.segmentIndex,
			r.text,
			r.kind ?? 'reasoning',
			r.textOffset,
			r.startedAt,
			r.durationMs ?? null,
			r.parentToolCallId ?? null
		);
}

export function recoverInterruptedInFlight(now: number = Date.now()): {
	messages: number;
	toolCalls: number;
} {
	const db = getDb();
	const tx = db.transaction(() => {
		const msg = db
			.prepare(
				`UPDATE messages
				   SET status = 'interrupted',
				       error_code = COALESCE(error_code, 'server_restarted')
				 WHERE status = 'streaming'`
			)
			.run();
		const tools = db
			.prepare(
				`UPDATE tool_calls
				   SET status = 'error',
				       ended_at = COALESCE(ended_at, ?)
				 WHERE status = 'pending'`
			)
			.run(now);
		db.prepare(
			`UPDATE background_agent_lifecycles
			    SET status = 'failed',
			        ended_at = COALESCE(ended_at, ?)
			  WHERE status = 'running'`
		).run(now);
		return { messages: msg.changes, toolCalls: tools.changes };
	});
	return tx();
}
