import { error, redirect } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from './$types';
import { exchangeCode, fetchProfile, isAllowed } from '$lib/server/auth/github';
import { upsertGithub } from '$lib/server/db/repos/users';
import { issue } from '$lib/server/auth/session';
import { log } from '$lib/server/log';
import { audit } from '$lib/server/audit';

export const GET: RequestHandler = async ({ url, cookies, getClientAddress }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const expectedState = cookies.get('oauth_state');
	cookies.delete('oauth_state', { path: '/', secure: url.protocol === 'https:' });
	const ip = getClientAddress();

	if (!code || !state || !expectedState || !statesMatch(state, expectedState)) {
		log.warn('oauth.state_mismatch');
		audit({
			event_type: 'login',
			actor_login: null,
			actor_ip: ip,
			resource: 'github',
			outcome: 'failure',
			detail: { reason: 'state_mismatch' }
		});
		throw error(400, { message: 'OAuth state mismatch', code: 'oauth_state_mismatch' });
	}
	const redirectUri = `${url.origin}/auth/callback`;
	let token: string;
	let profile: Awaited<ReturnType<typeof fetchProfile>>;
	try {
		token = await exchangeCode(code, redirectUri);
		profile = await fetchProfile(token);
	} catch (e) {
		log.warn('oauth.failed', { err: String(e) });
		audit({
			event_type: 'login',
			actor_login: null,
			actor_ip: ip,
			resource: 'github',
			outcome: 'failure',
			detail: { reason: 'exchange_failed' }
		});
		throw error(502, { message: 'OAuth exchange failed', code: 'oauth_failed' });
	}
	if (!isAllowed(profile.login)) {
		log.warn('oauth.not_allowed', { login: profile.login });
		audit({
			event_type: 'login',
			actor_login: profile.login,
			actor_ip: ip,
			resource: 'github',
			outcome: 'denied',
			detail: { reason: 'not_on_allow_list' }
		});
		throw error(403, { message: 'GitHub login is not on the allow-list', code: 'forbidden' });
	}
	const user = upsertGithub({
		githubLogin: profile.login,
		githubId: profile.id,
		displayName: profile.name,
		avatarUrl: profile.avatar_url
	});
	// We intentionally do NOT persist the OAuth access token. With the
	// default scope=read:user it has no Copilot entitlement and the SDK
	// falls back to host CLI creds anyway, so storing it would just keep
	// an encrypted-but-useless credential at rest. Operators who widen
	// the scope and want to forward the token to the SDK can plumb their
	// own setGithubToken() call here.
	issue(cookies, user.id, url.protocol === 'https:');
	audit({
		event_type: 'login',
		actor_login: user.githubLogin,
		actor_ip: ip,
		resource: 'github',
		outcome: 'success'
	});
	throw redirect(303, '/');
};

function statesMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
