import { test, expect } from './helpers/fixtures';
import { uniqueTitle } from './helpers/conversations';
import { randomUUID } from 'node:crypto';

// Smoke tests for /settings. Specifically motivated by a regression
// where a Svelte 5 reactivity bug (a `$state` write inside a `$derived`
// computation) made the page throw on hydration. SSR still returned 200
// HTML, so neither svelte-check nor the unit suite caught it. Any spec
// here that loads the page in a browser and asserts an interactive
// element is reachable would have failed loudly.

test('settings page loads with no client-side errors', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
	});

	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);

	await page.getByRole('tab', { name: /Permissions/ }).click();
	await expect(page).toHaveURL('/settings?tab=permissions');
	await expect(page.getByRole('heading', { name: 'Saved permission grants' })).toBeVisible();
	await expect(page.getByRole('tabpanel', { name: /Permissions/ })).toBeVisible();

	// Open the add-grant <details> and verify the reactive sub-form
	// fields render. <details> doesn't expose an ARIA role consistently,
	// so target the <summary> text directly.
	await page.locator('details.add-grant > summary').click();
	await expect(page.getByRole('combobox', { name: 'Decision', exact: true })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Tool', exact: true })).toBeVisible();
	await expect(page.getByRole('textbox', { name: /argv0/ })).toBeVisible();

	expect(errors, errors.join('\n')).toEqual([]);
});

test('creating a shell+workspace-paths grant adds a row to the list', async ({ page }) => {
	await page.goto('/settings');
	await page.getByRole('tab', { name: /Permissions/ }).click();
	await page.locator('details.add-grant > summary').click();

	// Default tool=shell. Use a unique argv0 so re-runs against the
	// shared DB don't collide (the action dedups identical grants, but
	// using a unique name keeps the post-create assertion unambiguous).
	const argv0 = `e2e${randomUUID().slice(0, 8)}`;
	await page.getByLabel(/argv0/).fill(argv0);
	await page.getByLabel(/Positional arguments/).selectOption('workspace-paths');
	// The count range is orthogonal to the shape rule above: this authors
	// "exactly one workspace path", which needs both controls.
	await page.getByLabel(/Min positionals/).fill('1');
	await page.getByLabel(/Max positionals/).fill('1');

	await page.getByRole('button', { name: 'Add grant', exact: true }).click();

	// After the form action SvelteKit re-renders the page; the new row
	// should appear with the expected scope description.
	const row = page
		.locator('.grant-list .grant-row')
		.filter({ has: page.locator(`code.pattern:has-text("command=${argv0}")`) });
	await expect(row).toBeVisible();
	await expect(row.locator('code.tool')).toHaveText('shell');
	await expect(row.locator('code.pattern')).toContainText('positional-count=1');

	// Revoking via the guarded button removes it after confirmation.
	page.once('dialog', (dialog) => dialog.accept());
	await row.getByRole('button', { name: 'Revoke' }).click();
	await expect(row).toHaveCount(0);
});

test('a shell grant can defer its positionals to the fs read grants', async ({ page }) => {
	await page.goto('/settings?tab=permissions');
	await page.locator('details.add-grant > summary').click();

	const argv0 = `e2e${randomUUID().slice(0, 8)}`;
	await page.getByLabel(/argv0/).fill(argv0);
	await page.getByLabel(/Positional arguments/).selectOption('readable-paths');
	await page.getByRole('button', { name: 'Add grant', exact: true }).click();

	const row = page
		.locator('.grant-list .grant-row')
		.filter({ has: page.locator(`code.pattern:has-text("command=${argv0}")`) });
	await expect(row).toBeVisible();
	await expect(row.locator('code.pattern')).toContainText('positionals=readable-paths');

	page.once('dialog', (dialog) => dialog.accept());
	await row.getByRole('button', { name: 'Revoke' }).click();
	await expect(row).toHaveCount(0);
});

