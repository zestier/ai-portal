import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupLocalEnv } from './helpers/env';

let workspace: string;

describe('ticket mutation notifier', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-ticket-events-');
		workspace = mkdtempSync(join(tmpdir(), 'portal-ticket-events-ws-'));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it('emits once per logical repo mutation, carrying the user', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { onTicketMutation } = await import('../src/lib/server/db/ticket-mutations');
		const user = users.ensureLocalUser();

		const seen: string[] = [];
		const off = onTicketMutation((m) => seen.push(m.userId));

		try {
			const a = tickets.create(user.id, { workspaceKey: workspace, title: 'A' });
			const b = tickets.create(user.id, { workspaceKey: workspace, title: 'B' });
			tickets.update(a.id, user.id, { status: 'done' });
			tickets.addDependency(user.id, b.id, a.id);
			tickets.removeDependency(user.id, b.id, a.id);
			tickets.remove(b.id, user.id);

			// One signal per top-level mutation — the internal edge inserts during
			// create/update don't each fan out a redundant notification.
			expect(seen.length).toBe(6);
			expect(seen.every((id) => id === user.id)).toBe(true);
		} finally {
			off();
		}
	});

	it('does not emit when a mutation is a no-op', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { onTicketMutation } = await import('../src/lib/server/db/ticket-mutations');
		const user = users.ensureLocalUser();
		const a = tickets.create(user.id, { workspaceKey: workspace, title: 'A' });

		const seen: string[] = [];
		const off = onTicketMutation((m) => seen.push(m.userId));
		try {
			// Removing a non-existent edge and a non-existent ticket both change
			// nothing, so neither should notify.
			expect(tickets.removeDependency(user.id, a.id, 'missing')).toBe(false);
			expect(tickets.remove('does-not-exist', user.id)).toBe(false);
			expect(seen).toEqual([]);
		} finally {
			off();
		}
	});
});

describe('ticket event bridge', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-ticket-bridge-');
		workspace = mkdtempSync(join(tmpdir(), 'portal-ticket-bridge-ws-'));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it('republishes repo mutations as a tickets.changed app-event for the user', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { getAppEventBus } = await import('../src/lib/server/runtime/app-events');
		const { startTicketEventBridge } = await import('../src/lib/server/runtime/ticket-events');
		const user = users.ensureLocalUser();

		startTicketEventBridge();
		const bus = getAppEventBus();

		const ac = new AbortController();
		const out: { type: string }[] = [];
		const iter = (async () => {
			for await (const ev of bus.subscribe(user.id, { signal: ac.signal })) {
				out.push(ev.event);
				if (out.length >= 1) {
					ac.abort();
					break;
				}
			}
		})();
		// Let the subscriber register before the mutation publishes.
		await Promise.resolve();

		tickets.create(user.id, { workspaceKey: workspace, title: 'Ship it' });

		const timer = setTimeout(() => ac.abort(), 1000);
		await iter;
		clearTimeout(timer);

		expect(out).toEqual([{ type: 'tickets.changed' }]);
	});

	it('starts the bridge once (idempotent across calls)', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const tickets = await import('../src/lib/server/db/repos/tickets');
		const { getAppEventBus } = await import('../src/lib/server/runtime/app-events');
		const { startTicketEventBridge } = await import('../src/lib/server/runtime/ticket-events');
		const user = users.ensureLocalUser();

		// Several boots / HMR re-imports must not stack subscribers (which would
		// publish the same event N times).
		startTicketEventBridge();
		startTicketEventBridge();
		startTicketEventBridge();
		const bus = getAppEventBus();

		const ac = new AbortController();
		const out: { type: string }[] = [];
		const iter = (async () => {
			for await (const ev of bus.subscribe(user.id, { signal: ac.signal })) {
				out.push(ev.event);
			}
		})();
		await Promise.resolve();

		tickets.create(user.id, { workspaceKey: workspace, title: 'Once' });

		await new Promise((r) => setTimeout(r, 100));
		ac.abort();
		await iter;

		expect(out).toEqual([{ type: 'tickets.changed' }]);
	});
});
