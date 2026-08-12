import { test, expect } from './helpers/fixtures';
import { createConversation, uniqueTitle, waitForAssistantMessage } from './helpers/conversations';

// The sidebar's "active" indicator: a conversation is active when a turn is
// running for it or it carries a response the user hasn't seen. These specs
// cover the unseen half plus the read receipts that clear it, which is the part
// that spans the DB, the app-wide SSE feed, and the sidebar — the running half
// is covered by `tests/turn-runner.test.ts` (registry + published transitions).

const UNREAD = 'Unread response';

test('a background conversation flags an unseen response, and opening it clears the flag', async ({
	page,
	request
}) => {
	const viewed = await createConversation(request, uniqueTitle('E2E activity viewed'));
	const background = await createConversation(request, uniqueTitle('E2E activity background'));
	await page.goto(`/conversations/${viewed}`);

	const viewedRow = page.locator(`nav a[href="/conversations/${viewed}"]`);
	const backgroundRow = page.locator(`nav a[href="/conversations/${background}"]`);
	await expect(backgroundRow).not.toContainText(UNREAD);

	// Drive a turn in the conversation the user is NOT looking at.
	const res = await request.post(`/api/conversations/${background}/turns`, {
		data: { content: 'answer me in the background' }
	});
	expect(res.ok()).toBeTruthy();
	await waitForAssistantMessage(
		request,
		background,
		/Stubbed reply to: answer me in the background/
	);

	// The app-wide event feed flips the indicator without a navigation…
	await expect(backgroundRow).toContainText(UNREAD);
	// …and only for the conversation that actually got a response.
	await expect(viewedRow).not.toContainText(UNREAD);

	// Opening it is the read receipt.
	await backgroundRow.click();
	await expect(page).toHaveURL(new RegExp(`/conversations/${background}$`));
	await expect(backgroundRow).not.toContainText(UNREAD);

	// And the receipt is persisted, not just a client-side override: navigating
	// away must not bring the flag back.
	await page.goto(`/conversations/${viewed}`);
	await expect(backgroundRow).not.toContainText(UNREAD);
});

test('a reply that arrives while the user is watching is never flagged unseen', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E activity watched'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message…/);
	await composer.fill('reply while I watch');
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: reply while I watch/);

	const row = page.locator(`nav a[href="/conversations/${id}"]`);
	await expect(row).not.toContainText(UNREAD);

	// Leaving the conversation must not resurrect it: the client marks the turn
	// read on `done`, so the persisted watermark already covers the reply.
	await page.goto('/');
	await expect(row).not.toContainText(UNREAD);
});