test('a custom-tool grant can be authored by tool name and warns about always-prompt tools', async ({
	page
}) => {
	await page.goto('/settings?tab=permissions');
	await page.locator('details.add-grant > summary').click();

	await page.getByRole('combobox', { name: 'Tool', exact: true }).selectOption('custom-tool');

	// The structured scope editor is replaced by the tool-name field: a portal
	// tool is authorized as a whole, so the name IS the scope.
	await expect(page.getByRole('textbox', { name: /argv0/ })).toBeHidden();
	const toolName = page.locator('input[name="toolName"]');
	await expect(toolName).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add grant', exact: true })).toBeDisabled();

	// `worktree_remove` is always-prompt, so a grant on it could never fire —
	// the form has to say so rather than silently saving a dead row.
	await toolName.fill('worktree_remove');
	await expect(page.locator('.tool-caveat')).toContainText('always prompts');

	// `worktree_create` is the real target: deliberately unseeded, but grantable.
	await toolName.fill('worktree_create');
	await expect(page.locator('.tool-caveat')).toHaveCount(0);
	await page.getByRole('button', { name: 'Add grant', exact: true }).click();

	const row = page
		.locator('.grant-list .grant-row')
		.filter({ has: page.locator('code.tool:text-is("worktree_create")') });
	await expect(row).toBeVisible();

	page.once('dialog', (dialog) => dialog.accept());
	await row.getByRole('button', { name: 'Revoke' }).click();
	await expect(row).toHaveCount(0);
});

