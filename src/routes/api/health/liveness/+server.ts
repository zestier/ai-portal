import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Liveness probe: "is the process up and serving HTTP?" — deliberately
// DB-free. The Docker HEALTHCHECK polls this so a transient DB hiccup (or a
// long-running startup migration) can't mark the container unhealthy and
// trigger a restart mid-migration. Readiness ("is the DB reachable and the
// schema current?") lives at `/api/health`, which the orchestrator/origin
// checks can use to decide whether to route traffic.
export const GET: RequestHandler = () => json({ ok: true });
