import { test, expect } from './helpers/fixtures';
import { createConversation, uniqueTitle, getConversation } from './helpers/conversations';

test('assistant reply text streams incrementally while the turn is still running', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E realtime stream'));
	await page.goto(`/conversations/${id}`);

	// Long prompt → long stubbed reply → many 16-char chunks at 120 ms each,
	// so the mid-stream window is wide enough to observe reliably.
	const prompt =
		'@trigger-slow-stream ' +
		'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
		'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud ' +
		'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute ' +
		'irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla.';
	const composer = page.getByPlaceholder(/Message…/);
	await composer.fill(prompt);
	await composer.press('Enter');

	const bubble = page.locator('article.msg[data-role="assistant"]').last();

	// A partial token renders in the bubble while the turn is still in flight.
	await expect(bubble).toContainText('Stubbed reply to', { timeout: 8000 });
	const partial = (await bubble.innerText()).trim();

	// The turn must still be running at this point (we caught it mid-stream).
	const bodyAtPartial = await getConversation(request, id);
	expect(bodyAtPartial.activeTurnId).not.toBeNull();

	// The bubble text must grow from the partial before the turn finishes.
	let observedGrowthMidStream = false;
	await expect
		.poll(
			async () => {
				const body = await getConversation(request, id);
				const text = (await bubble.innerText()).trim();
				// Record growth observed while the server still has the turn running.
				if (text.length > partial.length && body.activeTurnId !== null) {
					observedGrowthMidStream = true;
				}
				return text.length;
			},
			{ timeout: 15000 }
		)
		.toBeGreaterThan(partial.length);

	expect(observedGrowthMidStream).toBe(true);
});
