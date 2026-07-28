import { test, expect } from '@playwright/test';

test('home page renders and creates a new conversation', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: "Zestier's AI Portal" })).toBeVisible();

	const newChat = page.getByRole('button', { name: 'New shared chat' }).first();
	await expect(newChat).toBeEnabled();
	await newChat.click();

	await page.waitForURL(/\/conversations\/[A-Z0-9]+/);
	await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
});

test('worktree creation surfaces the server error message', async ({ page }) => {
	await page.route('**/api/conversations', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		await route.fulfill({
			status: 400,
			contentType: 'application/json',
			body: JSON.stringify({
				code: 'not_git_repository',
				message: 'source is not a git repository'
			})
		});
	});
	await page.goto('/');

	await page.getByRole('button', { name: 'New worktree chat' }).first().click();

	await expect(page.getByRole('alert')).toContainText(
		'Could not create chat: source is not a git repository'
	);
});

test('bulk deletion confirms and retries dirty worktrees', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('button', { name: 'New shared chat' }).first().click();
	await page.waitForURL(/\/conversations\/[A-Z0-9]+/);
	const conversationPath = new URL(page.url()).pathname;

	const deleteUrls: string[] = [];
	await page.route('**/api/conversations/*', async (route) => {
		if (route.request().method() !== 'DELETE') return route.continue();
		deleteUrls.push(route.request().url());
		if (route.request().url().includes('forceWorktree=1')) {
			return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
		}
		return route.fulfill({
			status: 409,
			contentType: 'application/json',
			body: JSON.stringify({ code: 'worktree_dirty', message: 'uncommitted changes' })
		});
	});
	const dialogs: string[] = [];
	page.on('dialog', async (dialog) => {
		dialogs.push(dialog.message());
		await dialog.accept();
	});

	await page.getByRole('button', { name: 'Select' }).click();
	await page
		.locator(`.conv:has(a[href="${conversationPath}"])`)
		.getByRole('checkbox', { name: 'Select New chat' })
		.check();
	await page
		.getByRole('toolbar', { name: 'Bulk actions' })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect.poll(() => deleteUrls.length).toBe(2);

	expect(dialogs).toEqual([
		'Delete 1 conversation? This cannot be undone.',
		'1 worktree has uncommitted changes. Delete it anyway?'
	]);
	expect(deleteUrls[0]).not.toContain('forceWorktree=1');
	expect(deleteUrls[1]).toContain('forceWorktree=1');
});

test('health endpoint is public', async ({ request }) => {
	const res = await request.get('/api/health');
	expect(res.status()).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true });
});
