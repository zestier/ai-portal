import { test, expect } from './helpers/fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The server runs with cwd=DATA_DIR, so PROJECT_ROOT is e2e/.tmp-data — a
// repository created inside it is a legal worktree source path.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp-data');

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const repo = mkdtempSync(join(workspaceRoot, 'default-tpl-src-'));
	git(repo, ['init', '-q', '-b', 'main']);
	git(repo, ['config', 'user.name', 'E2E']);
	git(repo, ['config', 'user.email', 'e2e@localhost']);
	git(repo, ['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(repo, 'README.md'), 'base\n');
	git(repo, ['add', 'README.md']);
	git(repo, ['commit', '-q', '-m', 'initial']);
	return repo;
}

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

test('bulk deletion confirms and retries worktrees holding work', async ({ page }) => {
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
		'1 worktree has uncommitted or unmerged work. Delete it anyway?'
	]);
	expect(deleteUrls[0]).not.toContain('forceWorktree=1');
	expect(deleteUrls[1]).toContain('forceWorktree=1');
});

// The unmerged guard is a second, independent reason the endpoint can 409, and
// the client must force-retry it exactly like the dirty case rather than
// treating it as an ordinary failure.
test('bulk deletion retries worktrees blocked for unmerged commits', async ({ page }) => {
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
			body: JSON.stringify({
				code: 'worktree_unmerged',
				message: 'unmerged commits',
				detail: { ahead: 2 }
			})
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

	expect(deleteUrls[1]).toContain('forceWorktree=1');
});

test('health endpoint is public', async ({ request }) => {
	const res = await request.get('/api/health');
	expect(res.status()).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true });
});

// R1: a per-user default chat template makes the New chat buttons launch it
// through the full machinery — a draft template pre-fills the composer, and
// the New worktree chat button forces a managed worktree regardless of the
// template's workspace mode.
test('a default chat template drives the New chat buttons', async ({ page, request }) => {
	// A committed repo so "New worktree chat" has a git source to check out.
	const repo = committedRepository();

	// A draft chat template to act as the default.
	const tplRes = await request.post('/api/prompt-templates', {
		data: {
			type: 'chat',
			title: 'Default draft',
			prompt: 'The default prompt body.',
			launchBehavior: 'draft'
		}
	});
	expect(tplRes.ok()).toBeTruthy();
	const { template } = await tplRes.json();

	// Point this test user's default workdir at the repo (so a worktree launch
	// has a git source) and set the default template via the real form actions.
	const saveRes = await request.post('/settings?/save', {
		form: {
			defaultModel: '',
			defaultWorkdir: repo,
			defaultConversationMode: 'interactive',
			defaultApprovalMode: 'ask',
			defaultPolicy: 'prompt',
			theme: 'system',
			accent: 'default'
		}
	});
	expect(saveRes.ok()).toBeTruthy();
	const defRes = await request.post('/settings?/saveDefaultPromptTemplate', {
		form: { defaultPromptTemplateId: template.id }
	});
	expect(defRes.ok()).toBeTruthy();

	// "New shared chat" launches the default template: draft URL + a composer
	// pre-filled with the template prompt.
	await page.goto('/');
	await page.getByRole('button', { name: 'New shared chat' }).first().click();
	await page.waitForURL(
		/\/conversations\/[A-Z0-9]+\?promptTemplateSource=custom&promptTemplateId=/
	);
	await expect(page.getByPlaceholder(/Message…/)).toHaveValue('The default prompt body.');

	// "New worktree chat" forces a managed worktree for the same template.
	const sharedPath = new URL(page.url()).pathname;
	await page.goto('/');
	await page.getByRole('button', { name: 'New worktree chat' }).first().click();
	await page.waitForURL(
		/\/conversations\/[A-Z0-9]+\?promptTemplateSource=custom&promptTemplateId=/
	);
	const worktreePath = new URL(page.url()).pathname;
	expect(worktreePath).not.toBe(sharedPath);
	const worktreeConvId = worktreePath.split('/').filter(Boolean).pop()!;
	const convBody = await (await request.get(`/api/conversations/${worktreeConvId}`)).json();
	expect(convBody.conversation.workspaceKind).toBe('managed-worktree');
});
