import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCode, fetchProfile, isAllowed } from '$lib/server/auth/github';
import { upsertGithub } from '$lib/server/db/repos/users';
import { issue } from '$lib/server/auth/session';
import { log } from '$lib/server/log';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const expectedState = cookies.get('oauth_state');
	cookies.delete('oauth_state', { path: '/', secure: url.protocol === 'https:' });

	if (!code || !state || !expectedState || state !== expectedState) {
		log.warn('oauth.state_mismatch');
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
		throw error(502, { message: 'OAuth exchange failed', code: 'oauth_failed' });
	}
	if (!isAllowed(profile.login)) {
		log.warn('oauth.not_allowed', { login: profile.login });
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
	throw redirect(303, '/');
};
