import { describe, it, expect } from 'vitest';

// The liveness probe must answer purely from process state — no DB import,
// no DB query — so the Docker HEALTHCHECK can't be tripped by a transient DB
// hiccup or a long startup migration. This guards that invariant: the module
// returns 200 {ok:true} without any DB setup in scope.
describe('GET /api/health/liveness', () => {
	it('returns 200 {ok:true} without touching the DB', async () => {
		const mod = await import('../../../src/routes/api/health/liveness/+server');
		const res = await mod.GET({} as Parameters<typeof mod.GET>[0]);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ ok: true });
	});

	it('does not statically import the DB layer', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const src = readFileSync(
			fileURLToPath(new URL('../../../src/routes/api/health/liveness/+server.ts', import.meta.url)),
			'utf8'
		);
		// Anchor to `from '…'` import specifiers so an explanatory comment that
		// merely mentions the DB path doesn't trip this guard.
		const dbImport = /\bfrom\s+['"][^'"]*\$lib\/server\/db['"]/;
		expect(src).not.toMatch(dbImport);
	});
});
