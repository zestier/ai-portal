import { test, expect } from './helpers/fixtures';

test('sidebar Open link navigates to the ticket detail page', async ({ page, request }) => {
	const created = await request
		.post('/api/tickets', { data: { title: 'Repro ticket' } })
		.then((r) => r.json());
	const id: string = created.ticket.id;

	await page.goto('/');

	// Open the (collapsed-by-default) Tickets section.
	await page.getByRole('button', { name: /Tickets \(/ }).click();

	// Expand the ticket row to reveal its actions.
	await page.getByRole('button', { name: 'Repro ticket' }).click();

	// Click the "Open" link and expect navigation to the detail page.
	await page.getByRole('link', { name: /Open ticket page: Repro ticket/ }).click();
	await page.waitForURL(new RegExp(`/tickets/${id}$`));
	await expect(page.getByRole('heading', { name: 'Repro ticket' })).toBeVisible();
});

test('ticket detail page renders directly', async ({ page, request }) => {
	const created = await request
		.post('/api/tickets', { data: { title: 'Direct nav ticket', body: 'hello' } })
		.then((r) => r.json());
	const id: string = created.ticket.id;

	await page.goto(`/tickets/${id}`);
	await expect(page.getByRole('heading', { name: 'Direct nav ticket' })).toBeVisible();
	await expect(page.getByText('hello')).toBeVisible();
});
