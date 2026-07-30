import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import type {
	InteractivePermissionDecision,
	PermissionPolicy,
	PortalEvent
} from '../src/lib/types';

// The "Approve all tool calls" toggle is conversation-scoped: it is stored on
// `conversations.approve_all_tools`, read back as `Conversation.approveAllTools`
// and seeded into the live session that backs the adapter's `getApproveAll()`.
// The settings dialog tells users the bypass applies to "this conversation
// only", so pin that claim down: enabling it through the same repo call the
// `/session` PATCH endpoint uses must not auto-approve anything in a sibling
// conversation of the same user, and must not write a permission grant. The
// remaining tests pin the caveats the same dialog makes — explicit deny grants
// and always-prompt tools survive it, while the user's default policy does not.

let convCounter = 0;

/**
 * Build an adapter over a real conversation row. `getApproveAll` reads the
 * stored flag back out of the DB on every call, mirroring what the live session
 * is seeded with (`turn-start.ts` passes `conv.approveAllTools` into
 * `copilot-provider.ts`). This pins the storage and enforcement halves of the
 * scoping claim — the row is per conversation and the adapter honours a
 * per-conversation source; it does not exercise the seeding hop itself.
 */
async function makeHarness(
	userId: string,
	opts: {
		behavior?: 'normal' | 'always-prompt' | 'never-prompt';
		policy?: PermissionPolicy;
	} = {}
) {
	const interactive = await import('../src/lib/server/runtime/interactive-requests');
	const { createInteractiveCallbacks } =
		await import('../src/lib/server/copilot/interactive-adapter');
	const settings = await import('../src/lib/server/db/repos/settings');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const conversationId = `conv-approve-all-scope-${convCounter++}`;
	convs.create(userId, {
		id: conversationId,
		title: 'approve-all scope test',
		workdir: '/tmp',
		model: 'gpt-4'
	});
	const events: PortalEvent[] = [];

	const readApproveAll = () => convs.get(conversationId, userId)?.approveAllTools === true;

	const { onPermissionRequest } = createInteractiveCallbacks({
		conversationId,
		userId,
		workingDirectory: '/tmp',
		getWorkspaceRoots: () => ['/tmp'],
		policy: opts.policy ?? 'prompt',
		emit: (ev) => events.push(ev),
		getApproveAll: readApproveAll,
		getMode: () => 'interactive',
		getSessionWorkspacePath: () => null,
		getPermissionBehavior: () => opts.behavior ?? 'normal'
	});

	return {
		interactive,
		settings,
		convs,
		conversationId,
		events,
		onPermissionRequest,
		readApproveAll
	};
}

/**
 * Drive a permission request through the adapter, wait for it to raise a human
 * prompt, then resolve that prompt with `decision`.
 */
async function driveAndResolve(
	harness: Awaited<ReturnType<typeof makeHarness>>,
	userId: string,
	req: Record<string, unknown>,
	decision: InteractivePermissionDecision
) {
	const resultPromise = harness.onPermissionRequest(req);

	let view: { requestId: string; [k: string]: unknown } | undefined;
	for (let i = 0; i < 200 && !view; i++) {
		const pending = harness.interactive.listForConversation(harness.conversationId);
		if (pending.length > 0) {
			view = pending[0] as { requestId: string };
			break;
		}
		await new Promise((r) => setTimeout(r, 1));
	}
	if (!view) throw new Error('no human prompt was raised');

	const ok = harness.interactive.resolve(view.requestId, userId, {
		kind: 'permission',
		decision
	});
	expect(ok).toBe(true);

	const result = await resultPromise;
	return { result, view };
}

const URL_REQUEST = () => ({
	kind: 'url',
	toolName: 'web_fetch',
	url: 'https://example.com/docs',
	args: { url: 'https://example.com/docs' }
});

