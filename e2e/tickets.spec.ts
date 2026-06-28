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

test('detail toolbar transitions status in place and confirms archive', async ({
	page,
	request
}) => {
	const created = await request
		.post('/api/tickets', { data: { title: 'Toolbar ticket' } })
		.then((r) => r.json());
	const id: string = created.ticket.id;

	await page.goto(`/tickets/${id}`);

	const toolbar = page.getByRole('group', { name: 'Ticket actions' });

	// Open ticket: Mark done + Archive available, no Reopen.
	await expect(toolbar.getByRole('button', { name: 'Mark done' })).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Reopen' })).toHaveCount(0);

	// Mark done fires instantly and refreshes in place: the pill and the toolbar
	// re-derive (Reopen replaces Mark done) without a full navigation.
	await toolbar.getByRole('button', { name: 'Mark done' }).click();
	await expect(toolbar.getByRole('button', { name: 'Reopen' })).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Mark done' })).toHaveCount(0);

	// Archive opens a confirmation dialog; cancelling makes no change.
	await toolbar.getByRole('button', { name: 'Archive' }).click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await expect(toolbar.getByRole('button', { name: 'Archive' })).toBeVisible();

	// Confirming archives the ticket; an archived ticket exposes only Reopen.
	await toolbar.getByRole('button', { name: 'Archive' }).click();
	await dialog.getByRole('button', { name: 'Archive' }).click();
	await expect(toolbar.getByRole('button', { name: 'Reopen' })).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Archive' })).toHaveCount(0);
	await expect(toolbar.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
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

test('detail page shows a priority pill and edits priority in place', async ({ page, request }) => {
	const created = await request
		.post('/api/tickets', { data: { title: 'Priority detail ticket', priority: 'P1' } })
		.then((r) => r.json());
	const id: string = created.ticket.id;

	await page.goto(`/tickets/${id}`);
	const select = page.getByLabel('Ticket priority');
	await expect(select).toHaveValue('P1');
	// The header pill reflects the current priority.
	await expect(page.locator('.header-pills').getByText('P1', { exact: true })).toBeVisible();

	// Editing the select PATCHes and refreshes loader data in place.
	const patched = page.waitForResponse(
		(r) => r.url().includes(`/api/tickets/${id}`) && r.request().method() === 'PATCH' && r.ok()
	);
	await select.selectOption('P0');
	await patched;
	await expect(select).toHaveValue('P0');
	await expect(page.locator('.header-pills').getByText('P0', { exact: true })).toBeVisible();

	// Persisted: a fresh load reflects the new priority.
	await page.reload();
	await expect(page.getByLabel('Ticket priority')).toHaveValue('P0');
});

test('tickets index filters and sorts by priority', async ({ page, request }) => {
	const run = `prio-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	await request.post('/api/tickets', { data: { title: `${run} low`, priority: 'P3' } });
	await request.post('/api/tickets', { data: { title: `${run} high`, priority: 'P0' } });

	await page.goto('/tickets');
	const high = page.getByRole('link', { name: `${run} high` });
	const low = page.getByRole('link', { name: `${run} low` });
	await expect(high).toBeVisible();
	await expect(low).toBeVisible();

	// Filtering to P0 keeps the high-priority ticket and drops the P3 one.
	await page.getByLabel('Filter by priority').selectOption('P0');
	await expect(high).toBeVisible();
	await expect(low).toHaveCount(0);

	// Reset the filter, then opt into priority sort: P0 sorts ahead of P3.
	await page.getByLabel('Filter by priority').selectOption('all');
	await page.getByRole('button', { name: 'Sort by priority' }).click();
	const titles = await page.locator('li.ticket-row .ticket-title').allInnerTexts();
	const highIdx = titles.indexOf(`${run} high`);
	const lowIdx = titles.indexOf(`${run} low`);
	expect(highIdx).toBeGreaterThanOrEqual(0);
	expect(lowIdx).toBeGreaterThan(highIdx);
});

test('sidebar links to the full tickets page', async ({ page, request }) => {
	await request.post('/api/tickets', { data: { title: 'Sidebar link ticket' } });

	await page.goto('/');
	await page.getByRole('button', { name: /Tickets \(/ }).click();
	await page.getByRole('link', { name: 'View all tickets →' }).click();
	await page.waitForURL(/\/tickets$/);
	await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
});

test('sidebar drops a ticket marked done live, without navigation', async ({ page, request }) => {
	// Unique title so the row locator is unambiguous in the shared workspace.
	const title = `live-done-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const created = await request.post('/api/tickets', { data: { title } }).then((r) => r.json());
	const id: string = created.ticket.id;

	await page.goto('/');
	await page.getByRole('button', { name: /Tickets \(/ }).click();
	const row = page.getByRole('button', { name: title });
	await expect(row).toBeVisible();

	// Mark done via the REST endpoint — as another tab/origin would. No
	// navigation here: the global `/api/events` feed delivers `tickets.changed`,
	// which the app shell debounces into an `invalidateAll()` that re-runs the
	// layout `load` and drops the done ticket from the open sidebar list.
	const patched = await request.patch(`/api/tickets/${id}`, { data: { status: 'done' } });
	expect(patched.ok()).toBe(true);

	await expect(row).toHaveCount(0);
});
