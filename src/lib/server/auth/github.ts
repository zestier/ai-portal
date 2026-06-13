// Minimal GitHub OAuth web flow. No external deps.

import { loadConfig } from '../config';

export interface GithubProfile {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string | null;
}

export function authorizeUrl(state: string, redirectUri: string): string {
	const cfg = loadConfig();
	const params = new URLSearchParams({
		client_id: cfg.GITHUB_CLIENT_ID ?? '',
		redirect_uri: redirectUri,
		scope: 'read:user',
		state,
		allow_signup: 'false'
	});
	return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
	const cfg = loadConfig();
	const res = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({
			client_id: cfg.GITHUB_CLIENT_ID,
			client_secret: cfg.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri
		})
	});
	if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`);
	const body = (await res.json()) as { access_token?: string; error?: string };
	if (!body.access_token) throw new Error(body.error ?? 'no access_token');
	return body.access_token;
}

export async function fetchProfile(token: string): Promise<GithubProfile> {
	const res = await fetch('https://api.github.com/user', {
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/vnd.github+json',
			'user-agent': 'zap'
		}
	});
	if (!res.ok) throw new Error(`GitHub profile fetch failed: ${res.status}`);
	const p = (await res.json()) as GithubProfile;
	return {
		id: p.id,
		// GitHub logins are case-insensitive for identity. Normalize to lowercase at
		// receipt so stored login and allow-list/lookup comparisons stay consistent.
		// Display casing is preserved separately via `name`.
		login: p.login.toLowerCase(),
		name: p.name ?? null,
		avatar_url: p.avatar_url ?? null
	};
}

export function isAllowed(login: string): boolean {
	const cfg = loadConfig();
	return cfg.ALLOWED_GITHUB_LOGINS.includes(login.toLowerCase());
}
