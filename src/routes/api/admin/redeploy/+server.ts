import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { parseBody } from '$lib/server/validate';
import { sseResponse } from '$lib/server/sse';
import { audit } from '$lib/server/audit';
import {
	BUILD_STEPS,
	PULL_STEPS,
	canRedeployUser,
	runRedeploy,
	type Step
} from '$lib/server/redeploy';

// `pnpm run verify` overlaps independent lint/check/unit phases, then runs
// one production build and Playwright e2e against that build. The supervisor
// (scripts/serve.mjs) runs the server out of its own `build.live/` copy and
// only refreshes it between restarts, so the build inside verify can overwrite
// `build/` freely without thrashing the chunks the live process is lazy-loading.
// On success we exit and the supervisor relaunches on the refreshed code; on
// failure (lint, type-check, unit tests, build, or e2e) the live tree is
// untouched.
const Body = z.object({ pull: z.boolean().optional().default(true) });

let inFlight = false;

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	const userId = locals.userId;
	const cfg = loadConfig();
	const actorLogin = locals.user?.githubLogin ?? null;
	const actorIp = getClientAddress();
	if (!cfg.ENABLE_REDEPLOY) {
		throw error(403, 'Redeploy disabled. Set ENABLE_REDEPLOY=1 and run via `pnpm run serve`.');
	}
	if (!canRedeployUser(locals.user, cfg)) {
		log.warn('redeploy.forbidden', { userId, login: actorLogin });
		audit({
			event_type: 'redeploy',
			actor_login: actorLogin,
			actor_ip: actorIp,
			resource: 'admin/redeploy',
			outcome: 'denied',
			detail: { reason: 'not_redeploy_admin' }
		});
		throw error(403, 'Redeploy requires an authorized redeploy admin.');
	}
	if (inFlight) throw error(409, 'A redeploy is already in progress.');
	// Claim the guard synchronously, before any `await`, so a second concurrent
	// POST can't slip past the check above while we're parsing the body.
	inFlight = true;

	try {
		const { pull } = await parseBody(request, Body, { allowEmpty: true });

		const steps: Step[] = pull ? [...PULL_STEPS, ...BUILD_STEPS] : BUILD_STEPS;
		log.info('redeploy.start', { userId, pull });
		audit({
			event_type: 'redeploy',
			actor_login: actorLogin,
			actor_ip: actorIp,
			resource: 'admin/redeploy',
			outcome: 'success',
			detail: { pull }
		});

		async function* withInFlightReset() {
			try {
				yield* runRedeploy(steps);
			} finally {
				inFlight = false;
			}
		}

		return sseResponse(withInFlightReset());
	} catch (err) {
		// If anything throws before the generator starts iterating (e.g. body
		// parse error, or a synchronous throw from sseResponse), release the
		// guard here — otherwise the flag would stick true until restart.
		inFlight = false;
		throw err;
	}
};
