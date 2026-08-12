import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

// Small PNG magic bytes for testing image MIME sniffing
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const TEXT_BYTES = Buffer.from('hello world\n', 'utf8');

async function imports() {
	const users = await import('../src/lib/server/db/repos/users');
	const tickets = await import('../src/lib/server/db/repos/tickets');
	const repo = await import('../src/lib/server/db/repos/ticket-attachments');
	const db = await import('../src/lib/server/db');
	return { users, tickets, repo, db };
}

describe('ticket attachments repo (DB)', () => {
	let workspace: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-ticket-attach-');
		workspace = makeTmpDir('portal-ticket-attach-ws-');
	});

	it('inserts and lists metadata for a ticket', async () => {
		const { users, tickets, repo } = await imports();
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Attach test' });

		const meta = repo.insert({
			ticketId: ticket.id,
			filename: 'shot.png',
			mimeType: 'image/png',
			byteSize: PNG_BYTES.length,
			sourcePath: null,
			data: PNG_BYTES
		});

		expect(meta.id).toBeTruthy();
		expect(meta.ticketId).toBe(ticket.id);
		expect(meta.filename).toBe('shot.png');
		expect(meta.mimeType).toBe('image/png');
		expect(meta.byteSize).toBe(PNG_BYTES.length);
		expect(meta.createdAt).toBeTypeOf('number');

		const list = repo.listMetaForTicket(ticket.id);
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(meta.id);
		expect(list[0].filename).toBe('shot.png');
	});

	it('countForTicket returns correct count', async () => {
		const { users, tickets, repo } = await imports();
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Count test' });

		expect(repo.countForTicket(ticket.id)).toBe(0);

		repo.insert({
			ticketId: ticket.id,
			filename: 'a.txt',
			mimeType: 'text/plain',
			byteSize: 1,
			sourcePath: null,
			data: Buffer.from('a')
		});
		expect(repo.countForTicket(ticket.id)).toBe(1);

		repo.insert({
			ticketId: ticket.id,
			filename: 'b.txt',
			mimeType: 'text/plain',
			byteSize: 1,
			sourcePath: null,
			data: Buffer.from('b')
		});
		expect(repo.countForTicket(ticket.id)).toBe(2);
	});

	it('getForOwner returns bytes for correct owner and null for others', async () => {
		const { users, tickets, repo } = await imports();
		const user = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'attach-rival',
			githubId: 9001,
			displayName: null,
			avatarUrl: null
		});
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Owner test' });

		const meta = repo.insert({
			ticketId: ticket.id,
			filename: 'shot.png',
			mimeType: 'image/png',
			byteSize: PNG_BYTES.length,
			sourcePath: null,
			data: PNG_BYTES
		});

		const found = repo.getForOwner(ticket.id, meta.id, user.id);
		expect(found).not.toBeNull();
		expect(found!.data.equals(PNG_BYTES)).toBe(true);
		expect(found!.mimeType).toBe('image/png');
		expect(found!.filename).toBe('shot.png');

		// Wrong user can't see it
		expect(repo.getForOwner(ticket.id, meta.id, other.id)).toBeNull();

		// Wrong ticket id can't see it
		const otherTicket = tickets.create(user.id, { workspaceKey: workspace, title: 'Other' });
		expect(repo.getForOwner(otherTicket.id, meta.id, user.id)).toBeNull();
	});

	it('remove deletes the attachment and returns true, false when missing', async () => {
		const { users, tickets, repo } = await imports();
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Remove test' });

		const meta = repo.insert({
			ticketId: ticket.id,
			filename: 'log.txt',
			mimeType: 'text/plain',
			byteSize: TEXT_BYTES.length,
			sourcePath: null,
			data: TEXT_BYTES
		});

		expect(repo.listMetaForTicket(ticket.id)).toHaveLength(1);
		expect(repo.remove(ticket.id, meta.id, user.id)).toBe(true);
		expect(repo.listMetaForTicket(ticket.id)).toHaveLength(0);

		// Second remove returns false
		expect(repo.remove(ticket.id, meta.id, user.id)).toBe(false);
	});

	it('cascade delete: removing a ticket removes its attachments', async () => {
		const { users, tickets, repo, db } = await imports();
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Cascade test' });

		repo.insert({
			ticketId: ticket.id,
			filename: 'shot.png',
			mimeType: 'image/png',
			byteSize: PNG_BYTES.length,
			sourcePath: null,
			data: PNG_BYTES
		});

		const handle = db.getDb();
		expect(repo._countForTicket(handle, ticket.id)).toBe(1);

		handle.prepare('DELETE FROM workspace_tickets WHERE id = ?').run(ticket.id);
		expect(repo._countForTicket(handle, ticket.id)).toBe(0);
	});

	it('MAX_BYTE_SIZE is 10 MB, MAX_PER_TICKET is 20', async () => {
		const { repo } = await imports();
		expect(repo.MAX_BYTE_SIZE).toBe(10 * 1024 * 1024);
		expect(repo.MAX_PER_TICKET).toBe(20);
	});

	it('orders attachments by created_at ASC, id ASC', async () => {
		const { users, tickets, repo } = await imports();
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Order test' });

		const m1 = repo.insert({
			ticketId: ticket.id,
			filename: 'a.txt',
			mimeType: 'text/plain',
			byteSize: 1,
			sourcePath: null,
			data: Buffer.from('a')
		});
		const m2 = repo.insert({
			ticketId: ticket.id,
			filename: 'b.txt',
			mimeType: 'text/plain',
			byteSize: 1,
			sourcePath: null,
			data: Buffer.from('b')
		});

		const list = repo.listMetaForTicket(ticket.id);
		expect(list.map((a) => a.id)).toEqual([m1.id, m2.id]);
	});
});

