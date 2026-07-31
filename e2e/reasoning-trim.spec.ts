import { test, expect } from './helpers/fixtures';
import { createConversation, uniqueTitle, waitForAssistantMessage } from './helpers/conversations';

// The conversation-open payload trims oversized reasoning text (see
// `INLINE_REASONING_MAX_BYTES`): a reasoning block renders collapsed unless it
// is actively streaming, so its text is shipped for content nobody looks at.
// This covers the whole round trip on a reloaded conversation — the collapsed
// row must look exactly like an untrimmed one, and expanding it must fetch and
// render the real text.
test('trimmed reasoning text is absent on open and hydrates when expanded', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E reasoning-trim'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('think hard @trigger-long-reasoning please');
	await composer.press('Enter');
	await waitForAssistantMessage(
		request,
		id,
		'Stubbed reply to: think hard @trigger-long-reasoning please'
	);

	// Reload so the block comes from the (trimmed) page payload rather than the
	// live stream, which always carries its text.
	await page.reload();

	// The server-rendered page must not carry the reasoning text at all.
	const html = await page.content();
	expect(html).not.toContain('pondering the payload trim');

	// The collapsed row is identical to an untrimmed one: "Thought for Ns",
	// drawn from durationMs, which is never trimmed.
	const block = page.locator('.reasoning').first();
	const header = block.getByRole('button', { expanded: false });
	await expect(header).toContainText(/Thought for \d+s/);

	// Expanding fetches the real text and renders it.
	await header.click();
	await expect(block.locator('pre')).toContainText('pondering the payload trim');

	// And it is served by the lazy-field endpoint, not smuggled into the payload.
	const conversation = (await request.get(`/api/conversations/${id}`).then((r) => r.json())) as {
		messages: { reasoningBlocks?: { id: string; text: string }[] }[];
	};
	const blockId = conversation.messages.flatMap((m) => m.reasoningBlocks ?? [])[0]?.id;
	expect(blockId).toBeTruthy();
	const res = await request.get(`/api/conversations/${id}/fields/reasoning-text/${blockId}`);
	expect(res.ok()).toBeTruthy();
	expect(await res.text()).toContain('pondering the payload trim');
});
