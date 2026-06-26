import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupLocalEnv } from './helpers/env';

let workspace: string;

function event(opts: {
	url?: string;
	userId: string | null;
	body?: unknown;
	params?: Record<string, string>;
}) {
	return {
		locals: { userId: opts.userId },
		params: opts.params ?? {},
		url: new URL(opts.url ?? 'http://localhost/api/tickets'),
		request: new Request(opts.url ?? 'http://localhost/api/tickets', {
			method: opts.body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		})
	};
}

describe('workspace tickets', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-tickets-');
		workspace = mkdtempSync(join(tmpdir(), 'portal-ticket-workspace-'));
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
					 ) VALUES ('bad-status', ?, ?, 'bad', '', 'invalid', 1, 1)`
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
		expect(listed.tickets.map((t: { id: string }) => t.id)).toEqual([created.ticket.id]);

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

	it('agent ticket tools are scoped to the active user and workspace', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			id: 'conv-ticket-test',
			title: 'Ticket tools',
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

		await add.handler({ title: 'Remember this' });
		const [ticket] = tickets.list(user.id, workspace);
		expect(ticket.title).toBe('Remember this');
		expect(ticket.sourceConversationId).toBe('conv-ticket-test');
		await update.handler({ id: ticket.id, status: 'done' });
		const listed = await list.handler({ status: 'all' });
		expect(listed.ok).toBe(true);
		expect(listed.ok && listed.result).toContain('[done] Remember this');

		// ticket_list with no fields keeps the dense hand-rendered string.
		expect(typeof (listed.ok && listed.result)).toBe('string');

		// "default" behaves like omitting fields -> same dense string.
		const listedDefault = await list.handler({ status: 'all', fields: 'default' });
		expect(listedDefault.ok && listedDefault.result).toBe(listed.ok && listed.result);

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
		const compact = await get.handler({ id: ticket.id });
		const compactData = compact.ok && (compact.result as Record<string, unknown>);
		expect(compactData).toMatchObject({ id: ticket.id, title: 'Remember this' });
		expect(compactData).not.toHaveProperty('createdAt');
		expect((compactData as { _omitted?: string[] })._omitted).toContain('createdAt');

		// "default" on ticket_get matches the omitted-fields compact result.
		const compactDefault = await get.handler({ id: ticket.id, fields: 'default' });
		expect(compactDefault.ok && compactDefault.result).toEqual(compactData);

		const picked = await get.handler({ id: ticket.id, fields: ['createdAt'] });
		const pickedData = picked.ok && (picked.result as Record<string, unknown>);
		expect(pickedData).toHaveProperty('createdAt');
		expect(pickedData).not.toHaveProperty('title');
		expect(pickedData).not.toHaveProperty('_omitted');

		const all = await get.handler({ id: ticket.id, fields: 'all' });
		const allData = all.ok && (all.result as Record<string, unknown>);
		expect(allData).toHaveProperty('workspaceKey', workspace);

		// plan: settable via ticket_update, omitted from the compact view, and
		// fetched on demand through the fields selector (the showcase use case).
		await update.handler({ id: ticket.id, plan: '1. wire it\n2. test it' });
		const compactNoPlan = await get.handler({ id: ticket.id });
		expect(
			compactNoPlan.ok && (compactNoPlan.result as Record<string, unknown>)
		).not.toHaveProperty('plan');
		const planOnly = await get.handler({ id: ticket.id, fields: ['plan'] });
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
			id: 'conv-deps-test',
			title: 'Deps',
			workdir: workspace,
			model: null
		});
		const otherWorkspace = mkdtempSync(join(tmpdir(), 'portal-ticket-deps-other-'));
		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: conv.id
		});
		const list = tools.find((t) => t.name === 'ticket_list')!;
		const get = tools.find((t) => t.name === 'ticket_get')!;
		const block = tools.find((t) => t.name === 'ticket_block')!;
		const unblock = tools.find((t) => t.name === 'ticket_unblock')!;

		const api = tickets.create(user.id, { workspaceKey: workspace, title: 'Build API' });
		const ui = tickets.create(user.id, { workspaceKey: workspace, title: 'Build UI' });
		const foreign = tickets.create(user.id, { workspaceKey: otherWorkspace, title: 'Elsewhere' });

		// UI depends on API: UI is blocked, API is not.
		const blocked = await block.handler({ id: ui.id, blockedBy: api.id });
		expect(blocked.ok).toBe(true);
		expect(tickets.openBlockers(ui.id)).toEqual([api.id]);
		expect(tickets.listDependents(api.id)).toEqual([ui.id]);

		// Re-blocking is an idempotent no-op.
		const again = await block.handler({ id: ui.id, blockedBy: api.id });
		expect(again.ok && (again.result as { result: string }).result).toBe('exists');

		// Self-edge and cycle are rejected.
		expect((await block.handler({ id: ui.id, blockedBy: ui.id })).ok).toBe(false);
		const cycle = await block.handler({ id: api.id, blockedBy: ui.id });
		expect(cycle.ok).toBe(false);
		expect(!cycle.ok && cycle.error.message).toMatch(/cycle/i);

		// Cross-workspace pairing is rejected (foreign ticket isn't in this workspace).
		expect((await block.handler({ id: ui.id, blockedBy: foreign.id })).ok).toBe(false);

		// Dense ticket_list flags the blocked ticket inline.
		const listed = await list.handler({});
		expect(listed.ok && (listed.result as string)).toContain(`(blocked by: ${api.id})`);

		// ticket_get exposes blockedBy/blocks via the fields selector.
		const uiBlockers = await get.handler({ id: ui.id, fields: ['blockedBy'] });
		expect(uiBlockers.ok && (uiBlockers.result as { blockedBy: string[] }).blockedBy).toEqual([
			api.id
		]);

		// The compact ticket_get view shows blockers/dependents inline (no fields
		// needed) when present: UI is blocked by API; API blocks UI.
		const uiCompact = await get.handler({ id: ui.id });
		expect(uiCompact.ok && (uiCompact.result as { blockedBy?: string[] }).blockedBy).toEqual([
			api.id
		]);
		const apiCompact = await get.handler({ id: api.id });
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
		const uiReady = await get.handler({ id: ui.id });
		expect(uiReady.ok && (uiReady.result as Record<string, unknown>)).not.toHaveProperty(
			'blockedBy'
		);

		// Unblock removes the edge; a second unblock reports nothing to remove.
		expect((await unblock.handler({ id: ui.id, blockedBy: api.id })).ok).toBe(true);
		expect(tickets.listDependencies(ui.id)).toEqual([]);
		expect((await unblock.handler({ id: ui.id, blockedBy: api.id })).ok).toBe(false);

		rmSync(otherWorkspace, { recursive: true, force: true });
	});
});
