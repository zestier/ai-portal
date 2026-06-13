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