describe('approve-all is scoped to a single conversation', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-approve-all-scope-test-');
	});

	it('auto-approves in the conversation it was enabled on, but still prompts in a sibling conversation', async () => {
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();

		const a = await makeHarness(user.id);
		const b = await makeHarness(user.id);
		const grantsBefore = a.settings.listGrantsForUser(user.id).length;

		// Baseline: with the flag off, conversation A prompts like any other.
		expect(a.readApproveAll()).toBe(false);
		const baseline = await driveAndResolve(a, user.id, URL_REQUEST(), 'allow-once');
		expect(baseline.result).toEqual({ kind: 'approve-once' });

		// Enable approve-all on A through the same repo call the `/session`
		// PATCH endpoint uses. B is untouched: the flag lives on A's row only.
		expect(
			a.convs.updateSessionSettings(a.conversationId, user.id, { approveAllTools: true })
		).toBe(true);
		expect(a.readApproveAll()).toBe(true);
		expect(b.readApproveAll()).toBe(false);

		// Conversation A: the same request now short-circuits with no human prompt.
		const resultA = await a.onPermissionRequest(URL_REQUEST());
		expect(resultA).toEqual({ kind: 'approve-once' });
		expect(a.interactive.listForConversation(a.conversationId)).toHaveLength(0);

		const decisionsA = a.settings
			.listRecentDecisionsForUser(user.id)
			.filter((d) => d.conversationId === a.conversationId);
		expect(decisionsA.some((d) => d.decision === 'auto-allow')).toBe(true);

		// Conversation B: the identical request still raises a human prompt.
		const { result: resultB, view } = await driveAndResolve(
			b,
			user.id,
			URL_REQUEST(),
			'allow-once'
		);
		expect(view).toMatchObject({ kind: 'permission' });
		expect(resultB).toEqual({ kind: 'approve-once' });

		// Enabling approve-all persisted nothing beyond A's own row: no
		// permission grant was written, so nothing leaked into the user's
		// account-wide grant list (which every conversation consults).
		const grantsAfter = a.settings.listGrantsForUser(user.id);
		expect(grantsAfter).toHaveLength(grantsBefore);
		expect(
			grantsAfter.filter(
				(g) => g.conversationId === a.conversationId || g.conversationId === b.conversationId
			)
		).toHaveLength(0);
	});

	it('does not override an explicit deny grant, so the dialog must not promise every call is approved', async () => {
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();

		const a = await makeHarness(user.id);
		a.settings.addGrant({
			userId: user.id,
			conversationId: null,
			tool: 'web_fetch',
			permissionKind: 'url',
			scope: { kind: 'url', rule: { kind: 'host', host: 'example.com' } },
			decision: 'deny',
			denyReason: 'Blocked by an explicit rule.'
		});
		expect(
			a.convs.updateSessionSettings(a.conversationId, user.id, { approveAllTools: true })
		).toBe(true);

		const result = await a.onPermissionRequest(URL_REQUEST());
		expect(result).toEqual({ kind: 'reject', feedback: 'Blocked by an explicit rule.' });
		// The deny came from the grant, not from a missing prompt path.
		expect(a.interactive.listForConversation(a.conversationId)).toHaveLength(0);
		expect(a.readApproveAll()).toBe(true);
	});

	it('does not silence always-prompt tools, so the dialog must not promise the agent never asks again', async () => {
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();

		// Portal tools such as `git_commit` and the worktree merges declare
		// `permissionBehavior: 'always-prompt'`, which the adapter evaluates
		// before the approve-all check.
		const a = await makeHarness(user.id, { behavior: 'always-prompt' });
		expect(
			a.convs.updateSessionSettings(a.conversationId, user.id, { approveAllTools: true })
		).toBe(true);

		const { result, view } = await driveAndResolve(a, user.id, URL_REQUEST(), 'allow-once');
		expect(view).toMatchObject({ kind: 'permission' });
		expect(result).toEqual({ kind: 'approve-once' });
	});

	it("overrides the user's deny-all default policy for its own conversation only", async () => {
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();

		// The dialog says the default permission policy is bypassed for this
		// conversation: approve-all is checked before `decideByPolicy`.
		const a = await makeHarness(user.id, { policy: 'deny-all' });
		const b = await makeHarness(user.id, { policy: 'deny-all' });
		expect(
			a.convs.updateSessionSettings(a.conversationId, user.id, { approveAllTools: true })
		).toBe(true);

		expect(await a.onPermissionRequest(URL_REQUEST())).toEqual({ kind: 'approve-once' });
		// The sibling conversation is still governed by the user-wide policy.
		expect(await b.onPermissionRequest(URL_REQUEST())).toMatchObject({ kind: 'reject' });
	});
});
