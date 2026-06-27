import { test, expect } from './helpers/fixtures';

// The whole suite shares one server, DB and default ticket workspace. These
// specs all write tickets into that shared workspace, so run them serially:
// the offset-paginated index relies on a stable window, and a sibling test
// inserting a ticket mid-pagination would shift the offset and surface a row
// twice (the concurrent-insert skew inherent to OFFSET paging).
test.describe.configure({ mode: 'serial' });

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

test('tickets index browses, filters by status, and paginates', async ({ page, request }) => {
	// The e2e suite shares one server + DB + default workspace across all specs
	// (and CI retries), so tag this run's tickets with a unique prefix to keep
	// title-based locators unambiguous. Pagination is asserted via invariants
	// (first page caps at PAGE_SIZE; Load more grows the list) that hold
	// regardless of how many other tickets share the workspace.
	const run = `browse-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

	// Seed enough open tickets to require a second page (PAGE_SIZE = 20).
	for (let i = 0; i < 22; i++) {
		await request.post('/api/tickets', { data: { title: `${run} open ${i}` } });
	}
	// One done ticket so the Done filter has content the open list won't show.
	const done = await request
		.post('/api/tickets', { data: { title: `${run} finished` } })
		.then((r) => r.json());
	await request.patch(`/api/tickets/${done.ticket.id}`, { data: { status: 'done' } });

	await page.goto('/tickets');
	await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();

	// The first page caps at PAGE_SIZE (20) rows + a Load more control; the done
	// ticket is filtered out of the Open list.
	const rows = page.locator('li.ticket-row');
	const loadMore = page.getByRole('button', { name: 'Load more' });
	await expect(loadMore).toBeVisible();
	await expect(rows).toHaveCount(20);
	await expect(page.getByRole('link', { name: `${run} finished` })).toHaveCount(0);

	// Load more pages in the next window, growing the list beyond one page. Wait
	// on the actual offset request so the assertion doesn't race the fetch.
	const secondPage = page.waitForResponse(
		(r) => r.url().includes('/api/tickets') && r.url().includes('offset=20') && r.ok()
	);
	await loadMore.click();
	await secondPage;
	await expect(rows).not.toHaveCount(20);

	// Switching to Done shows this run's finished ticket (freshly updated, so it
	// sorts onto the first page) and drops the open ones.
	await page.getByRole('tab', { name: 'Done' }).click();
	await expect(page.getByRole('link', { name: `${run} finished` })).toBeVisible();
	await expect(page.getByRole('link', { name: `${run} open 0`, exact: true })).toHaveCount(0);

	// A row links to its detail page. Click the first row generically and assert
	// it navigated to a ticket detail URL — no dependence on row ordering.
	await page.getByRole('tab', { name: 'Open' }).click();
	await rows.first().getByRole('link').click();
	await page.waitForURL(/\/tickets\/[A-Za-z0-9]+$/);
});

test('sidebar links to the full tickets page', async ({ page, request }) => {
	await request.post('/api/tickets', { data: { title: 'Sidebar link ticket' } });

	await page.goto('/');
	await page.getByRole('button', { name: /Tickets \(/ }).click();
	await page.getByRole('link', { name: 'View all tickets →' }).click();
	await page.waitForURL(/\/tickets$/);
	await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
});
