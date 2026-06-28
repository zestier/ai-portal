import { error, json } from '@sveltejs/kit';
import { statSync } from 'node:fs';
import type { RequestHandler } from './$types';
import { requireUserId } from '$lib/server/auth/require';
import { loadConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db';
import { canRedeployUser } from '$lib/server/redeploy';
import { getPoolStats } from '$lib/server/runtime/pool';

// WAL header is 32 bytes; each frame is a 24-byte frame header plus one page.
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;

/**
 * GET /api/admin/stats
 *
 * Lightweight observability snapshot for operators. Gated to admins (the same
 * `canRedeployUser` admin set as /api/admin/redeploy), not just any logged-in
 * user — it exposes process and infrastructure internals. Returns:
 *
 *   process   — Node memory breakdown + process uptime in seconds
 *   sessions  — active/in-flight counts + MAX_CONCURRENT_SESSIONS cap
 *   db        — SQLite page_count, page_size, and computed size_bytes;
 *               WAL frame count and WAL size_bytes
 */
export const GET: RequestHandler = ({ locals }) => {
	requireUserId(locals);
	const cfg = loadConfig();
	if (!canRedeployUser(locals.user, cfg)) {
		throw error(403, 'Admin stats require an authorized admin.');
	}

	const mem = process.memoryUsage();
	const pool = getPoolStats();

	const db = getDb();
	const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0;
	const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 0;

	// Read WAL depth without side effects: stat the `-wal` sidecar file rather
	// than running `wal_checkpoint`, which would mutate the DB on every GET.
	// frames = (fileBytes - header) / (frameHeader + pageSize).
	let walSizeBytes = 0;
	try {
		walSizeBytes = statSync(`${db.name}-wal`).size;
	} catch {
		// No `-wal` file — DB isn't in WAL mode or has never been written. Treat as 0.
	}
	const frameStride = pageSize + WAL_FRAME_HEADER_BYTES;
	const walFrames =
		walSizeBytes > WAL_HEADER_BYTES && frameStride > WAL_FRAME_HEADER_BYTES
			? Math.floor((walSizeBytes - WAL_HEADER_BYTES) / frameStride)
			: 0;

	return json({
		process: {
			uptime_s: Math.floor(process.uptime()),
			memory: {
				rss_bytes: mem.rss,
				heap_used_bytes: mem.heapUsed,
				heap_total_bytes: mem.heapTotal,
				external_bytes: mem.external
			}
		},
		sessions: {
			active: pool.active,
			inflight: pool.inflight,
			max: pool.max
		},
		db: {
			page_count: pageCount,
			page_size: pageSize,
			size_bytes: pageCount * pageSize,
			wal_frames: walFrames,
			wal_size_bytes: walSizeBytes
		}
	});
};
