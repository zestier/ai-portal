import { test, expect, type Page } from './helpers/fixtures';
import { randomUUID } from 'node:crypto';
import { createConversation, uniqueTitle, waitForAssistantMessage } from './helpers/conversations';

// Retry / inline-edit / regenerate flows are gated behind native
// `window.confirm` dialogs (a deliberate footgun guard for destructive
// re-runs). Accept them automatically so the specs can drive the flows.
function acceptDialogs(page: Page) {
	page.on('dialog', (d) => void d.accept());
}

// The empty-first-reply regression: a turn whose stream produces no content
// (no text, no tools, no reasoning) must never be persisted as a silent empty
// `complete` — the "dead empty bubble that survives refresh" artifact. The
// stub's `@trigger-empty` directive (one-shot per prompt) makes the first
// reply empty so the empty-turn handling is e2e-assertable; a Retry of the
// same prompt then replies normally, proving the recovery affordance works.
test('an empty first reply surfaces a visible error, not a dead empty bubble', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E empty reply'));
	await page.goto(`/conversations/${id}`);
	const prompt = `@trigger-empty ${randomUUID().slice(0, 8)}`;

	const composer = page.getByPlaceholder(/Message…/);
	await composer.fill(prompt);
	await composer.press('Enter');

	// The live stream surfaces the failure as a visible system message…
	await expect(page.getByText(/Error: The model returned an empty response/)).toBeVisible();
	// …and exactly ONE assistant bubble exists, marked (error) — never a
	// silent empty bubble.
	const bubble = page.locator('article.msg[data-role="assistant"]');
	await expect(bubble).toHaveCount(1);
	await expect(bubble.locator('.status')).toContainText('error');
	// The errored bubble carries the Retry affordance.
	await expect(bubble.getByRole('button', { name: 'Regenerate this response' })).toBeVisible();

	// Reload: the persisted artifact is an errored message (status error,
	// errorCode empty_response) — a refresh shows the same error, not a
	// dead empty bubble.
	await page.reload();
	const reloaded = page.locator('article.msg[data-role="assistant"]');
	await expect(reloaded).toHaveCount(1);
	await expect(reloaded.locator('.status')).toContainText('error');
	await expect(reloaded.getByRole('button', { name: 'Regenerate this response' })).toBeVisible();

	// Retry re-runs from the same prompt; the stub's one-shot empty gate now
	// replies normally, so the errored bubble is replaced in place by a real
	// answer and no error artifact remains.
	acceptDialogs(page);
	await reloaded.getByRole('button', { name: 'Regenerate this response' }).click();
	await waitForAssistantMessage(request, id, new RegExp(`Stubbed reply to: ${prompt}`));
	await expect(page.getByText(`Stubbed reply to: ${prompt}`)).toBeVisible();
	await expect(page.locator('article.msg[data-role="assistant"] .status')).toHaveCount(0);
	await expect(page.getByText(/Error: The model returned an empty response/)).toHaveCount(0);
});

test('retry regenerates the reply in place without ghost duplicates', async ({ page, request }) => {
	const id = await createConversation(request, uniqueTitle('E2E retry'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message…/);
	await composer.fill('retry me @trigger-slow-start');
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: retry me @trigger-slow-start/);
	await expect(page.locator('article.msg[data-role="assistant"]')).toHaveCount(1);

	acceptDialogs(page);
	await page
		.locator('article.msg[data-role="assistant"]')
		.getByRole('button', { name: 'Regenerate this response' })
		.click();

	// The old bubble is discarded and a fresh turn streams in its place — the
	// slow-start directive keeps it streamable long enough to assert on.
	await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
	await expect(page.locator('article.msg[data-role="assistant"]')).toHaveCount(1);

	await waitForAssistantMessage(request, id, /Stubbed reply to: retry me @trigger-slow-start/);
	await expect(
		page.getByText('Stubbed reply to: retry me @trigger-slow-start').first()
	).toBeVisible();
	await expect(page.locator('article.msg[data-role="assistant"]')).toHaveCount(1);
	await expect(page.locator('article.msg[data-role="user"]')).toHaveCount(1);
});

test('inline edit re-runs in place from the edited prompt', async ({ page, request }) => {
	const id = await createConversation(request, uniqueTitle('E2E inline edit'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message…/);
	await composer.fill('first prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: first prompt/);

	acceptDialogs(page);
	await page
		.locator('article.msg[data-role="user"]')
		.getByRole('button', { name: 'Edit message' })
		.click();
	const textarea = page.locator('textarea[aria-label="Edited message"]');
	await textarea.fill('edited prompt');
	await page.getByRole('button', { name: 'Edit inline & re-run' }).click();

	await waitForAssistantMessage(request, id, /Stubbed reply to: edited prompt/);
	await expect(page.getByText('edited prompt', { exact: true })).toHaveCount(1);
	await expect(page.getByText('Stubbed reply to: edited prompt')).toBeVisible();
	// No trace of the old prompt or its reply remains.
	await expect(page.getByText('first prompt', { exact: true })).toHaveCount(0);
	await expect(page.locator('article.msg[data-role="assistant"]')).toHaveCount(1);
});

test('a reload mid-stream reattaches and the reply still lands', async ({ page, request }) => {
	const id = await createConversation(request, uniqueTitle('E2E reload'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message…/);
	await composer.fill('reload me @trigger-slow-start');
	await composer.press('Enter');

	// Streaming has begun but the slow-start hold means the first delta hasn't
	// landed yet — a genuine mid-stream reload.
	await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
	await page.reload();

	// The turn reattaches (or the already-persisted reply renders) and the
	// reply lands exactly once — no duplicate user message or ghost turn.
	await waitForAssistantMessage(request, id, /Stubbed reply to: reload me @trigger-slow-start/);
	await expect(
		page.getByText('reload me @trigger-slow-start', { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText('Stubbed reply to: reload me @trigger-slow-start')).toBeVisible();
	await expect(page.locator('article.msg[data-role="user"]')).toHaveCount(1);
	await expect(page.locator('article.msg[data-role="assistant"]')).toHaveCount(1);
});

test('a second consecutive turn renders after the first completes', async ({ page, request }) => {
	const id = await createConversation(request, uniqueTitle('E2E consecutive'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message…/);
	await composer.fill('turn one');
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: turn one/);

	await composer.fill('turn two');
	await composer.press('Enter');
	await waitForAssistantMessage(request, id, /Stubbed reply to: turn two/);

	await expect(page.getByText('Stubbed reply to: turn one')).toBeVisible();
	await expect(page.getByText('Stubbed reply to: turn two')).toBeVisible();
	await expect(page.locator('article.msg[data-role="assistant"]')).toHaveCount(2);
});
