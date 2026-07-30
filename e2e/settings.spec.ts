import { test, expect } from '@playwright/test';
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

	await page.getByRole('button', { name: 'Add grant', exact: true }).click();

	// After the form action SvelteKit re-renders the page; the new row
	// should appear with the expected scope description.
	const row = page
		.locator('.grant-list .grant-row')
		.filter({ has: page.locator(`code.pattern:has-text("command=${argv0}")`) });
	await expect(row).toBeVisible();
	await expect(row.locator('code.tool')).toHaveText('shell');

	// Revoking via the guarded button removes it after confirmation.
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
