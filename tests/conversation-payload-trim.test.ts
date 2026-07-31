import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import {
	INLINE_ARGS_MAX_BYTES,
	INLINE_DIFF_MAX_BYTES,
	INLINE_RESULT_MAX_BYTES
} from '../src/lib/payload-limits';

// Opening a long conversation used to serialize every tool call's full args and
// result into the page payload. `listByConversation({ inlineMaxBytes })` swaps
// oversized fields for truncation markers; everything else must keep exactly
// the shape it had before.

const TRIM = {
	args: INLINE_ARGS_MAX_BYTES,
	result: INLINE_RESULT_MAX_BYTES,
	diff: INLINE_DIFF_MAX_BYTES
};

async function seed() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');

	const user = users.ensureLocalUser();
	const conv = convs.create(user.id, { title: 'trim', workdir: '/tmp', model: null });
	const msg = messages.append(conv.id, { role: 'assistant', content: 'hi' });

	const bigArgs = JSON.stringify({ payload: 'a'.repeat(INLINE_ARGS_MAX_BYTES + 100) });
	const smallArgs = JSON.stringify({ path: 'src/app.ts' });
	const bigResult = JSON.stringify({ ok: true, result: 'r'.repeat(INLINE_RESULT_MAX_BYTES + 100) });
	const smallResult = JSON.stringify({ ok: true, result: 'short' });

	messages.insertToolCall(msg.id, {
		id: 'tc-small',
		tool: 'view',
		argsJson: smallArgs,
		resultJson: smallResult,
		status: 'ok',
		startedAt: 1,
		endedAt: 2,
		textOffset: 0,
		parentToolCallId: null
	});
	messages.insertToolCall(msg.id, {
		id: 'tc-big',
		tool: 'bash',
		argsJson: bigArgs,
		resultJson: bigResult,
		status: 'ok',
		startedAt: 3,
		endedAt: 4,
		textOffset: 1,
		parentToolCallId: null
	});
	messages.insertToolCall(msg.id, {
		id: 'tc-pending',
		tool: 'bash',
		argsJson: smallArgs,
		resultJson: null,
		status: 'pending',
		startedAt: 5,
		endedAt: null,
		textOffset: 2,
		parentToolCallId: null
	});
	messages.insertToolCall(msg.id, {
		id: 'tc-task',
		tool: 'task',
		argsJson: JSON.stringify({
			agent_type: 'memory-extractor',
			description: 'extract',
			prompt: 'p'.repeat(INLINE_ARGS_MAX_BYTES + 5000)
		}),
		resultJson: bigResult,
		status: 'ok',
		startedAt: 6,
		endedAt: 7,
		textOffset: 3,
		parentToolCallId: null
	});
	messages.insertFileEdit(msg.id, 'small.ts', 'd'.repeat(10), 0, null);
	messages.insertFileEdit(msg.id, 'big.ts', 'D'.repeat(INLINE_DIFF_MAX_BYTES + 100), 1, null);

	return { user, conv, msg, bigArgs, smallArgs, bigResult, smallResult, messages };
}