describe('ticket_attach tool cap enforcement', () => {
	let workspace: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-ticket-attach-cap-');
		workspace = makeTmpDir('portal-ticket-attach-cap-ws-');
	});

	it('rejects files over MAX_BYTE_SIZE', async () => {
		const { users, tickets } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Size limit' });

		const bigFile = join(workspace, 'big.bin');
		writeFileSync(bigFile, Buffer.alloc(10 * 1024 * 1024 + 1, 0));

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const attach = tools.find((t) => t.name === 'ticket_attach')!;

		const result = await attach.handler({ ticketId: String(ticket.id), path: bigFile });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe('file_too_large');
	});

	it('rejects when per-ticket limit is reached', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Count limit' });

		for (let i = 0; i < 20; i++) {
			repo.insert({
				ticketId: ticket.id,
				filename: `f${i}.txt`,
				mimeType: 'text/plain',
				byteSize: 1,
				sourcePath: null,
				data: Buffer.from('x')
			});
		}

		const smallFile = join(workspace, 'small.txt');
		writeFileSync(smallFile, 'hi');

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const attach = tools.find((t) => t.name === 'ticket_attach')!;

		const result = await attach.handler({ ticketId: String(ticket.id), path: smallFile });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe('attachment_limit');
	});

	it('attaches a file successfully and returns metadata', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Attach ok' });

		const pngFile = join(workspace, 'shot.png');
		writeFileSync(pngFile, PNG_BYTES);

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const attach = tools.find((t) => t.name === 'ticket_attach')!;

		const result = await attach.handler({ ticketId: String(ticket.id), path: pngFile });
		expect(result.ok).toBe(true);
		expect(result.ok && (result.result as { mimeType: string }).mimeType).toBe('image/png');
		expect(repo.countForTicket(ticket.id)).toBe(1);
		const [meta] = repo.listMetaForTicket(ticket.id);
		expect(meta.filename).toBe('shot.png');
	});

	it('sanitizes an SVG attachment at upload (stored bytes carry no script)', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'SVG attach' });

		const svgFile = join(workspace, 'icon.svg');
		writeFileSync(
			svgFile,
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect/></svg>'
		);

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const attach = tools.find((t) => t.name === 'ticket_attach')!;

		const result = await attach.handler({ ticketId: String(ticket.id), path: svgFile });
		expect(result.ok).toBe(true);
		expect(result.ok && (result.result as { mimeType: string }).mimeType).toBe('image/svg+xml');
		const [meta] = repo.listMetaForTicket(ticket.id);
		const stored = repo.getForOwner(ticket.id, meta.id, user.id)!;
		const text = stored.data.toString('utf-8');
		expect(text).not.toMatch(/<script/i);
		expect(text).not.toMatch(/onload/i);
		expect(text).toContain('<rect');
	});

	it('returns error for non-existent file', async () => {
		const { users, tickets } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Missing file' });

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const attach = tools.find((t) => t.name === 'ticket_attach')!;

		const result = await attach.handler({
			ticketId: String(ticket.id),
			path: join(workspace, 'nonexistent.png')
		});
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe('read_error');
	});

	it('derivePermissionRequest returns read permission for existing file', async () => {
		const { users, tickets } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Perm test' });

		const pngFile = join(workspace, 'shot.png');
		writeFileSync(pngFile, PNG_BYTES);

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const attach = tools.find((t) => t.name === 'ticket_attach')!;

		const req = attach.derivePermissionRequest!({ ticketId: String(ticket.id), path: pngFile });
		expect(req).not.toBeNull();
		expect(req!.permissionKind).toBe('read');
		expect(req!.path).toBe(pngFile);
	});

	it('derivePermissionRequest handles non-existent path without throwing', async () => {
		const { users, tickets } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Perm missing' });

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const attach = tools.find((t) => t.name === 'ticket_attach')!;

		const req = attach.derivePermissionRequest!({
			ticketId: String(ticket.id),
			path: join(workspace, 'missing.png')
		});
		expect(req).not.toBeNull();
		expect(req!.permissionKind).toBe('read');
	});
});

