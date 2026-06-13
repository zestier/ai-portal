import { test, expect } from './helpers/fixtures';
import { uniqueTitle } from './helpers/conversations';

test('conversation CRUD via API matches sidebar state', async ({ page, request }) => {
	const alpha = uniqueTitle('Alpha');
	const beta = uniqueTitle('Beta');
	const alphaRenamed = uniqueTitle('Alpha renamed');
	const a = await request
		.post('/api/conversations', { data: { title: alpha } })
		.then((r) => r.json());
	const b = await request
		.post('/api/conversations', { data: { title: beta } })
		.then((r) => r.json());

	await page.goto('/');
	const sidebar = page.getByRole('navigation', { name: /Conversations/ });
	await expect(sidebar.getByText(alpha)).toBeVisible();
	await expect(sidebar.getByText(beta)).toBeVisible();

	const renameRes = await request.patch(`/api/conversations/${a.conversation.id}`, {
		data: { title: alphaRenamed }
	});
	expect(renameRes.ok()).toBeTruthy();
	await page.reload();
	await expect(sidebar.getByText(alphaRenamed)).toBeVisible();

	const archiveRes = await request.patch(`/api/conversations/${b.conversation.id}`, {
		data: { archived: true }
	});
	expect(archiveRes.ok()).toBeTruthy();
	await page.reload();
	await expect(sidebar.getByText(beta)).not.toBeVisible();
	await sidebar.getByRole('button', { name: /Archived/ }).click();
	await expect(sidebar.getByText(beta)).toBeVisible();

	const delRes = await request.delete(`/api/conversations/${a.conversation.id}`);
	expect(delRes.ok()).toBeTruthy();
	await page.reload();
	await expect(sidebar.getByText(alphaRenamed)).not.toBeVisible();

	const getRes = await request.get(`/api/conversations/${a.conversation.id}`);
	expect(getRes.status()).toBe(404);
});

test('rename via sidebar UI', async ({ page, request }) => {
	const title = uniqueTitle('Rename me');
	const renamed = uniqueTitle('Renamed via UI');
	const created = await request
		.post('/api/conversations', { data: { title } })
		.then((r) => r.json());

	await page.goto('/');
	const sidebar = page.getByRole('navigation', { name: /Conversations/ });
	const row = sidebar.locator('.conv', { hasText: title });
	await row.getByRole('button', { name: `Actions for ${title}` }).click();
	await page.getByRole('button', { name: 'Rename', exact: true }).click();

	// Once the menu's Rename is clicked the title text is replaced by an
	// <input>, so locate the input on the sidebar rather than re-filtering
	// the row by its (now-gone) text.
	const input = sidebar.locator('input.rename-input');
	await expect(input).toBeVisible();
	await input.fill(renamed);
	await input.press('Enter');

	await expect(sidebar.getByText(renamed)).toBeVisible();

	const get = await request.get(`/api/conversations/${created.conversation.id}`);
	expect((await get.json()).conversation.title).toBe(renamed);
});