describe('listByConversation payload trim', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-payload-trim-');
	});

	it('leaves every field inline when no trim is requested', async () => {
		const { conv, bigArgs, bigResult, messages } = await seed();
		const [m] = messages.listByConversation(conv.id);
		const big = m.toolCalls!.find((t) => t.id === 'tc-big')!;
		expect(big.argsJson).toBe(bigArgs);
		expect(big.resultJson).toBe(bigResult);
		expect(big.argsTruncated).toBeUndefined();
		expect(big.resultTruncated).toBeUndefined();
		const bigEdit = m.fileEdits!.find((e) => e.path === 'big.ts')!;
		expect(bigEdit.diff).toHaveLength(INLINE_DIFF_MAX_BYTES + 100);
		expect(bigEdit.diffTruncated).toBeUndefined();
	});

	it('replaces over-threshold fields with markers carrying the byte size', async () => {
		const { conv, bigArgs, bigResult, messages } = await seed();
		const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });

		const big = m.toolCalls!.find((t) => t.id === 'tc-big')!;
		expect(big.argsJson).toBeNull();
		expect(big.argsTruncated).toBe(true);
		expect(big.argsBytes).toBe(Buffer.byteLength(bigArgs, 'utf8'));
		expect(big.resultJson).toBeNull();
		expect(big.resultTruncated).toBe(true);
		expect(big.resultBytes).toBe(Buffer.byteLength(bigResult, 'utf8'));

		const bigEdit = m.fileEdits!.find((e) => e.path === 'big.ts')!;
		expect(bigEdit.diff).toBeNull();
		expect(bigEdit.diffTruncated).toBe(true);
		expect(bigEdit.diffBytes).toBe(INLINE_DIFF_MAX_BYTES + 100);
	});

	it('keeps under-threshold fields inline and unmarked', async () => {
		const { conv, smallArgs, smallResult, messages } = await seed();
		const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });

		const small = m.toolCalls!.find((t) => t.id === 'tc-small')!;
		expect(small.argsJson).toBe(smallArgs);
		expect(small.resultJson).toBe(smallResult);
		expect(small.argsTruncated).toBeUndefined();
		expect(small.resultTruncated).toBeUndefined();
		expect(small.argsBytes).toBeUndefined();

		const smallEdit = m.fileEdits!.find((e) => e.path === 'small.ts')!;
		expect(smallEdit.diff).toBe('d'.repeat(10));
		expect(smallEdit.diffTruncated).toBeUndefined();
	});

	it('never trims a subagent launch\u2019s arguments, whatever their size', async () => {
		// A `task` call's args carry the subagent card's headline, pills and
		// "Retry extraction" button — all rendered while the card is COLLAPSED,
		// so trimming them would leave a reloaded conversation full of
		// unlabelled, un-retryable rows. Its result is still trimmed.
		const { conv, messages } = await seed();
		const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
		const task = m.toolCalls!.find((t) => t.id === 'tc-task')!;
		expect(task.argsJson).not.toBeNull();
		expect(JSON.parse(task.argsJson!).agent_type).toBe('memory-extractor');
		expect(task.argsTruncated).toBeUndefined();
		expect(task.resultTruncated).toBe(true);
		expect(task.resultJson).toBeNull();
	});

	it('does not mark a genuinely absent result as truncated', async () => {
		// A pending call's result_json is NULL because there is no result yet —
		// the client must not offer to "load" something that does not exist.
		const { conv, messages } = await seed();
		const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
		const pending = m.toolCalls!.find((t) => t.id === 'tc-pending')!;
		expect(pending.resultJson).toBeNull();
		expect(pending.resultTruncated).toBeUndefined();
		expect(pending.resultBytes).toBeUndefined();
	});

	it('preserves every other field of a trimmed record', async () => {
		const { conv, messages } = await seed();
		const [plain] = messages.listByConversation(conv.id);
		const [trimmed] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
		const strip = (m: (typeof plain)['toolCalls']) =>
			m!.map((t) => ({
				...t,
				argsJson: null,
				resultJson: null
			}));
		expect(
			strip(trimmed.toolCalls).map((t) => ({
				...t,
				argsTruncated: undefined,
				argsBytes: undefined,
				resultTruncated: undefined,
				resultBytes: undefined
			}))
		).toEqual(
			strip(plain.toolCalls).map((t) => ({
				...t,
				argsTruncated: undefined,
				argsBytes: undefined,
				resultTruncated: undefined,
				resultBytes: undefined
			}))
		);
		expect(trimmed.toolCalls!.map((t) => t.id)).toEqual(plain.toolCalls!.map((t) => t.id));
		expect(trimmed.content).toBe(plain.content);
	});
});

describe('lazy field lookups', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-payload-trim-fetch-');
	});

	it('returns the full stored text for the owner', async () => {
		const { conv, user, bigArgs, bigResult, messages } = await seed();
		expect(messages.getToolCallFieldForOwner(conv.id, 'tc-big', user.id, 'args')?.value).toBe(
			bigArgs
		);
		expect(messages.getToolCallFieldForOwner(conv.id, 'tc-big', user.id, 'result')?.value).toBe(
			bigResult
		);
	});

	it('denies a different user, an unknown id, and a foreign conversation alike', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const { conv, messages } = await seed();
		const other = users.upsertGithub({
			githubLogin: 'intruder',
			githubId: 4242,
			displayName: null,
			avatarUrl: null
		});
		expect(messages.getToolCallFieldForOwner(conv.id, 'tc-big', other.id, 'args')).toBeNull();
		expect(messages.getToolCallFieldForOwner(conv.id, 'nope', conv.userId, 'args')).toBeNull();
		expect(
			messages.getToolCallFieldForOwner('other-conversation', 'tc-big', conv.userId, 'args')
		).toBeNull();
	});

	it('resolves a file edit diff by id, scoped to the conversation owner', async () => {
		const { conv, messages } = await seed();
		const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
		const bigEdit = m.fileEdits!.find((e) => e.path === 'big.ts')!;
		expect(messages.getFileEditDiffForOwner(conv.id, bigEdit.id, conv.userId)?.value).toBe(
			'D'.repeat(INLINE_DIFF_MAX_BYTES + 100)
		);
		expect(messages.getFileEditDiffForOwner(conv.id, 'missing', conv.userId)).toBeNull();
	});
});