describe('ticket_detach and ticket_view_attachment tools', () => {
	let workspace: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-ticket-attach-view-');
		workspace = makeTmpDir('portal-ticket-attach-view-ws-');
	});

	it('ticket_detach removes an attachment', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Detach test' });

		const meta = repo.insert({
			ticketId: ticket.id,
			filename: 'log.txt',
			mimeType: 'text/plain',
			byteSize: TEXT_BYTES.length,
			sourcePath: null,
			data: TEXT_BYTES
		});

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const detach = tools.find((t) => t.name === 'ticket_detach')!;

		const result = await detach.handler({
			ticketId: String(ticket.id),
			attachmentId: String(meta.id)
		});
		expect(result.ok).toBe(true);
		expect(repo.listMetaForTicket(ticket.id)).toHaveLength(0);
	});

	it('ticket_detach returns not_found for missing attachment', async () => {
		const { users, tickets } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Detach missing' });

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const detach = tools.find((t) => t.name === 'ticket_detach')!;

		const result = await detach.handler({ ticketId: String(ticket.id), attachmentId: '999999' });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe('not_found');
	});

	it('ticket_view_attachment returns text content for text files', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'View text' });

		const meta = repo.insert({
			ticketId: ticket.id,
			filename: 'notes.txt',
			mimeType: 'text/plain',
			byteSize: TEXT_BYTES.length,
			sourcePath: null,
			data: TEXT_BYTES
		});

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const view = tools.find((t) => t.name === 'ticket_view_attachment')!;

		const result = await view.handler({
			ticketId: String(ticket.id),
			attachmentId: String(meta.id)
		});
		expect(result.ok).toBe(true);
		expect(result.ok && result.result).toBe('hello world\n');
	});

	it('ticket_view_attachment returns binary+base64 for images', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'View image' });

		const meta = repo.insert({
			ticketId: ticket.id,
			filename: 'shot.png',
			mimeType: 'image/png',
			byteSize: PNG_BYTES.length,
			sourcePath: null,
			data: PNG_BYTES
		});

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const view = tools.find((t) => t.name === 'ticket_view_attachment')!;

		const result = await view.handler({
			ticketId: String(ticket.id),
			attachmentId: String(meta.id)
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.binary).toBeDefined();
		expect(result.binary).toHaveLength(1);
		expect(result.binary![0].type).toBe('image');
		expect(result.binary![0].mimeType).toBe('image/png');
		expect(result.binary![0].data).toBe(PNG_BYTES.toString('base64'));
	});

	it('ticket_view_attachment ownership check: other user sees not_found', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'view-rival',
			githubId: 9002,
			displayName: null,
			avatarUrl: null
		});
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Ownership' });

		const meta = repo.insert({
			ticketId: ticket.id,
			filename: 'shot.png',
			mimeType: 'image/png',
			byteSize: PNG_BYTES.length,
			sourcePath: null,
			data: PNG_BYTES
		});

		// Other user's tools: ticket belongs to `user`, so ticket lookup fails
		const tools = buildTicketTools({
			userId: other.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const view = tools.find((t) => t.name === 'ticket_view_attachment')!;

		const result = await view.handler({
			ticketId: String(ticket.id),
			attachmentId: String(meta.id)
		});
		expect(result.ok).toBe(false);
	});

	it('ticket_view_attachment has permissionBehavior never-prompt', async () => {
		const { users } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const view = tools.find((t) => t.name === 'ticket_view_attachment')!;
		expect(view.permissionBehavior).toBe('never-prompt');
	});
});

describe('ticket_get includes attachments metadata', () => {
	let workspace: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-ticket-get-attach-');
		workspace = makeTmpDir('portal-ticket-get-attach-ws-');
	});

	it('includes attachments when present', async () => {
		const { users, tickets, repo } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'Get attach' });

		repo.insert({
			ticketId: ticket.id,
			filename: 'shot.png',
			mimeType: 'image/png',
			byteSize: PNG_BYTES.length,
			sourcePath: null,
			data: PNG_BYTES
		});

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const get = tools.find((t) => t.name === 'ticket_get')!;
		const result = await get.handler({ id: String(ticket.id) });
		expect(result.ok).toBe(true);
		const data = result.ok && (result.result as Record<string, unknown>);
		expect(data).toHaveProperty('attachments');
		const attachments = (data as { attachments: Array<{ filename: string }> }).attachments;
		expect(attachments).toHaveLength(1);
		expect(attachments[0].filename).toBe('shot.png');
	});

	it('omits attachments field when there are none', async () => {
		const { users, tickets } = await imports();
		const { buildTicketTools } = await import('../src/lib/server/tools/tickets');
		const user = users.ensureLocalUser();
		const ticket = tickets.create(user.id, { workspaceKey: workspace, title: 'No attachments' });

		const tools = buildTicketTools({
			userId: user.id,
			workspaceKey: workspace,
			conversationId: 1
		});
		const get = tools.find((t) => t.name === 'ticket_get')!;
		const result = await get.handler({ id: String(ticket.id) });
		expect(result.ok).toBe(true);
		const data = result.ok && (result.result as Record<string, unknown>);
		expect(data).not.toHaveProperty('attachments');
	});
});