test('settings tabs isolate activity from general settings', async ({ page }) => {
	await page.goto('/settings');

	await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Recent permission decisions' })).toBeHidden();

	await page.getByRole('tab', { name: 'Activity' }).click();
	await expect(page).toHaveURL('/settings?tab=activity');
	await expect(page.getByRole('heading', { name: 'Recent permission decisions' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeHidden();
});

test('settings tab selection survives reload and deep links', async ({ page }) => {
	await page.goto('/settings?tab=permissions');
	await expect(page.getByRole('tab', { name: /Permissions/ })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.getByRole('heading', { name: 'Saved permission grants' })).toBeVisible();

	await page.reload();
	await expect(page).toHaveURL('/settings?tab=permissions');
	await expect(page.getByRole('tab', { name: /Permissions/ })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.getByRole('heading', { name: 'Saved permission grants' })).toBeVisible();
});

test('the Extensions tab renders, deep-links, and lists the admin-managed sources', async ({
	page
}) => {
	// The Extensions tab is admin-gated but present in single-user mode; this
	// guards against a regression where the tab was omitted from the settings
	// tab list entirely (the panel + API existed but the tab was unreachable).
	await page.goto('/settings?tab=extensions');
	await expect(page.getByRole('tab', { name: 'Extensions', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.getByRole('heading', { name: 'Extensions', exact: true })).toBeVisible();
	// The warning banner renders (trust model), and the panel self-loads the
	// (empty) admin-managed list from /api/admin/extensions.
	await expect(page.getByText(/run with full system permissions/i)).toBeVisible();
	await expect(page.getByText(/No extensions configured/i)).toBeVisible();
});

test('the default approval mode is saved and seeds newly created conversations', async ({
	page,
	request
}) => {
	// The whole point of the approval-mode split is that "launch my favorite
	// setup" keeps working, so pin the full chain the settings form feeds:
	// form field -> user_settings row -> POST /api/conversations fallback.
	await page.goto('/settings');
	const select = page.locator('select[name="defaultApprovalMode"]');
	// AUTH_MODE=none gives parallel workers one local user. Normalize the
	// shared setting before the assertion and clean it up even on failure.
	await select.selectOption('ask');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	await expect(select).toHaveValue('ask');

	try {
		await select.selectOption('auto-deny');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Saved.')).toBeVisible();

		// Survives a reload, i.e. it really round-tripped through the DB.
		await page.reload();
		await expect(page.locator('select[name="defaultApprovalMode"]')).toHaveValue('auto-deny');

		// A conversation created without an explicit approvalMode inherits it.
		const inherited = await request
			.post('/api/conversations', { data: { title: uniqueTitle('Inherits approvals') } })
			.then((r) => r.json());
		expect(inherited.conversation.approvalMode).toBe('auto-deny');
		// The default is orthogonal to the conversation mode, which keeps its own default.
		expect(inherited.conversation.mode).toBe('interactive');

		// An explicit value in the create body still wins over the user default.
		const explicit = await request
			.post('/api/conversations', {
				data: { title: uniqueTitle('Explicit approvals'), approvalMode: 'auto-approve' }
			})
			.then((r) => r.json());
		expect(explicit.conversation.approvalMode).toBe('auto-approve');
	} finally {
		// Keep the shared local user isolated from later workers and repetitions.
		await page.goto('/settings');
		await page.locator('select[name="defaultApprovalMode"]').selectOption('ask');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Saved.')).toBeVisible();
	}
});

test('theme and accent settings preview immediately and revert when abandoned', async ({
	page
}) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/settings');

	const root = page.locator('html');
	const accentSelect = page.locator('select[name="accent"]');
	await expect(root).toHaveAttribute('data-theme-mode', 'system');
	await expect(root).toHaveAttribute('data-theme', 'light');
	await expect(root).toHaveAttribute('data-accent', 'default');

	const themeSelect = page.locator('select[name="theme"]');
	await themeSelect.selectOption('dark');
	await expect(root).toHaveAttribute('data-theme-mode', 'dark');
	await expect(root).toHaveAttribute('data-theme', 'dark');

	await themeSelect.selectOption('system');
	await expect(root).toHaveAttribute('data-theme-mode', 'system');
	await expect(root).toHaveAttribute('data-theme', 'light');
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(root).toHaveAttribute('data-theme', 'dark');

	await themeSelect.selectOption('light');
	await expect(root).toHaveAttribute('data-theme-mode', 'light');
	await expect(root).toHaveAttribute('data-theme', 'light');
	await accentSelect.selectOption('violet');
	await expect(root).toHaveAttribute('data-accent', 'violet');

	await page.getByRole('tab', { name: /Permissions/ }).click();
	await expect(root).toHaveAttribute('data-theme-mode', 'system');
	await expect(root).toHaveAttribute('data-theme', 'dark');
	await expect(root).toHaveAttribute('data-accent', 'default');

	await page.getByRole('tab', { name: 'General', exact: true }).click();
	await expect(page.locator('select[name="theme"]')).toHaveValue('system');
	await expect(page.locator('select[name="accent"]')).toHaveValue('default');
});

test('provider cards in the Models tab collapse by default and toggle', async ({
	page,
	request
}) => {
	// Create a fresh provider via the API so the assertion is unambiguous
	// against the shared DB; clean it up even on failure.
	const pid = `e2e${randomUUID().slice(0, 8)}`;
	try {
		const created = await request.post('/api/admin/models', {
			data: {
				action: 'provider',
				id: pid,
				name: pid,
				api: 'openai-completions',
				baseUrl: 'http://localhost:1/v1',
				authHeader: false,
				builtin: false,
				enabled: true
			}
		});
		expect(created.ok()).toBe(true);

		await page.goto('/settings?tab=models');
		const card = page.locator('section.provider-card').filter({ hasText: pid });

		// Collapsed by default: header visible, body hidden.
		await expect(card.locator(`#provider-body-${pid}`)).toBeHidden();
		const toggle = card.locator('button.collapse-toggle');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await expect(toggle).toHaveAttribute('aria-label', `Expand ${pid}`);

		// Expand round-trip.
		await toggle.click();
		await expect(card.locator(`#provider-body-${pid}`)).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect(toggle).toHaveAttribute('aria-label', `Collapse ${pid}`);

		await toggle.click();
		await expect(card.locator(`#provider-body-${pid}`)).toBeHidden();
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	} finally {
		await request.delete('/api/admin/models/' + pid);
	}
});
