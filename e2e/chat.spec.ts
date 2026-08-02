import { test, expect } from './helpers/fixtures';
import { createConversation, uniqueTitle, waitForAssistantMessage } from './helpers/conversations';

test('streamed assistant reply (stubbed) appears and persists across reloads', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E chat'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('hello world');
	await composer.press('Enter');

	await waitForAssistantMessage(request, id, 'Stubbed reply to: hello world');
	await expect(page.getByText('Stubbed reply to: hello world').first()).toBeVisible();

	// Reload and confirm both the user message and the assistant reply were
	// persisted (proves the turn-runner wrote them to SQLite).
	await page.reload();
	await expect(page.getByText('hello world', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Stubbed reply to: hello world').first()).toBeVisible();
});

test('a worktree fork failure is visible on the assistant message', async ({ page, request }) => {
	const id = await createConversation(request, uniqueTitle('E2E worktree fork failure'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.fill('fork this reply');
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: fork this reply/);
	await page.reload();

	await page.route(`**/api/conversations/${id}/messages/*/fork`, async (route) => {
		await route.fulfill({
			status: 409,
			contentType: 'application/json',
			body: JSON.stringify({ code: 'no_snapshot', message: 'snapshot unavailable' })
		});
	});
	const assistantBubble = page
		.locator('article.msg[data-role="assistant"]')
		.filter({ hasText: 'Stubbed reply to: fork this reply' });
	await assistantBubble
		.getByRole('button', { name: 'Continue from here in an isolated worktree' })
		.click();

	await expect(assistantBubble.getByRole('alert')).toContainText('snapshot unavailable');
});

test('thinking indicator renders inside the assistant turn bubble', async ({ page, request }) => {
	const id = await createConversation(request, uniqueTitle('E2E thinking'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	// @trigger-slow-start makes the stub hold before its first delta, so the
	// assistant turn sits in the "thinking" state long enough to assert on.
	await composer.fill('@trigger-slow-start please');
	await composer.press('Enter');

	// The dots must live inside an assistant turn bubble, not as a detached
	// element below the message list (the bug this guards against).
	const thinkingInBubble = page.locator(
		'article.msg[data-role="assistant"] [role="status"]:has-text("Thinking")'
	);
	await expect(thinkingInBubble).toBeVisible();

	// And it disappears once the reply streams in.
	await waitForAssistantMessage(request, id, /Stubbed reply to: @trigger-slow-start/);
	await expect(thinkingInBubble).toBeHidden();
});

test('rejects empty messages on the server', async ({ request }) => {
	const id = await createConversation(request, uniqueTitle('E2E chat'));
	const res = await request.post(`/api/conversations/${id}/turns`, {
		data: { content: '' }
	});
	expect(res.ok()).toBeFalsy();
});

test('a failed turn start rolls back its optimistic user bubble (no ghost duplicate)', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E send fail'));
	await page.goto(`/conversations/${id}`);

	// Fail only the first POST /turns; let the retry through to the stub so we
	// can prove the optimistic bubble was removed (no duplicate after retry).
	let failedOnce = false;
	await page.route(`**/api/conversations/${id}/turns`, async (route) => {
		if (route.request().method() === 'POST' && !failedOnce) {
			failedOnce = true;
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'simulated start failure' })
			});
			return;
		}
		await route.continue();
	});

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('ghost message');
	await composer.press('Enter');

	// The failure surfaces as an error system message, the optimistic
	// `local-` user bubble is removed, and the draft is restored for retry.
	await expect(page.getByText('Error: simulated start failure')).toBeVisible();
	await expect(page.getByText('ghost message', { exact: true })).toHaveCount(0);
	await expect(composer).toHaveValue('ghost message');

	// Retrying now succeeds. Exactly one persisted user bubble must appear —
	// the rolled-back optimistic one must not linger as a second copy.
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: ghost message/);
	await expect(page.getByText('ghost message', { exact: true })).toHaveCount(1);
});

