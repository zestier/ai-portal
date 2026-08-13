import type { RequestHandler } from './$types';
import { conversationId as convCodec } from '$lib/ids';
import * as messages from '$lib/server/db/repos/messages';
import * as memory from '$lib/server/db/repos/memory';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { isHiddenVisibility } from '$lib/server/memory/engine';

// GET /api/conversations/:id/export — emits a single markdown file
// summarizing the conversation.
export const GET: RequestHandler = ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const convId = convCodec.parse(conv.id);
	// Untrimmed on purpose: an export must contain the full tool args/results
	// and diffs, not the page payload's lazily-fetched markers.
	const msgs = messages.listByConversation(convId);

	const lines: string[] = [];
	lines.push(`# ${conv.title}`);
	lines.push('');
	lines.push(`- Created: ${new Date(conv.createdAt).toISOString()}`);
	lines.push(`- Workdir: \`${conv.workdir}\``);
	if (conv.model) lines.push(`- Model: ${conv.model}`);
	lines.push(`- Memory mode: ${conv.memoryMode}`);
	lines.push('');

	for (const m of msgs) {
		lines.push(`---`);
		lines.push(`## ${m.role} — ${new Date(m.createdAt).toISOString()}`);
		lines.push('');
		// Children of sub-agent task calls (parentToolCallId set) are not
		// rendered at the message level — they belong inside the outer task
		// call's section. The task call's own result_json already contains
		// the sub-agent's final response, which is what's most useful in an
		// export.
		const tools = (m.toolCalls ?? []).filter((t) => t.parentToolCallId == null);
		const edits = (m.fileEdits ?? []).filter((e) => e.parentToolCallId == null);
		const content = m.content ?? '';

		const trailingTools = tools.filter((t) => t.textOffset == null);
		const trailingEdits = edits.filter((e) => e.textOffset == null);
		type Anchor =
			| { offset: number; order: number; kind: 'tool'; tool: (typeof tools)[number] }
			| { offset: number; order: number; kind: 'edit'; edit: (typeof edits)[number] };
		const anchors: Anchor[] = [];
		let order = 0;
		for (const t of tools)
			if (t.textOffset != null)
				anchors.push({
					offset: Math.min(t.textOffset, content.length),
					order: order++,
					kind: 'tool',
					tool: t
				});
		for (const e of edits)
			if (e.textOffset != null)
				anchors.push({
					offset: Math.min(e.textOffset, content.length),
					order: order++,
					kind: 'edit',
					edit: e
				});
		anchors.sort((a, b) => a.offset - b.offset || a.order - b.order);

		const emitTool = (tc: (typeof tools)[number]) => {
			lines.push(`> tool: \`${tc.tool}\` — ${tc.status}`);
			lines.push('```json');
			lines.push(tc.argsJson ?? '');
			lines.push('```');
			if (tc.resultJson) {
				lines.push('```json');
				lines.push(tc.resultJson);
				lines.push('```');
			}
		};
		const emitEdit = (fe: (typeof edits)[number]) => {
			lines.push(`> file edit: \`${fe.path}\``);
			lines.push('```diff');
			lines.push(fe.diff ?? '');
			lines.push('```');
		};

		let cursor = 0;
		for (const a of anchors) {
			if (a.offset > cursor) {
				lines.push(content.slice(cursor, a.offset));
				cursor = a.offset;
			}
			if (a.kind === 'tool') emitTool(a.tool);
			else emitEdit(a.edit);
		}
		if (cursor < content.length) lines.push(content.slice(cursor));
		else if (cursor === 0) lines.push(content);
		lines.push('');
		for (const tc of trailingTools) emitTool(tc);
		for (const fe of trailingEdits) emitEdit(fe);
	}

	const snapshot = memory.listSnapshot(convId);
	if (conv.memoryMode !== 'off' || hasMemoryRecords(snapshot)) {
		const exportable: memory.MemorySnapshot = {
			...snapshot,
			facts: snapshot.facts.filter((f) => !isHiddenVisibility(f.visibility)),
			events: snapshot.events.filter((e) => !isHiddenVisibility(e.visibility))
		};
		lines.push('---');
		lines.push('## Session memory');
		lines.push('');
		lines.push('```json');
		lines.push(JSON.stringify(exportable, null, 2));
		lines.push('```');
		lines.push('');
	}

	const body = lines.join('\n');
	return new Response(body, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="conversation-${conv.id}.md"`
		}
	});
};

function hasMemoryRecords(snapshot: memory.MemorySnapshot): boolean {
	return (
		snapshot.entities.length +
			snapshot.facts.length +
			snapshot.openLoops.length +
			snapshot.events.length +
			snapshot.patches.length +
			snapshot.issues.length +
			snapshot.toolCalls.length +
			snapshot.patchItems.length +
			(snapshot.globalMemories?.length ?? 0) >
		0
	);
}
