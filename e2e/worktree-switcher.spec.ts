import { test, expect } from './helpers/fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniqueTitle } from './helpers/conversations';

// See worktree.spec.ts: the server's PROJECT_ROOT is this directory, so a repo
// created inside it is a legal `sourcePath`.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp-data');

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sourceRepository(): string {
	const repo = mkdtempSync(join(workspaceRoot, 'lease-src-'));
	git(repo, ['init', '-q', '-b', 'main']);
	git(repo, ['config', 'user.name', 'E2E']);
	git(repo, ['config', 'user.email', 'e2e@localhost']);
	git(repo, ['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(repo, 'README.md'), 'base\n');
	git(repo, ['add', 'README.md']);
	git(repo, ['commit', '-q', '-m', 'initial']);
	return repo;
}

test('the workspace switcher browses a lease without disturbing the main workspace', async ({
	page,
	request
}) => {
	const repo = sourceRepository();
	const created = await request.post('/api/conversations', {
		data: { title: uniqueTitle('E2E lease'), workdir: repo }
	});
	expect(created.ok()).toBeTruthy();
	const { conversation } = await created.json();

	// No leases yet: an ordinary conversation must look exactly as before.
	await page.goto(`/conversations/${conversation.id}?tab=files`);
	await expect(page.getByTestId('worktree-switcher')).toHaveCount(0);

	// Create a lease the way an orchestrator's agent would, then put a file in
	// it that does not exist in the conversation's own workspace.
	const leaseRes = await request.post(`/api/conversations/${conversation.id}/worktrees`, {
		data: { label: 'alpha' }
	});
	expect(leaseRes.ok()).toBeTruthy();
	const lease = (await leaseRes.json()).worktree;
	writeFileSync(join(lease.path, 'only-in-lease.txt'), 'lease work\n');

	await page.reload();
	const switcher = page.getByTestId('worktree-switcher');
	await expect(switcher).toBeVisible();

	// The main workspace does not contain the lease's file.
	await expect(page.getByText('only-in-lease.txt')).toHaveCount(0);

	await switcher.selectOption(lease.id);

	// Switching re-reads the tree, and the URL carries the selection so a reload
	// lands on the same workspace.
	await expect(page.getByText('only-in-lease.txt')).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`worktree=${lease.id}`));
	await expect(page.getByText('Not snapshotted per message')).toBeVisible();

	await page.reload();
	await expect(page.getByText('only-in-lease.txt')).toBeVisible();

	// Back to the main workspace: the lease's file disappears again, proving the
	// panes are really reading different trees.
	await switcher.selectOption('');
	await expect(page.getByText('only-in-lease.txt')).toHaveCount(0);
});