test('a failed turn start does not corrupt the previous assistant reply', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E fail prior'));
	await page.goto(`/conversations/${id}`);

	// First send succeeds and yields a completed assistant reply.
	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('first message');
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: first message/);
	const assistantBubble = page
		.locator('article.msg[data-role="assistant"]')
		.filter({ hasText: 'Stubbed reply to: first message' });
	await expect(assistantBubble).toBeVisible();

	// The next POST /turns fails. Rolling back the optimistic bubble must not
	// leave the *previous* assistant reply marked as errored.
	await page.route(`**/api/conversations/${id}/turns`, async (route) => {
		if (route.request().method() === 'POST') {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'second start failed' })
			});
			return;
		}
		await route.continue();
	});
	await composer.fill('second message');
	await composer.press('Enter');

	await expect(page.getByText('Error: second start failed')).toBeVisible();
	// The optimistic bubble is gone and the earlier assistant reply is intact:
	// a `complete` message renders no `(status)` marker, so the prior reply
	// must not have been flipped into an `(error)` state by the rollback.
	await expect(page.getByText('second message', { exact: true })).toHaveCount(0);
	await expect(assistantBubble).toBeVisible();
	await expect(assistantBubble.locator('.status')).toHaveCount(0);
});

test('an armed follow-up auto-sends after the active turn finishes', async ({ page, request }) => {
	const id = await createConversation(request, uniqueTitle('E2E arm'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	// @trigger-slow-start holds the stub before its first delta, giving us a
	// window to arm a follow-up while the first turn is still streaming.
	await composer.fill('first @trigger-slow-start');
	await composer.press('Enter');

	// Streaming has begun: Stop is the primary control and Send is still here.
	await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();

	// Arm a follow-up. Pressing Enter mid-turn must NOT start a turn now; it
	// arms the buffer and switches the Send control to its armed state.
	await composer.fill('second follow-up message');
	await composer.press('Enter');

	await expect(
		page.getByRole('button', { name: 'Send when current response finishes' })
	).toBeVisible();
	// Armed buffer is retained (not cleared, not sent yet).
	await expect(composer).toHaveValue('second follow-up message');

	// First reply streams in...
	await waitForAssistantMessage(request, id, /Stubbed reply to: first @trigger-slow-start/);
	// ...and the armed follow-up is then auto-sent as a brand new turn.
	await waitForAssistantMessage(request, id, /Stubbed reply to: second follow-up message/);
	await expect(page.getByText('second follow-up message', { exact: true }).first()).toBeVisible();

	// Composer cleared and disarmed once the flush turn started.
	await expect(composer).toHaveValue('');
	await expect(
		page.getByRole('button', { name: 'Send when current response finishes' })
	).toHaveCount(0);
});

test('the approval-mode dropdown gates auto-approve behind a conversation-scoped confirmation', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E approval-mode'));
	await page.goto(`/conversations/${id}`);

	// Expand the conversation-settings panel that hosts the dropdown.
	await page.locator('[aria-controls="chat-header-details"]').click();

	const select = page.getByRole('combobox', { name: 'Approval mode' });
	await expect(select).toHaveValue('ask');

	// Selecting auto-approve only opens a confirmation that spells out the
	// blast radius — this conversation only; the select must snap back until
	// the user confirms.
	await select.selectOption('auto-approve');
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('this conversation only');
	// The bypass is conversation-scoped, so the copy must not claim otherwise.
	await expect(dialog).not.toContainText('all of your conversations');
	await expect(dialog).not.toContainText('your user account');
	await expect(select).toHaveValue('ask');

	// Cancel: nothing changes.
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await expect(select).toHaveValue('ask');

	// Confirm: the bypass is applied to this conversation and the select reflects it.
	await select.selectOption('auto-approve');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Enable for this conversation' }).click();
	await expect(dialog).toBeHidden();
	await expect(select).toHaveValue('auto-approve');

	// auto-deny is the portable option and needs no confirmation: it only ever
	// withholds permission, so switching to it (and back) is not destructive.
	await select.selectOption('auto-deny');
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(select).toHaveValue('auto-deny');

	// Restore a clean state for the rest of the shared suite.
	await select.selectOption('ask');
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(select).toHaveValue('ask');
});
