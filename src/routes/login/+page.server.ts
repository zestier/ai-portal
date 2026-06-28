import { redirect } from '@sveltejs/kit';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PageServerLoad, Actions } from './$types';
import { loadConfig } from '$lib/server/config';
import { authorizeUrl } from '$lib/server/auth/github';
import { issue } from '$lib/server/auth/session';
import { FixedWindowRateLimiter } from '$lib/server/rate-limit';
import { audit } from '$lib/server/audit';

// Random per-process key so the digests below can't be precomputed offline.
const SECRET_COMPARE_KEY = randomBytes(32);

/**
 * Constant-time shared-secret comparison. Both inputs are run through HMAC-SHA256
 * first, yielding fixed 32-byte digests, so `timingSafeEqual` never sees unequal
 * lengths and the comparison time can't leak the secret's byte length. Both
 * branches perform identical work regardless of whether the secret matches.
 */
function sharedSecretMatches(input: string, expected: string): boolean {
	const inputMac = createHmac('sha256', SECRET_COMPARE_KEY).update(input).digest();
	const expectedMac = createHmac('sha256', SECRET_COMPARE_KEY).update(expected).digest();
	return timingSafeEqual(inputMac, expectedMac);
}

// Per-IP brute-force throttle: at most 10 failed attempts per 15 minutes.
const loginRateLimiter = new FixedWindowRateLimiter({ windowMs: 15 * 60_000, max: 10 });

// Fixed delay applied to every failed attempt to blunt timing/brute-force probing.
const FAILURE_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const load: PageServerLoad = ({ locals, cookies, url }) => {
	if (locals.userId) throw redirect(302, '/');
	const cfg = loadConfig();
	if (cfg.AUTH_MODE === 'github') {
		const state = randomBytes(16).toString('base64url');
		cookies.set('oauth_state', state, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: 600
		});
		const redirectUri = `${url.origin}/auth/callback`;
		return { mode: 'github' as const, authorizeUrl: authorizeUrl(state, redirectUri) };
	}
	if (cfg.AUTH_MODE === 'shared-secret') {
		return { mode: 'shared-secret' as const };
	}
	return { mode: 'none' as const };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, locals, getClientAddress }) => {
		const cfg = loadConfig();
		if (cfg.AUTH_MODE !== 'shared-secret') {
			return { ok: false, error: 'Shared-secret login is disabled' };
		}
		const ip = getClientAddress();
		if (loginRateLimiter.check(ip).limited) {
			await delay(FAILURE_DELAY_MS);
			audit({
				event_type: 'login',
				actor_login: null,
				actor_ip: ip,
				resource: 'shared-secret',
				outcome: 'denied',
				detail: { reason: 'rate_limited' }
			});
			return { ok: false, error: 'Too many attempts. Please try again later.' };
		}
		const data = await request.formData();
		const secret = String(data.get('secret') ?? '');
		if (!secret || !cfg.SHARED_SECRET || !sharedSecretMatches(secret, cfg.SHARED_SECRET)) {
			loginRateLimiter.record(ip);
			await delay(FAILURE_DELAY_MS);
			audit({
				event_type: 'login',
				actor_login: null,
				actor_ip: ip,
				resource: 'shared-secret',
				outcome: 'failure',
				detail: { reason: 'invalid_secret' }
			});
			return { ok: false, error: 'Invalid secret' };
		}
		loginRateLimiter.reset(ip);
		// Use the local user as the principal in shared-secret mode.
		const { ensureLocalUser } = await import('$lib/server/db/repos/users');
		const user = ensureLocalUser();
		locals.userId = user.id;
		issue(cookies, user.id, url.protocol === 'https:');
		audit({
			event_type: 'login',
			actor_login: user.githubLogin,
			actor_ip: ip,
			resource: 'shared-secret',
			outcome: 'success'
		});
		throw redirect(303, '/');
	}
};
