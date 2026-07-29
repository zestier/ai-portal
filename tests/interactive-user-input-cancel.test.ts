import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

// When a user-input prompt is cancelled (turn abort, timeout, client
// disconnect, eviction) the adapter must NOT hand the model an empty answer.
// The SDK's user-input handler has no `user-not-available` sentinel, so the
// only way to signal "no input available" is to let the cancellation error
// propagate — otherwise the model proceeds on phantom empty input.

let convCounter = 0;

async function makeHarness() {
	const interactive = await import('../src/lib/server/runtime/interactive-requests');
	const { createInteractiveCallbacks } =
		await import('../src/lib/server/copilot/interactive-adapter');
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const user = ensureLocalUser();
	const conversationId = `conv-input-${convCounter++}`;
	convs.create(user.id, {
		id: conversationId,
		title: 'input cancel test',
		workdir: '/tmp',
		model: 'gpt-4'
	});

	const { onUserInputRequest } = createInteractiveCallbacks({
		conversationId,
		userId: user.id,
		workingDirectory: '/tmp',
		getWorkspaceRoots: () => ['/tmp'],
		policy: 'prompt',
		emit: () => {},
		getApproveAll: () => false,
		getMode: () => 'interactive',
		getSessionWorkspacePath: () => null,
		getPermissionBehavior: () => 'normal'
	});

	return { interactive, user, conversationId, onUserInputRequest };
}

async function pendingRequestId(harness: Awaited<ReturnType<typeof makeHarness>>) {
	for (let i = 0; i < 200; i++) {
		const pending = harness.interactive.listForConversation(harness.conversationId);
		if (pending.length > 0) return pending[0].requestId;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error('no human prompt was raised');
}

describe('onUserInputRequest abort semantics', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-input-cancel-test-');
	});

	it('rethrows on cancellation instead of feeding an empty answer', async () => {
		const harness = await makeHarness();
		const resultPromise = harness.onUserInputRequest({ question: 'pick a file' });
		const requestId = await pendingRequestId(harness);
		harness.interactive.cancel(requestId, 'turn_aborted');
		await expect(resultPromise).rejects.toMatchObject({ name: 'InteractivePromptCancelledError' });
	});

	it('returns the answer when the user actually responds', async () => {
		const harness = await makeHarness();
		const resultPromise = harness.onUserInputRequest({ question: 'pick a file' });
		const requestId = await pendingRequestId(harness);
		harness.interactive.resolve(requestId, harness.user.id, {
			kind: 'user_input',
			answer: 'README.md',
			wasFreeform: true
		});
		await expect(resultPromise).resolves.toEqual({ answer: 'README.md', wasFreeform: true });
	});
});
