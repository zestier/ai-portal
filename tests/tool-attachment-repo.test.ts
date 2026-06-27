import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

async function imports() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const toolAttachments = await import('../src/lib/server/db/repos/tool-attachments');
	const flush = await import('../src/lib/server/copilot/tool-attachment-flush');
	const buffer = await import('../src/lib/server/copilot/tool-attachment-buffer');
	const db = await import('../src/lib/server/db');
	return { users, convs, messages, toolAttachments, flush, buffer, db };
}

describe('tool attachments repo + flush (DB)', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-attach-db-');
	});

	it('flushes a buffered image once the tool_calls row exists and hydrates meta', async () => {
		const { users, convs, messages, toolAttachments, flush, buffer, db } = await imports();
		buffer._clearBuffer();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: '/ws', model: null });
		const a = messages.append(conv.id, { role: 'assistant', content: '' });
		messages.insertToolCall(a.id, {
			id: 'tc-img',
			tool: 'view',
			argsJson: JSON.stringify({ path: 'shot.png' }),
			resultJson: null,
			status: 'ok',
			startedAt: Date.now(),
			endedAt: Date.now(),
			textOffset: 0,
			parentToolCallId: null
		});

		// stage bytes as the interactive adapter would (keyed by toolCallId)
		buffer.bufferAttachment([buffer.toolCallKey('tc-img')], {
			kind: 'image',
			mimeType: 'image/png',
			data: PNG,
			sourcePath: '/ws/shot.png',
			bufferedAt: Date.now()
		});

		const meta = flush.flushToolAttachment({
			toolCallId: 'tc-img',
			conversationId: conv.id,
			workingDirectory: '/ws',
			argsJson: JSON.stringify({ path: 'shot.png' })
		});
		expect(meta).not.toBeNull();
		expect(meta!.mimeType).toBe('image/png');
		expect(meta!.byteSize).toBe(PNG.length);
		expect(buffer._bufferSize()).toBe(0);

		// meta hydrates onto the loaded tool call (no bytes)
		const msgs = messages.listByConversation(conv.id);
		const tc = msgs.find((m) => m.id === a.id)?.toolCalls?.find((t) => t.id === 'tc-img');
		expect(tc?.attachments).toHaveLength(1);
		expect(tc?.attachments?.[0].mimeType).toBe('image/png');

		// owner can read bytes; wrong user cannot
		const bytes = toolAttachments.getForOwner(conv.id, 'tc-img', meta!.id, u.id);
		expect(bytes?.data.equals(PNG)).toBe(true);
		expect(toolAttachments.getForOwner(conv.id, 'tc-img', meta!.id, 'someone-else')).toBeNull();

		// flushing again is a no-op (bytes already consumed from buffer)
		expect(
			flush.flushToolAttachment({
				toolCallId: 'tc-img',
				conversationId: conv.id,
				workingDirectory: '/ws',
				argsJson: JSON.stringify({ path: 'shot.png' })
			})
		).toBeNull();

		// cascade: deleting the conversation removes the attachment row
		const handle = db.getDb();
		expect(toolAttachments._countForToolCall(handle, 'tc-img')).toBe(1);
		handle.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
		expect(toolAttachments._countForToolCall(handle, 'tc-img')).toBe(0);
	});

	it('returns null when nothing was staged for the tool call', async () => {
		const { users, convs, messages, flush, buffer } = await imports();
		buffer._clearBuffer();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: '/ws', model: null });
		const a = messages.append(conv.id, { role: 'assistant', content: '' });
		messages.insertToolCall(a.id, {
			id: 'tc-plain',
			tool: 'view',
			argsJson: JSON.stringify({ path: 'notes.txt' }),
			resultJson: null,
			status: 'ok',
			startedAt: Date.now(),
			endedAt: Date.now(),
			textOffset: 0,
			parentToolCallId: null
		});
		expect(
			flush.flushToolAttachment({
				toolCallId: 'tc-plain',
				conversationId: conv.id,
				workingDirectory: '/ws',
				argsJson: JSON.stringify({ path: 'notes.txt' })
			})
		).toBeNull();
	});

	it('directly captures a view`d image when nothing was buffered', async () => {
		const { users, convs, messages, toolAttachments, flush, buffer } = await imports();
		buffer._clearBuffer();
		// The native `view` tool's in-workspace reads are auto-allowed by the SDK
		// without invoking our permission callback, so nothing gets buffered. The
		// flush must still capture the image directly from the path arg.
		const ws = makeTmpDir('portal-attach-direct-');
		const imgPath = join(ws, 'shot.png');
		writeFileSync(imgPath, Buffer.concat([PNG, Buffer.alloc(16, 7)]));

		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: ws, model: null });
		const a = messages.append(conv.id, { role: 'assistant', content: '' });
		messages.insertToolCall(a.id, {
			id: 'tc-direct',
			tool: 'view',
			argsJson: JSON.stringify({ path: 'shot.png' }),
			resultJson: null,
			status: 'ok',
			startedAt: Date.now(),
			endedAt: Date.now(),
			textOffset: 0,
			parentToolCallId: null
		});

		const meta = flush.flushToolAttachment({
			toolCallId: 'tc-direct',
			conversationId: conv.id,
			workingDirectory: ws,
			argsJson: JSON.stringify({ path: 'shot.png' }),
			tool: 'view'
		});
		expect(meta).not.toBeNull();
		expect(meta!.mimeType).toBe('image/png');
		const bytes = toolAttachments.getForOwner(conv.id, 'tc-direct', meta!.id, u.id);
		expect(bytes?.mimeType).toBe('image/png');

		// A non-viewer tool must NOT direct-capture even with an image path arg.
		buffer._clearBuffer();
		messages.insertToolCall(a.id, {
			id: 'tc-other',
			tool: 'bash',
			argsJson: JSON.stringify({ path: 'shot.png' }),
			resultJson: null,
			status: 'ok',
			startedAt: Date.now(),
			endedAt: Date.now(),
			textOffset: 0,
			parentToolCallId: null
		});
		expect(
			flush.flushToolAttachment({
				toolCallId: 'tc-other',
				conversationId: conv.id,
				workingDirectory: ws,
				argsJson: JSON.stringify({ path: 'shot.png' }),
				tool: 'bash'
			})
		).toBeNull();
	});
});
