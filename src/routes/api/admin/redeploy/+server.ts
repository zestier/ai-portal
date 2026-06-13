import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { requireUserId } from '$lib/server/auth/require';
import { parseBody } from '$lib/server/validate';
import { sseResponse } from '$lib/server/sse';
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

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = requireUserId(locals);
	const cfg = loadConfig();
	if (!cfg.ENABLE_REDEPLOY) {
		throw error(403, 'Redeploy disabled. Set ENABLE_REDEPLOY=1 and run via `pnpm run serve`.');
	}
	if (!canRedeployUser(locals.user, cfg)) {
		log.warn('redeploy.forbidden', { userId, login: locals.user?.githubLogin ?? null });
		throw error(403, 'Redeploy requires an authorized redeploy admin.');
	}
	if (inFlight) throw error(409, 'A redeploy is already in progress.');

	const { pull } = await parseBody(request, Body, { allowEmpty: true });

	const steps: Step[] = pull ? [...PULL_STEPS, ...BUILD_STEPS] : BUILD_STEPS;
	inFlight = true;
	log.info('redeploy.start', { userId, pull });

	async function* withInFlightReset() {
		try {
			yield* runRedeploy(steps);
		} finally {
			inFlight = false;
		}
	}

	return sseResponse(withInFlightReset());
};
