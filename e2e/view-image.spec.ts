import { test, expect } from './helpers/fixtures';
import { createConversation, uniqueTitle, waitForAssistantMessage } from './helpers/conversations';

interface ToolCallJson {
	tool: string;
	attachments?: { id: string; mimeType: string; byteSize: number }[];
}
interface MessageJson {
	role: string;
	toolCalls?: ToolCallJson[];
}

// End-to-end coverage for the `view`-tool image attachment feature. The stub
// bridge's `@trigger-view-image` flow writes a PNG, fires an (auto-allowed,
// in-workspace) read permission so the adapter captures the bytes, then runs
// the native `view` tool so the attachment is flushed and rendered. We assert
// the attachment persisted, its bytes serve over the authed endpoint, and the
// image renders in the resolved tool-call card.
test('an image viewed via the view tool is captured, served, and rendered inline', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E view-image'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('show me @trigger-view-image now');
	await composer.press('Enter');

	await waitForAssistantMessage(request, id, 'Stubbed reply to: show me @trigger-view-image now');

	// Backend: the view tool call carries a persisted image attachment.
	const body = (await request.get(`/api/conversations/${id}`).then((r) => r.json())) as {
		messages: MessageJson[];
	};
	const viewCall = body.messages
		.flatMap((m) => m.toolCalls ?? [])
		.find((t) => t.tool === 'view' && (t.attachments?.length ?? 0) > 0);
	expect(viewCall, 'a view tool call with an attachment should be persisted').toBeTruthy();
	expect(viewCall!.attachments![0].mimeType).toBe('image/png');
	expect(viewCall!.attachments![0].byteSize).toBeGreaterThan(0);

	// UI: the image renders in the resolved tool-call card.
	const viewCard = page.locator('details.tool', { hasText: 'view' }).first();
	await expect(viewCard).toBeVisible();
	// The card's own summary is its first descendant summary (nested <details>
	// for Arguments / Raw output have their own); open the card to reveal it.
	await viewCard.locator('summary').first().click();
	const img = viewCard.locator('img[src*="/attachments/"]');
	await expect(img).toBeVisible();

	// Standardized image sizing: the rule that prevents overflow/distortion is
	// applied to tool-result images — width-clamped, aspect preserved, and tall
	// images height-capped (see ResultBlock `.image`). Asserting the computed
	// rule is robust regardless of the (tiny) stub fixture's intrinsic size.
	const sizing = await img.evaluate((el) => {
		const cs = getComputedStyle(el);
		return {
			objectFit: cs.objectFit,
			maxWidth: cs.maxWidth,
			maxHeight: cs.maxHeight
		};
	});
	expect(sizing.objectFit).toBe('contain');
	expect(sizing.maxWidth).toBe('100%');
	expect(sizing.maxHeight).not.toBe('none');

	// The src serves real PNG bytes over the authed endpoint.
	const src = await img.getAttribute('src');
	expect(src).toBeTruthy();
	const res = await request.get(src!);
	expect(res.ok()).toBeTruthy();
	expect(res.headers()['content-type']).toContain('image/png');
	expect((await res.body()).length).toBeGreaterThan(0);

	// Click-to-zoom: the tool image is wrapped in a focusable button trigger that
	// opens the shared full-size lightbox; Escape dismisses it (Modal owns Esc).
	await expect(viewCard.locator('button.image-zoom')).toBeVisible();
	await img.click();
	const lightbox = page.locator('dialog[open] .frame img');
	await expect(lightbox).toBeVisible();
	await expect(lightbox).toHaveAttribute('src', src!);
	await page.keyboard.press('Escape');
	await expect(lightbox).toBeHidden();

	// The attachment rehydrates from SQLite after a full reload.
	await page.reload();
	const viewCardAfter = page.locator('details.tool', { hasText: 'view' }).first();
	await viewCardAfter.locator('summary').first().click();
	await expect(viewCardAfter.locator('img[src*="/attachments/"]')).toBeVisible();
});

// The realistic case: the SDK auto-allows the in-workspace read WITHOUT
// invoking our permission callback, so nothing is buffered at permission time.
// The image must still render, captured directly at execution_start.
test('an auto-allowed image view (no permission prompt) still renders inline', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E view-image-auto'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('look @trigger-view-image-autoallow please');
	await composer.press('Enter');

	await waitForAssistantMessage(
		request,
		id,
		'Stubbed reply to: look @trigger-view-image-autoallow please'
	);

	// Backend: attachment persisted even though no read permission ever fired.
	const body = (await request.get(`/api/conversations/${id}`).then((r) => r.json())) as {
		messages: MessageJson[];
	};
	const viewCall = body.messages
		.flatMap((m) => m.toolCalls ?? [])
		.find((t) => t.tool === 'view' && (t.attachments?.length ?? 0) > 0);
	expect(viewCall, 'direct capture should persist an attachment').toBeTruthy();
	expect(viewCall!.attachments![0].mimeType).toBe('image/png');

	// UI renders it inline.
	const viewCard = page.locator('details.tool', { hasText: 'view' }).first();
	await viewCard.locator('summary').first().click();
	await expect(viewCard.locator('img[src*="/attachments/"]')).toBeVisible();
});
