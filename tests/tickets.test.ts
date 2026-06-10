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

		await add.handler({ title: 'Remember this' });
		const [ticket] = tickets.list(user.id, workspace);
		expect(ticket.title).toBe('Remember this');
		expect(ticket.sourceConversationId).toBe('conv-ticket-test');
		await update.handler({ id: ticket.id, status: 'done' });
		const listed = await list.handler({ status: 'all' });
		expect(listed.ok).toBe(true);
		expect(listed.ok && listed.result).toContain('[done] Remember this');
	});
});
