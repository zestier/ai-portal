import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { INLINE_ARGS_MAX_BYTES } from '../src/lib/payload-limits';

// GET /api/conversations/[id]/fields/[kind]/[recordId] serves the large fields
// the conversation page payload trims away. It must be strictly scoped to the
// conversation's owner and must not confirm the existence of ids it won't serve.

const BIG_ARGS = JSON.stringify({ payload: 'a'.repeat(INLINE_ARGS_MAX_BYTES + 100) });
const BIG_RESULT = JSON.stringify({ ok: true, result: 'r'.repeat(4096) });
const BIG_DIFF = 'D'.repeat(9000);
const BIG_REASONING = 'T'.repeat(4096);

async function seed() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');

	const user = users.ensureLocalUser();
	const conv = convs.create(user.id, { title: 'fields', workdir: '/tmp', model: null });
	const msg = messages.append(conv.id, { role: 'assistant', content: 'hi' });
	messages.insertToolCall(msg.id, {
		id: 1,
		tool: 'bash',
		argsJson: BIG_ARGS,
		resultJson: BIG_RESULT,
		status: 'ok',
		startedAt: 1,
		endedAt: 2,
		textOffset: 0,
		parentToolCallId: null
	});
	messages.insertToolCall(msg.id, {
		id: 2,
		tool: 'bash',
		argsJson: '{}',
		resultJson: null,
		status: 'pending',
		startedAt: 3,
		endedAt: null,
		textOffset: 1,
		parentToolCallId: null
	});
	messages.insertFileEdit(msg.id, 'big.ts', BIG_DIFF, 0, null);
	messages.insertReasoningBlock(msg.id, {
		id: 3,
		segmentIndex: 0,
		text: BIG_REASONING,
		kind: 'reasoning',
		textOffset: 0,
		startedAt: 1,
		durationMs: 100,
		parentToolCallId: null
	});
	const [m] = messages.listByConversation(conv.id);
	const fileEditId = m.fileEdits![0].id;
	return { users, conv, user, fileEditId };
}

function makeEvent(convId: string, kind: string, recordId: string, userId: number | null) {
	const url = `http://127.0.0.1/api/conversations/${convId}/fields/${kind}/${recordId}`;
	return {
		params: { id: convId, kind, recordId },
		locals: { userId },
		url: new URL(url),
		request: new Request(url)
	};
}

async function callGet(convId: string, kind: string, recordId: string, userId: number | null) {
	const { GET } =
		await import('../src/routes/api/conversations/[id]/fields/[kind]/[recordId]/+server');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (GET as any)(makeEvent(convId, kind, recordId, userId));
}

async function status(promise: Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (e) {
		return (e as { status?: number }).status ?? 500;
	}
}

describe('conversation field endpoint', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-fields-route-');
	});

	it('serves tool args, tool results, file diffs and reasoning text verbatim', async () => {
		const { conv, user, fileEditId } = await seed();
		const args = await callGet(conv.id, 'tool-args', '1', user.id);
		expect(await args.text()).toBe(BIG_ARGS);
		expect(args.headers.get('content-type')).toContain('text/plain');

		const result = await callGet(conv.id, 'tool-result', '1', user.id);
		expect(await result.text()).toBe(BIG_RESULT);

		const diff = await callGet(conv.id, 'file-diff', String(fileEditId), user.id);
		expect(await diff.text()).toBe(BIG_DIFF);

		const reasoning = await callGet(conv.id, 'reasoning-text', '3', user.id);
		expect(await reasoning.text()).toBe(BIG_REASONING);
	});

	it('404s an unknown field kind rather than guessing', async () => {
		const { conv, user } = await seed();
		expect(await status(callGet(conv.id, 'tool-secrets', '1', user.id))).toBe(404);
	});

	it('404s a field that has no stored value', async () => {
		const { conv, user } = await seed();
		expect(await status(callGet(conv.id, 'tool-result', '2', user.id))).toBe(404);
	});

	it('404s (not 403) for another user, so ids stay non-enumerable', async () => {
		const { users, conv } = await seed();
		const other = users.upsertGithub({
			githubLogin: 'intruder',
			githubId: 909,
			displayName: null,
			avatarUrl: null
		});
		expect(await status(callGet(conv.id, 'tool-args', '1', other.id))).toBe(404);
	});

	it('rejects an unauthenticated caller', async () => {
		const { conv } = await seed();
		expect(await status(callGet(conv.id, 'tool-args', '1', null))).toBe(401);
	});

	it('404s a real tool call requested through the wrong conversation', async () => {
		const convs = await import('../src/lib/server/db/repos/conversations');
		const { user } = await seed();
		const sibling = convs.create(user.id, { title: 'other', workdir: '/tmp', model: null });
		expect(await status(callGet(sibling.id, 'tool-args', '1', user.id))).toBe(404);
	});
});
