import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { log } from '$lib/server/log';

export const GET: RequestHandler = () => {
	try {
		const r = getDb().prepare('SELECT 1 as ok').get() as { ok: number };
		if (r.ok !== 1) throw new Error('db check failed');
		return json({ ok: true });
	} catch (e) {
		log.error('health.db_check_failed', { error: String(e) });
		return json({ ok: false, status: 'error', error: 'database unavailable' }, { status: 503 });
	}
};
