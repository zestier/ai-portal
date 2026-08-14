import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupLocalEnv, resetServerSingletons } from './helpers/env';
import { conversationId as conversationIdCodec, ticketId as ticketIdCodec } from '../src/lib/ids';

let workspace: string;

function event(opts: {
	url?: string;
	userId: number | null;
	body?: unknown;
	params?: Record<string, string | number>;
}) {
	return {
		locals: { userId: opts.userId },
		params: opts.params ?? {},
		url: new URL(opts.url ?? 'http://localhost/api/tickets'),
		request: new Request(opts.url ?? 'http://localhost/api/tickets', {
			method: opts.body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json' },
			...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
		})
	};
}

describe('workspace tickets', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-tickets-');
		workspace = mkdtempSync(join(tmpdir(), 'portal-ticket-workspace-'));
		// Ticket REST routes resolve the supplied workspace through the workdir
		// allowlist; these tests use throwaway tmpdir workspaces, so allow them.
		process.env.ALLOWED_WORKDIRS = tmpdir();
		await resetServerSingletons();
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it('repo scopes tickets by user and workspace', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const { getDb } = await import('../src/lib/server/db');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'ticket-rival',
			githubId: 808,
			displayName: null,
			avatarUrl: null
		});

		const a = tickets.create(user.id, { workspaceKey: workspace, title: 'Improve nav' });
		tickets.create(user.id, { workspaceKey: `${workspace}-other`, title: 'Other workspace' });
		tickets.create(other.id, { workspaceKey: workspace, title: 'Other user' });

		expect(tickets.list(user.id, workspace).map((t) => t.id)).toEqual([a.id]);
		expect(tickets.get(a.id, other.id)).toBeNull();

		const done = tickets.update(a.id, user.id, { status: 'done' });
		expect(done?.status).toBe('done');
		expect(done?.closedAt).toBeTypeOf('number');
		expect(tickets.list(user.id, workspace)).toEqual([]);
		expect(tickets.list(user.id, workspace, { status: 'done' }).map((t) => t.id)).toEqual([a.id]);
		expect(tickets.count(user.id, workspace, 'done')).toBe(1);
		expect(() => tickets.create(user.id, { workspaceKey: workspace, title: '   ' })).toThrow(
			'ticket title cannot be empty'
		);
		expect(() =>
			getDb()
				.prepare(
					`INSERT INTO workspace_tickets(
					   id, user_id, workspace_key, title, body, status, created_at, updated_at
					 ) VALUES (999997, ?, ?, 'bad', '', 'invalid', 1, 1)`
				)
				.run(user.id, workspace)
		).toThrow();
	});

	it('API creates, lists, updates, and archives tickets for the current user', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const otherWorkspace = mkdtempSync(join(tmpdir(), 'portal-ticket-other-workspace-'));
		const { POST, GET } = await import('../src/routes/api/tickets/+server');
		const { PATCH, DELETE } = await import('../src/routes/api/tickets/[id]/+server');
		const user = users.ensureLocalUser();

		const createdResponse = await POST(
			event({
				userId: user.id,
				body: { workspace, title: 'Add ticket stash', body: 'Keep it simple' }
			}) as never
		);
		expect(createdResponse.status).toBe(201);
		const created = await createdResponse.json();
		expect(created.ticket.title).toBe('Add ticket stash');

		const listResponse = await GET(
			event({
				userId: user.id,
				url: `http://localhost/api/tickets?workspace=${encodeURIComponent(workspace)}`
			}) as never
		);
		const listed = await listResponse.json();
		expect(listed.tickets.map((t: { id: number }) => t.id)).toEqual([created.ticket.id]);

		const patchResponse = await PATCH(
			event({
				userId: user.id,
				params: { id: created.ticket.id },
				body: { status: 'done', workspace }
			}) as never
		);
		const patched = await patchResponse.json();
		expect(patched.ticket.status).toBe('done');

		let mismatchedPatchStatus: number;
		try {
			const response = await PATCH(
				event({
					userId: user.id,
					params: { id: created.ticket.id },
					body: { status: 'open', workspace: otherWorkspace }
				}) as never
			);
			mismatchedPatchStatus = response.status;
		} catch (e) {
			mismatchedPatchStatus = (e as { status?: number }).status ?? 0;
		}
		expect(mismatchedPatchStatus).toBe(404);

		const deleteResponse = await DELETE(
			event({
				userId: user.id,
				params: { id: created.ticket.id },
				url: `http://localhost/api/tickets/${created.ticket.id}?workspace=${encodeURIComponent(workspace)}`
			}) as never
		);
		expect(deleteResponse.status).toBe(200);
		const archived = await deleteResponse.json();
		expect(archived.ticket.status).toBe('archived');
		expect(tickets.get(created.ticket.id, user.id)?.status).toBe('archived');
		expect(tickets.list(user.id, workspace, { status: 'archived' }).map((t) => t.id)).toEqual([
			created.ticket.id
		]);
		rmSync(otherWorkspace, { recursive: true, force: true });
	});

	it('API purge permanently deletes a ticket and cascades its edges', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { DELETE } = await import('../src/routes/api/tickets/[id]/+server');
		const user = users.ensureLocalUser();

		const blocker = tickets.create(user.id, { workspaceKey: workspace, title: 'Prerequisite' });
		const target = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Blocked ticket',
			blockedBy: [ticketIdCodec.parse(blocker.id)]
		});
		expect(tickets.listDependencies(target.id)).toEqual([blocker.id]);

		const purgeResponse = await DELETE(
			event({
				userId: user.id,
				params: { id: target.id },
				url: `http://localhost/api/tickets/${target.id}?purge=true&workspace=${encodeURIComponent(workspace)}`
			}) as never
		);
		expect(purgeResponse.status).toBe(200);
		const purged = await purgeResponse.json();
		expect(purged.deleted).toBe(true);

		// The row is gone entirely — not merely archived — and the FK cascade took
		// its dependency edges with it. The blocker is untouched.
		expect(tickets.get(target.id, user.id)).toBeNull();
		expect(tickets.list(user.id, workspace, { status: 'all' }).map((t) => t.id)).toEqual([
			blocker.id
		]);
		expect(tickets.listDependents(blocker.id)).toEqual([]);

		// Purging an already-deleted ticket is a 404, not a silent success.
		let secondPurgeStatus: number;
		try {
			const response = await DELETE(
				event({
					userId: user.id,
					params: { id: target.id },
					url: `http://localhost/api/tickets/${target.id}?purge=true`
				}) as never
			);
			secondPurgeStatus = response.status;
		} catch (e) {
			secondPurgeStatus = (e as { status?: number }).status ?? 0;
		}
		expect(secondPurgeStatus).toBe(404);
	});

	it('agent ticket tools are scoped to the active user and workspace', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'Ticket tools',
			workdir: workspace,
			model: null
		});
		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: conversationIdCodec.parse(conv.id)
		});

		const add = tools.find((t) => t.name === 'ticket_add')!;
		const list = tools.find((t) => t.name === 'ticket_list')!;
		const update = tools.find((t) => t.name === 'ticket_update')!;
		const get = tools.find((t) => t.name === 'ticket_get')!;

		await add.handler({ title: 'Remember this' });
		const [ticket] = tickets.list(user.id, workspace);
		expect(ticket.title).toBe('Remember this');
		expect(ticket.sourceConversationId).toBe(conv.id);
		await update.handler({ id: String(ticket.id), status: 'done' });
		const listed = await list.handler({ status: 'all' });
		expect(listed.ok).toBe(true);
		expect(listed.ok && listed.result).toContain('[done] Remember this');

		// ticket_list with no fields keeps the dense hand-rendered string.
		expect(typeof (listed.ok && listed.result)).toBe('string');

		// An explicit `fields` selector switches ticket_list to a structured,
		// projected array trimmed to the requested fields.
		const listedFields = await list.handler({ status: 'all', fields: ['id', 'status'] });
		const listedData = listedFields.ok && (listedFields.result as { tickets: unknown[] });
		expect(Array.isArray(listedData && listedData.tickets)).toBe(true);
		expect((listedData as { tickets: Record<string, unknown>[] }).tickets[0]).toEqual({
			id: ticket.id,
			status: 'done'
		});

		// ticket_get: compact default drops provenance/timestamps but lists them in
		// _omitted; an explicit `fields` request recovers exactly what was asked for.
		const compact = await get.handler({ id: String(ticket.id) });
		const compactData = compact.ok && (compact.result as Record<string, unknown>);
		expect(compactData).toMatchObject({ id: String(ticket.id), title: 'Remember this' });
		expect(compactData).not.toHaveProperty('createdAt');
		expect((compactData as { _omitted?: string[] })._omitted).toContain('createdAt');

		const picked = await get.handler({ id: String(ticket.id), fields: ['createdAt'] });
		const pickedData = picked.ok && (picked.result as Record<string, unknown>);
		expect(pickedData).toHaveProperty('createdAt');
		expect(pickedData).not.toHaveProperty('title');
		expect(pickedData).not.toHaveProperty('_omitted');

		const workspaceOnly = await get.handler({ id: String(ticket.id), fields: ['workspaceKey'] });
		const workspaceData = workspaceOnly.ok && (workspaceOnly.result as Record<string, unknown>);
		expect(workspaceData).toEqual({ workspaceKey: workspace });

		// plan: settable via ticket_update, omitted from the compact view, and
		// fetched on demand through the fields selector (the showcase use case).
		await update.handler({ id: String(ticket.id), plan: '1. wire it\n2. test it' });
		const compactNoPlan = await get.handler({ id: String(ticket.id) });
		expect(
			compactNoPlan.ok && (compactNoPlan.result as Record<string, unknown>)
		).not.toHaveProperty('plan');
		const planOnly = await get.handler({ id: String(ticket.id), fields: ['plan'] });
		const planData = planOnly.ok && (planOnly.result as Record<string, unknown>);
		expect(planData).toEqual({ plan: '1. wire it\n2. test it' });
	});

	it('models ticket dependencies, blocks cycles, and surfaces blockers', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'Deps',
			workdir: workspace,
			model: null
		});
		const otherWorkspace = mkdtempSync(join(tmpdir(), 'portal-ticket-deps-other-'));
		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: conversationIdCodec.parse(conv.id)
		});
		const list = tools.find((t) => t.name === 'ticket_list')!;
		const get = tools.find((t) => t.name === 'ticket_get')!;
		const block = tools.find((t) => t.name === 'ticket_block')!;
		const unblock = tools.find((t) => t.name === 'ticket_unblock')!;

		const api = tickets.create(user.id, { workspaceKey: workspace, title: 'Build API' });
		const ui = tickets.create(user.id, { workspaceKey: workspace, title: 'Build UI' });
		const foreign = tickets.create(user.id, { workspaceKey: otherWorkspace, title: 'Elsewhere' });

		// UI depends on API: UI is blocked, API is not.
		const blocked = await block.handler({ id: String(ui.id), blockedBy: String(api.id) });
		expect(blocked.ok).toBe(true);
		expect(tickets.openBlockers(ui.id)).toEqual([api.id]);
		expect(tickets.listDependents(api.id)).toEqual([ui.id]);

		// Re-blocking is an idempotent no-op.
		const again = await block.handler({ id: String(ui.id), blockedBy: String(api.id) });
		expect(again.ok && (again.result as { result: string }).result).toBe('exists');

		// Self-edge and cycle are rejected.
		expect((await block.handler({ id: String(ui.id), blockedBy: String(ui.id) })).ok).toBe(false);
		const cycle = await block.handler({ id: String(api.id), blockedBy: String(ui.id) });
		expect(cycle.ok).toBe(false);
		expect(!cycle.ok && cycle.error.message).toMatch(/cycle/i);

		// Cross-workspace pairing is rejected (foreign ticket isn't in this workspace).
		expect((await block.handler({ id: String(ui.id), blockedBy: String(foreign.id) })).ok).toBe(
			false
		);

		// Dense ticket_list flags the blocked ticket inline.
		const listed = await list.handler({});
		expect(listed.ok && (listed.result as string)).toContain(`(blocked by: ${api.id})`);

		// ticket_get exposes blockedBy/blocks via the fields selector.
		const uiBlockers = await get.handler({ id: String(ui.id), fields: ['blockedBy'] });
		expect(uiBlockers.ok && (uiBlockers.result as { blockedBy: string[] }).blockedBy).toEqual([
			api.id
		]);

		// The compact ticket_get view shows blockers/dependents inline (no fields
		// needed) when present: UI is blocked by API; API blocks UI.
		const uiCompact = await get.handler({ id: String(ui.id) });
		expect(uiCompact.ok && (uiCompact.result as { blockedBy?: string[] }).blockedBy).toEqual([
			api.id
		]);
		const apiCompact = await get.handler({ id: String(api.id) });
		expect(apiCompact.ok && (apiCompact.result as { blocks?: string[] }).blocks).toEqual([ui.id]);
		// A ticket with no open blockers omits the empty list rather than showing [].
		expect(apiCompact.ok && (apiCompact.result as Record<string, unknown>)).not.toHaveProperty(
			'blockedBy'
		);

		// Completing the prerequisite clears the block (UI becomes ready).
		tickets.update(api.id, user.id, { status: 'done' });
		expect(tickets.openBlockers(ui.id)).toEqual([]);
		const readyList = await list.handler({});
		expect(readyList.ok && (readyList.result as string)).not.toContain('blocked by');
		// UI now renders without a blockedBy entry in the compact view.
		const uiReady = await get.handler({ id: String(ui.id) });
		expect(uiReady.ok && (uiReady.result as Record<string, unknown>)).not.toHaveProperty(
			'blockedBy'
		);

		// Unblock removes the edge; a second unblock reports nothing to remove.
		expect((await unblock.handler({ id: String(ui.id), blockedBy: String(api.id) })).ok).toBe(true);
		expect(tickets.listDependencies(ui.id)).toEqual([]);
		expect((await unblock.handler({ id: String(ui.id), blockedBy: String(api.id) })).ok).toBe(
			false
		);

		rmSync(otherWorkspace, { recursive: true, force: true });
	});

	it('ticket_add and ticket_update accept edges and surface bad ones as errors', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'Edge tools',
			workdir: workspace,
			model: null
		});
		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: conversationIdCodec.parse(conv.id)
		});
		const add = tools.find((t) => t.name === 'ticket_add')!;
		const update = tools.find((t) => t.name === 'ticket_update')!;

		const api = tickets.create(user.id, { workspaceKey: workspace, title: 'API' });

		// ticket_add with blockedBy creates the ticket and its edge in one call.
		const added = await add.handler({ title: 'UI', blockedBy: [String(api.id)] });
		expect(added.ok).toBe(true);
		const uiId = (added.ok && (added.result as { id: number }).id) as number;
		expect(tickets.openBlockers(uiId)).toEqual([api.id]);

		// ticket_update replaces the blocker set declaratively (here, clear it).
		const cleared = await update.handler({ id: String(uiId), blockedBy: [] });
		expect(cleared.ok).toBe(true);
		expect(tickets.openBlockers(uiId)).toEqual([]);

		// A bad edge id comes back as a clean error envelope (not a thrown crash).
		const bad = await add.handler({ title: 'Broken', blockedBy: ['nope'] });
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.error.message).toMatch(/not found/i);
		// And the failed add left no ticket behind.
		expect(
			tickets.list(user.id, workspace, { status: 'all' }).some((t) => t.title === 'Broken')
		).toBe(false);
	});

	it('dependencyRefs and dependentRefs return display refs with status', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();

		const api = tickets.create(user.id, { workspaceKey: workspace, title: 'Build API' });
		const ui = tickets.create(user.id, { workspaceKey: workspace, title: 'Build UI' });
		tickets.addDependency(user.id, ui.id, api.id);

		// UI depends on API; API is depended on by UI. Refs carry title + status.
		expect(tickets.dependencyRefs(ui.id, user.id)).toEqual([
			{ id: api.id, title: 'Build API', status: 'open' }
		]);
		expect(tickets.dependentRefs(ui.id, user.id)).toEqual([]);
		expect(tickets.dependentRefs(api.id, user.id)).toEqual([
			{ id: ui.id, title: 'Build UI', status: 'open' }
		]);
		expect(tickets.dependencyRefs(api.id, user.id)).toEqual([]);

		// Unlike openBlockers, dependencyRefs keeps satisfied prerequisites visible,
		// carrying the updated status so the detail page can mark them satisfied.
		tickets.update(api.id, user.id, { status: 'done' });
		expect(tickets.dependencyRefs(ui.id, user.id)).toEqual([
			{ id: api.id, title: 'Build API', status: 'done' }
		]);
		// openBlockers (ids, open-only) drops the now-satisfied prerequisite.
		expect(tickets.openBlockers(ui.id)).toEqual([]);

		// Scoped by user: another user sees none of these edges' refs.
		const other = users.upsertGithub({
			githubLogin: 'deps-rival',
			githubId: 717,
			displayName: null,
			avatarUrl: null
		});
		expect(tickets.dependencyRefs(ui.id, other.id)).toEqual([]);
		expect(tickets.dependentRefs(api.id, other.id)).toEqual([]);
	});

	it('create and update set blocking edges from either side, atomically', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();

		const api = tickets.create(user.id, { workspaceKey: workspace, title: 'API' });
		const infra = tickets.create(user.id, { workspaceKey: workspace, title: 'Infra' });

		// create() can set both sides at once: ui is blocked by api, and blocks ship.
		const ui = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'UI',
			blockedBy: [ticketIdCodec.parse(api.id)]
		});
		const ship = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Ship',
			blockedBy: [ticketIdCodec.parse(ui.id)]
		});
		expect(tickets.dependencyRefs(ui.id, user.id).map((r) => r.id)).toEqual([api.id]);
		expect(tickets.dependentRefs(ui.id, user.id).map((r) => r.id)).toEqual([ship.id]);

		// update() reconciles a side as a desired-state set: replace ui's blockers
		// with [api, infra] (adds infra, keeps api), and clear ship's via [].
		tickets.update(ui.id, user.id, { blockedBy: [ticketIdCodec.parse(api.id), ticketIdCodec.parse(infra.id)] });
		expect(
			tickets
				.dependencyRefs(ui.id, user.id)
				.map((r) => r.id)
				.sort()
		).toEqual([api.id, infra.id].sort());
		// `blocks` from the reverse side: make ui also block ship explicitly stays,
		// then clear ui's dependents.
		tickets.update(ui.id, user.id, { blocks: [] });
		expect(tickets.dependentRefs(ui.id, user.id)).toEqual([]);

		// Atomicity + validation: a create whose edge would cycle throws and rolls
		// back — no orphan ticket is left behind.
		const before = tickets.list(user.id, workspace, { status: 'all' }).length;
		expect(() =>
			tickets.create(user.id, {
				workspaceKey: workspace,
				title: 'Cyclic',
				blockedBy: [ticketIdCodec.parse(api.id)],
				blocks: [ticketIdCodec.parse(api.id)] // api blocked by new AND new blocked by api -> cycle
			})
		).toThrow(/cycle/i);
		expect(tickets.list(user.id, workspace, { status: 'all' }).length).toBe(before);

		// A bad edge id on update throws and leaves edges unchanged.
		expect(() => tickets.update(ui.id, user.id, { blockedBy: [999999] })).toThrow(/not found/i);
		expect(
			tickets
				.dependencyRefs(ui.id, user.id)
				.map((r) => r.id)
				.sort()
		).toEqual([api.id, infra.id].sort());
	});

	it('ticket detail page load returns the ticket with its dependency refs', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { load } = await import('../src/routes/tickets/[id]/+page.server');
		const user = users.ensureLocalUser();

		const api = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Build API',
			plan: '1. design\n2. implement'
		});
		const ui = tickets.create(user.id, { workspaceKey: workspace, title: 'Build UI' });
		tickets.addDependency(user.id, ui.id, api.id);

		const data = (await load({
			params: { id: String(ui.id) },
			locals: { userId: user.id }
		} as never)) as {
			ticket: { id: string; plan: string };
			dependsOn: { id: string; status: string }[];
			dependents: { id: string }[];
		};
		expect(data.ticket.id).toBe(ui.id);
		expect(data.dependsOn).toEqual([{ id: api.id, title: 'Build API', status: 'open' }]);
		expect(data.dependents).toEqual([]);

		// The prerequisite's own page sees the dependent and carries its plan.
		const apiData = (await load({
			params: { id: String(api.id) },
			locals: { userId: user.id }
		} as never)) as { ticket: { plan: string }; dependents: { id: string }[] };
		expect(apiData.ticket.plan).toBe('1. design\n2. implement');
		expect(apiData.dependents).toEqual([{ id: ui.id, title: 'Build UI', status: 'open' }]);

		// A ticket the user doesn't own 404s. `load` is sync and `error()` throws
		// synchronously, so assert via a direct catch rather than `.rejects`.
		const other = users.upsertGithub({
			githubLogin: 'page-rival',
			githubId: 909,
			displayName: null,
			avatarUrl: null
		});
		let status = 0;
		try {
			load({ params: { id: String(ui.id) }, locals: { userId: other.id } } as never);
		} catch (e) {
			status = (e as { status?: number }).status ?? 0;
		}
		expect(status).toBe(404);
	});

	it('repo list paginates with limit + offset', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();

		for (let i = 0; i < 5; i++) {
			tickets.create(user.id, { workspaceKey: workspace, title: `T${i}` });
		}

		// The full ordered list is the source of truth; paging must return the same
		// rows in the same order, just windowed — robust to whatever the (updated_at
		// DESC, created_at DESC) order resolves to under same-millisecond creates.
		const full = tickets.list(user.id, workspace, { status: 'open', limit: 100, offset: 0 });
		expect(full.length).toBe(5);

		expect(tickets.list(user.id, workspace, { limit: 2, offset: 0 }).map((t) => t.id)).toEqual(
			full.slice(0, 2).map((t) => t.id)
		);
		expect(tickets.list(user.id, workspace, { limit: 2, offset: 2 }).map((t) => t.id)).toEqual(
			full.slice(2, 4).map((t) => t.id)
		);
		expect(tickets.list(user.id, workspace, { limit: 2, offset: 4 }).map((t) => t.id)).toEqual(
			full.slice(4).map((t) => t.id)
		);

		// Offset past the end yields nothing.
		expect(tickets.list(user.id, workspace, { limit: 2, offset: 10 })).toEqual([]);

		// status: 'all' also paginates against its own full ordering.
		const fullAll = tickets.list(user.id, workspace, { status: 'all', limit: 100, offset: 0 });
		expect(
			tickets.list(user.id, workspace, { status: 'all', limit: 3, offset: 0 }).map((t) => t.id)
		).toEqual(fullAll.slice(0, 3).map((t) => t.id));
	});

	it('repo list filters by priority and sorts highest-first across the full set', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();

		// Create in an order where recency (newest-first) disagrees with priority,
		// so a sort that only reordered a single loaded page would be detectable.
		const priorities = ['P3', 'P0', 'P2', 'P1', 'P0', 'P3', 'P1', 'P2'] as const;
		priorities.forEach((priority, i) =>
			tickets.create(user.id, { workspaceKey: workspace, title: `T${i}`, priority })
		);

		// Priority sort orders P0→P3 across the WHOLE set (the count of each
		// priority is deterministic regardless of the recency tie-break).
		const sorted = tickets.list(user.id, workspace, {
			status: 'open',
			sort: 'priority',
			limit: 100,
			offset: 0
		});
		expect(sorted.map((t) => t.priority)).toEqual(['P0', 'P0', 'P1', 'P1', 'P2', 'P2', 'P3', 'P3']);

		// The first page holds the globally highest-priority tickets and paging
		// continues in that same order — not a per-page reshuffle. `sorted` is the
		// source of truth, robust to same-millisecond create ordering.
		expect(
			tickets.list(user.id, workspace, { sort: 'priority', limit: 3, offset: 0 }).map((t) => t.id)
		).toEqual(sorted.slice(0, 3).map((t) => t.id));
		expect(
			tickets.list(user.id, workspace, { sort: 'priority', limit: 3, offset: 3 }).map((t) => t.id)
		).toEqual(sorted.slice(3, 6).map((t) => t.id));

		// Priority filter returns only that priority across the full set and pages
		// within it (so "Load more" never fetches phantom rows).
		const p0 = tickets.list(user.id, workspace, { priority: 'P0', limit: 100, offset: 0 });
		expect(p0.length).toBe(2);
		expect(p0.every((t) => t.priority === 'P0')).toBe(true);
		expect(
			tickets.list(user.id, workspace, { priority: 'P0', limit: 1, offset: 1 }).map((t) => t.id)
		).toEqual([p0[1].id]);

		// Filter + sort compose, and the default (no sort, no filter) still returns
		// the whole open set in recency order — same query shape as before.
		expect(
			tickets
				.list(user.id, workspace, { priority: 'P3', sort: 'priority', limit: 100, offset: 0 })
				.every((t) => t.priority === 'P3')
		).toBe(true);
		expect(tickets.list(user.id, workspace, { status: 'open', limit: 100, offset: 0 }).length).toBe(
			8
		);
	});

	it('GET /api/tickets honors and validates the sort + priority params', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { GET } = await import('../src/routes/api/tickets/+server');
		const user = users.ensureLocalUser();

		tickets.create(user.id, { workspaceKey: workspace, title: 'low', priority: 'P3' });
		tickets.create(user.id, { workspaceKey: workspace, title: 'high', priority: 'P0' });
		tickets.create(user.id, { workspaceKey: workspace, title: 'mid', priority: 'P2' });
		const ws = encodeURIComponent(workspace);

		const sortedRes = (await GET(
			event({
				url: `http://localhost/api/tickets?status=open&sort=priority&workspace=${ws}`,
				userId: user.id
			}) as never
		)) as Response;
		const sorted = (await sortedRes.json()) as { tickets: { priority: string }[] };
		expect(sorted.tickets.map((t) => t.priority)).toEqual(['P0', 'P2', 'P3']);

		const filteredRes = (await GET(
			event({
				url: `http://localhost/api/tickets?status=open&priority=P0&workspace=${ws}`,
				userId: user.id
			}) as never
		)) as Response;
		const filtered = (await filteredRes.json()) as {
			tickets: { title: string; priority: string }[];
		};
		expect(filtered.tickets.map((t) => t.priority)).toEqual(['P0']);
		expect(filtered.tickets[0].title).toBe('high');

		// Invalid params fall back safely: bad sort -> recency, bad priority -> all.
		const fallbackRes = (await GET(
			event({
				url: `http://localhost/api/tickets?status=open&sort=bogus&priority=P9&workspace=${ws}`,
				userId: user.id
			}) as never
		)) as Response;
		const fallback = (await fallbackRes.json()) as { tickets: unknown[] };
		expect(fallback.tickets.length).toBe(3);
	});

	it('/tickets page load reads sort + priority from the URL', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { load } = await import('../src/routes/tickets/+page.server');
		const user = users.ensureLocalUser();

		tickets.create(user.id, { workspaceKey: workspace, title: 'low', priority: 'P3' });
		tickets.create(user.id, { workspaceKey: workspace, title: 'high', priority: 'P0' });
		tickets.create(user.id, { workspaceKey: workspace, title: 'mid', priority: 'P2' });

		const data = (await load({
			locals: { userId: user.id },
			parent: async () => ({ ticketWorkspace: workspace }),
			url: new URL('http://localhost/tickets?sort=priority&priority=P0')
		} as never)) as {
			initialSort: string;
			initialPriority: string;
			initialTickets: { priority: string }[];
		};
		expect(data.initialSort).toBe('priority');
		expect(data.initialPriority).toBe('P0');
		expect(data.initialTickets.map((t) => t.priority)).toEqual(['P0']);

		// Defaults when the URL omits them (and degrades gracefully without `url`).
		const def = (await load({
			locals: { userId: user.id },
			parent: async () => ({ ticketWorkspace: workspace })
		} as never)) as { initialSort: string; initialPriority: string };
		expect(def.initialSort).toBe('recency');
		expect(def.initialPriority).toBe('all');
	});

	it('listForSidebar surfaces ready tickets even when the newest are all blocked', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();

		// An open prerequisite that itself is ready (no prerequisites of its own).
		const prereq = tickets.create(user.id, { workspaceKey: workspace, title: 'Prereq' });
		// A ready ticket created early, so it falls outside the 10 most-recent rows.
		const ready = tickets.create(user.id, { workspaceKey: workspace, title: 'Ready' });
		// Ten newer tickets, each blocked by the still-open prerequisite.
		const blocked: string[] = [];
		for (let i = 0; i < 10; i++) {
			const b = tickets.create(user.id, { workspaceKey: workspace, title: `Blocked ${i}` });
			tickets.addDependency(user.id, b.id, prereq.id);
			blocked.push(b.id);
		}

		// The shared recency-only list fills its window with the 10 newest tickets —
		// all blocked — hiding the ready ones. This is the bug listForSidebar fixes.
		const recency = tickets
			.list(user.id, workspace, { status: 'open', limit: 10 })
			.map((t) => t.id);
		expect(recency).toEqual([...blocked].reverse());
		expect(recency).not.toContain(ready.id);
		expect(recency).not.toContain(prereq.id);

		// listForSidebar prioritizes ready-before-blocked across the full open set,
		// so both ready tickets surface ahead of the blocked overflow.
		const sidebar = tickets.listForSidebar(user.id, workspace, 10).map((t) => t.id);
		expect(sidebar.length).toBe(10);
		expect(sidebar.slice(0, 2)).toEqual([ready.id, prereq.id]);
		expect(sidebar).toContain(ready.id);
		expect(sidebar).toContain(prereq.id);
	});

	it('GET /api/tickets honors the offset query param', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { GET } = await import('../src/routes/api/tickets/+server');
		const user = users.ensureLocalUser();

		for (let i = 0; i < 3; i++) {
			tickets.create(user.id, { workspaceKey: workspace, title: `Api${i}` });
		}
		const ws = encodeURIComponent(workspace);
		const fullRes = (await GET(
			event({
				url: `http://localhost/api/tickets?status=open&limit=100&offset=0&workspace=${ws}`,
				userId: user.id
			}) as never
		)) as Response;
		const full = (await fullRes.json()) as { tickets: { id: string }[] };

		const res = (await GET(
			event({
				url: `http://localhost/api/tickets?status=open&limit=2&offset=1&workspace=${ws}`,
				userId: user.id
			}) as never
		)) as Response;
		const body = (await res.json()) as { tickets: { id: string }[] };
		expect(body.tickets.map((t) => t.id)).toEqual(full.tickets.slice(1, 3).map((t) => t.id));
	});

	it('/tickets page load returns the first page for the current workspace', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { load } = await import('../src/routes/tickets/+page.server');
		const { TICKETS_PAGE_SIZE } = await import('../src/lib/client/tickets-list');
		const user = users.ensureLocalUser();

		for (let i = 0; i < TICKETS_PAGE_SIZE + 5; i++) {
			tickets.create(user.id, { workspaceKey: workspace, title: `Page${i}` });
		}

		const data = (await load({
			locals: { userId: user.id },
			parent: async () => ({ ticketWorkspace: workspace })
		} as never)) as {
			ticketWorkspace: string | null;
			initialTickets: { id: string }[];
			initialHasMore: boolean;
			initialStatus: string;
		};
		expect(data.ticketWorkspace).toBe(workspace);
		expect(data.initialStatus).toBe('open');
		expect(data.initialTickets.length).toBe(TICKETS_PAGE_SIZE);
		expect(data.initialHasMore).toBe(true);

		// No current workspace degrades to an empty list rather than erroring.
		const empty = (await load({
			locals: { userId: user.id },
			parent: async () => ({ ticketWorkspace: null })
		} as never)) as {
			ticketWorkspace: string | null;
			initialTickets: unknown[];
			initialHasMore: boolean;
		};
		expect(empty.ticketWorkspace).toBeNull();
		expect(empty.initialTickets).toEqual([]);
		expect(empty.initialHasMore).toBe(false);
	});

	it('defaults priority to P2, persists a chosen one, and enforces the CHECK constraint', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const { getDb } = await import('../src/lib/server/db');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();

		// Omitted priority falls back to the column default P2.
		const def = tickets.create(user.id, { workspaceKey: workspace, title: 'Default priority' });
		expect(def.priority).toBe('P2');
		expect(tickets.get(def.id, user.id)?.priority).toBe('P2');

		// An explicit priority round-trips through create + get.
		const urgent = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Urgent',
			priority: 'P0'
		});
		expect(urgent.priority).toBe('P0');
		expect(tickets.get(urgent.id, user.id)?.priority).toBe('P0');

		// update changes priority and leaves it untouched when omitted.
		const bumped = tickets.update(def.id, user.id, { priority: 'P1' });
		expect(bumped?.priority).toBe('P1');
		const renamed = tickets.update(def.id, user.id, { title: 'Default priority (renamed)' });
		expect(renamed?.priority).toBe('P1');

		// The DB CHECK rejects an out-of-set priority.
		expect(() =>
			getDb()
				.prepare(
					`INSERT INTO workspace_tickets(
					   id, user_id, workspace_key, title, body, priority, status, created_at, updated_at
					 ) VALUES (999996, ?, ?, 'bad', '', 'P9', 'open', 1, 1)`
				)
				.run(user.id, workspace)
		).toThrow();
	});

	it('listForSidebar orders by priority within a group, ready-before-blocked dominating', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const user = users.ensureLocalUser();

		// A still-open prerequisite used to block a high-priority ticket.
		const prereq = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Prereq',
			priority: 'P3'
		});
		const blockedP0 = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Blocked but urgent',
			priority: 'P0'
		});
		tickets.addDependency(user.id, blockedP0.id, prereq.id);
		const readyP2 = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Ready normal',
			priority: 'P2'
		});
		const readyP0 = tickets.create(user.id, {
			workspaceKey: workspace,
			title: 'Ready urgent',
			priority: 'P0'
		});

		const ordered = tickets.listForSidebar(user.id, workspace, 10).map((t) => t.id);
		// prereq (P3) is ready; readyP0/readyP2 are ready; blockedP0 is blocked.
		// Ready group ordered by priority: readyP0 (P0), readyP2 (P2), prereq (P3);
		// blocked group (only blockedP0) comes last despite being P0.
		expect(ordered).toEqual([readyP0.id, readyP2.id, prereq.id, blockedP0.id]);
	});

	it('agent ticket tools accept, persist, and surface priority', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'Priority tools',
			workdir: workspace,
			model: null
		});
		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: conv.id
		});
		const add = tools.find((t) => t.name === 'ticket_add')!;
		const list = tools.find((t) => t.name === 'ticket_list')!;
		const update = tools.find((t) => t.name === 'ticket_update')!;
		const get = tools.find((t) => t.name === 'ticket_get')!;

		// ticket_add persists an explicit priority and echoes it back.
		const added = await add.handler({ title: 'Ship it', priority: 'P0' });
		expect(added.ok).toBe(true);
		expect(added.ok && (added.result as { priority?: string }).priority).toBe('P0');
		const [created] = tickets.list(user.id, workspace);
		expect(created.priority).toBe('P0');

		// Omitting priority defaults to P2.
		await add.handler({ title: 'Someday' });
		const someday = tickets.list(user.id, workspace).find((t) => t.title === 'Someday')!;
		expect(someday.priority).toBe('P2');

		// Invalid priority is rejected before persisting.
		await expect(add.handler({ title: 'Bad', priority: 'P9' })).rejects.toThrow();

		// ticket_update changes priority.
		const updated = await update.handler({ id: String(created.id), priority: 'P2' });
		expect(updated.ok && (updated.result as { priority?: string }).priority).toBe('P2');
		expect(tickets.get(created.id, user.id)?.priority).toBe('P2');

		// ticket_get returns priority in the compact view.
		const got = await get.handler({ id: String(created.id) });
		expect(got.ok && (got.result as { priority?: string }).priority).toBe('P2');

		// The dense ticket_list output tags every line with its priority.
		const listed = await list.handler({ status: 'all' });
		const rendered = (listed.ok && listed.result) as string;
		for (const line of rendered.split('\n').filter((l) => l.startsWith('- '))) {
			expect(line).toMatch(/\[P[0-3]\]/);
		}
		expect(rendered).toContain('[P2] [open] Ship it');
	});

	it('REST API accepts and returns priority on create, patch, and get', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const { POST, GET } = await import('../src/routes/api/tickets/+server');
		const { PATCH, GET: GET_ONE } = await import('../src/routes/api/tickets/[id]/+server');
		const user = users.ensureLocalUser();

		const createdResponse = await POST(
			event({
				userId: user.id,
				body: { workspace, title: 'API priority', priority: 'P1' }
			}) as never
		);
		const created = await createdResponse.json();
		expect(created.ticket.priority).toBe('P1');

		// Omitting priority defaults to P2.
		const defResponse = await POST(
			event({ userId: user.id, body: { workspace, title: 'API default' } }) as never
		);
		const def = await defResponse.json();
		expect(def.ticket.priority).toBe('P2');

		// Invalid priority is a 400.
		let badStatus: number | undefined;
		try {
			await POST(
				event({ userId: user.id, body: { workspace, title: 'API bad', priority: 'P9' } }) as never
			);
		} catch (e) {
			badStatus = (e as { status?: number }).status;
		}
		expect(badStatus).toBe(400);

		// PATCH changes priority and GET reflects it.
		const patchResponse = await PATCH(
			event({
				userId: user.id,
				params: { id: created.ticket.id },
				body: { priority: 'P3', workspace }
			}) as never
		);
		const patched = await patchResponse.json();
		expect(patched.ticket.priority).toBe('P3');

		const getResponse = await GET_ONE(
			event({ userId: user.id, params: { id: created.ticket.id } }) as never
		);
		const fetched = await getResponse.json();
		expect(fetched.ticket.priority).toBe('P3');

		// The list endpoint includes priority on each row.
		const listResponse = await GET(
			event({
				userId: user.id,
				url: `http://localhost/api/tickets?workspace=${encodeURIComponent(workspace)}`
			}) as never
		);
		const listed = await listResponse.json();
		expect(listed.tickets.every((t: { priority?: string }) => typeof t.priority === 'string')).toBe(
			true
		);
	});
});
