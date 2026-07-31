import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as messages from '$lib/server/db/repos/messages';

// Lazy fetch for the large fields the conversation page payload omits (see
// `INLINE_FIELD_MAX_BYTES`): a tool call's `args_json` / `result_json`, or a
// file edit's `diff`. The client hits this the first time the user expands a
// tool call or diff whose content was trimmed.
//
// Ownership is enforced in the repo query (record → message → conversation
// owner). Another user's id — or a valid id belonging to a different
// conversation — is a flat 404 rather than a 403, so ids stay non-enumerable.
//
// The response is the raw stored text (not re-wrapped in JSON) so the client
// gets byte-identical content to what the inline path would have carried, with
// no double-encoding cost on a field that can be hundreds of KB.

const FIELD_KINDS = ['tool-args', 'tool-result', 'file-diff'] as const;
type FieldKind = (typeof FIELD_KINDS)[number];

function isFieldKind(v: string | undefined): v is FieldKind {
	return !!v && (FIELD_KINDS as readonly string[]).includes(v);
}

export const GET: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const kind = params.kind;
	const recordId = params.recordId;
	if (!isFieldKind(kind)) throw error(404);
	if (!recordId) throw error(400, 'missing record id');

	const row =
		kind === 'file-diff'
			? messages.getFileEditDiffForOwner(conv.id, recordId, conv.userId)
			: messages.getToolCallFieldForOwner(
					conv.id,
					recordId,
					conv.userId,
					kind === 'tool-args' ? 'args' : 'result'
				);
	// No such record for this owner, or the column is genuinely NULL (e.g. a
	// tool call that never produced a result) — nothing to hand back either way.
	if (!row || row.value === null) throw error(404);

	return new Response(row.value, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			// Persisted tool args/results and file-edit diffs are immutable once
			// written (a rerun creates a new record), so the browser can keep
			// them privately for the life of the tab.
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
};
