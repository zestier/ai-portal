import { describe, expect, it, beforeEach } from 'vitest';
import { getDb } from '../../src/lib/server/db';
import { extensionId } from '../../src/lib/ids';
import { setupLocalEnv } from '../helpers/env';

describe('portal extensions repo', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-ext-repo-');
	});

	it('migration creates the table', () => {
		const table = getDb()
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_extensions'`)
			.get();
		expect(table).toBeTruthy();
	});

	it('CRUD, user scoping, status/enabled filters, and sort ordering', async () => {
		const users = await import('../../src/lib/server/db/repos/users');
		const exts = await import('../../src/lib/server/db/repos/extensions');
		const user = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'ext-rival',
			githubId: 991,
			displayName: null,
			avatarUrl: null
		});

		const a = exts.create(user.id, {
			name: 'A',
			kind: 'inline',
			value: 'export default () => 1',
			enabled: true,
			sortOrder: 10
		});
		const b = exts.create(user.id, {
			name: 'B',
			kind: 'package',
			value: 'npm:foo@1.0.0',
			enabled: true,
			sortOrder: 0
		});
		const c = exts.create(user.id, {
			name: 'C',
			kind: 'file',
			value: 'ext.ts',
			enabled: false,
			sortOrder: 5
		});

		// Opaque handles + normalization.
		expect(a.id).toBe(extensionId.encode(extensionId.parse(a.id)));
		expect(a.id).toMatch(/^EX\d+$/);
		expect(a.kind).toBe('inline');
		expect(a.enabled).toBe(true);
		expect(b.value).toBe('npm:foo@1.0.0');
		expect(c.enabled).toBe(false);

		// list(): open DESC, sort_order ASC, id ASC — b(0), c(5), a(10).
		expect(exts.list(user.id).map((e) => e.id)).toEqual([b.id, c.id, a.id]);
		expect(exts.list(user.id, { status: 'all' }).length).toBe(3);
		expect(exts.list(other.id)).toEqual([]);

		// get is scoped by user.
		expect(exts.get(user.id, a.id)?.name).toBe('A');
		expect(exts.get(other.id, a.id)).toBeNull();

		// update + updated_at bump.
		const updated = exts.update(user.id, a.id, { value: 'export default () => 2', sortOrder: 1 });
		expect(updated?.value).toBe('export default () => 2');
		expect(updated?.sortOrder).toBe(1);
		expect(updated?.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);

		// update is scoped: a rival user cannot mutate.
		expect(exts.update(other.id, a.id, { value: 'hacked' })).toBeNull();

		// setEnabled (scoped).
		expect(exts.setEnabled(user.id, a.id, false)?.enabled).toBe(false);
		expect(exts.setEnabled(other.id, a.id, true)).toBeNull();

		// Hard delete (scoped).
		expect(exts.remove(user.id, b.id)).toBe(true);
		expect(exts.get(user.id, b.id)).toBeNull();
		expect(exts.remove(user.id, b.id)).toBe(false);
		expect(exts.remove(other.id, a.id)).toBe(false);
		expect(exts.get(user.id, a.id)).not.toBeNull();
	});

	it('invalid ids throw a precise parse error', async () => {
		const exts = await import('../../src/lib/server/db/repos/extensions');
		expect(() => exts.get(1, 'T10')).toThrow('not a extension id: T10');
	});
});
