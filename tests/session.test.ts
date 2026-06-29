import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { resetConfigForTests } from '../src/lib/server/config';
import {
	sign,
	verify,
	issue,
	read,
	clear,
	generateCsrfToken,
	issueOAuthState,
	readOAuthState,
	clearOAuthState
} from '../src/lib/server/auth/session';
import type { Cookies } from '@sveltejs/kit';

function makeCookies(initial: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initial));
	const deleted: string[] = [];
	const deleteOpts = new Map<string, Record<string, unknown>>();
	const cookies = {
		get: (name: string) => store.get(name),
		set: (name: string, value: string) => store.set(name, value),
		delete: (name: string, opts?: Record<string, unknown>) => {
			deleted.push(name);
			deleteOpts.set(name, opts ?? {});
			store.delete(name);
		}
	} as unknown as Cookies;
	return { cookies, store, deleted, deleteOpts };
}

const SECURE_COOKIE = '__Host-portal_session';
const DEV_COOKIE = 'portal_session';

describe('session signing', () => {
	beforeEach(() => {
		process.env.HOST = '127.0.0.1';
		process.env.AUTH_MODE = 'shared-secret';
		process.env.SHARED_SECRET = 'x'.repeat(32);
		process.env.SESSION_SECRET = randomBytes(48).toString('base64');
		process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
		resetConfigForTests();
	});

	it('round-trips valid claims', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now, exp: now + 60 });
		expect(verify(tok)?.sub).toBe('u1');
	});

	it('rejects expired tokens', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now - 100, exp: now - 10 });
		expect(verify(tok)).toBeNull();
	});

	it('rejects tampered tokens', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now, exp: now + 60 });
		const [p, s] = tok.split('.');
		const bad = `${p}A.${s}`;
		expect(verify(bad)).toBeNull();
	});
});

describe('session cookie read/clear', () => {
	beforeEach(() => {
		process.env.HOST = '127.0.0.1';
		process.env.AUTH_MODE = 'shared-secret';
		process.env.SHARED_SECRET = 'x'.repeat(32);
		process.env.SESSION_SECRET = randomBytes(48).toString('base64');
		process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
		resetConfigForTests();
	});

	it('secure read does NOT accept the non-__Host- dev cookie', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now, exp: now + 60 });
		const { cookies } = makeCookies({ [DEV_COOKIE]: tok });
		expect(read(cookies, true)).toBeNull();
	});

	it('secure read accepts the __Host- cookie', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now, exp: now + 60 });
		const { cookies } = makeCookies({ [SECURE_COOKIE]: tok });
		expect(read(cookies, true)?.sub).toBe('u1');
	});

	it('non-secure read falls back to either cookie name', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now, exp: now + 60 });
		const { cookies: c1 } = makeCookies({ [DEV_COOKIE]: tok });
		expect(read(c1, false)?.sub).toBe('u1');
		const { cookies: c2 } = makeCookies({ [SECURE_COOKIE]: tok });
		expect(read(c2, false)?.sub).toBe('u1');
	});

	it('clear deletes both cookie names regardless of secure flag', () => {
		const { cookies, deleted, deleteOpts } = makeCookies();
		clear(cookies, true);
		expect(deleted).toContain(SECURE_COOKIE);
		expect(deleted).toContain(DEV_COOKIE);
		// The __Host- cookie must be cleared with secure+path=/, or the browser
		// rejects the deletion Set-Cookie and the session cookie survives.
		expect(deleteOpts.get(SECURE_COOKIE)).toMatchObject({ path: '/', secure: true });

		const { cookies: c2, deleted: d2, deleteOpts: o2 } = makeCookies();
		clear(c2, false);
		expect(d2).toContain(SECURE_COOKIE);
		expect(d2).toContain(DEV_COOKIE);
		expect(o2.get(SECURE_COOKIE)).toMatchObject({ path: '/', secure: true });
	});

	it('logout via clear makes a subsequent secure read fail', () => {
		const { cookies } = makeCookies();
		issue(cookies, 'u1', true);
		expect(read(cookies, true)?.sub).toBe('u1');
		clear(cookies, true);
		expect(read(cookies, true)).toBeNull();
	});
});

describe('OAuth state cookie scoping', () => {
	const SECURE = '__Host-oauth_state';
	const DEV = 'oauth_state';

	it('issues the __Host- prefixed cookie over HTTPS', () => {
		const { cookies, store } = makeCookies();
		issueOAuthState(cookies, 's1', true);
		expect(store.get(SECURE)).toBe('s1');
		expect(store.has(DEV)).toBe(false);
	});

	it('issues the dev-named cookie over http', () => {
		const { cookies, store } = makeCookies();
		issueOAuthState(cookies, 's1', false);
		expect(store.get(DEV)).toBe('s1');
		expect(store.has(SECURE)).toBe(false);
	});

	it('secure read does NOT accept an injected non-__Host- cookie', () => {
		const { cookies } = makeCookies({ [DEV]: 'attacker' });
		expect(readOAuthState(cookies, true)).toBeNull();
	});

	it('secure read accepts the __Host- cookie', () => {
		const { cookies } = makeCookies({ [SECURE]: 's1' });
		expect(readOAuthState(cookies, true)).toBe('s1');
	});

	it('non-secure read falls back to either cookie name', () => {
		const { cookies: c1 } = makeCookies({ [DEV]: 's1' });
		expect(readOAuthState(c1, false)).toBe('s1');
		const { cookies: c2 } = makeCookies({ [SECURE]: 's1' });
		expect(readOAuthState(c2, false)).toBe('s1');
	});

	it('clear deletes both names; __Host- with secure+path=/', () => {
		const { cookies, deleted, deleteOpts } = makeCookies();
		clearOAuthState(cookies);
		expect(deleted).toContain(SECURE);
		expect(deleted).toContain(DEV);
		expect(deleteOpts.get(SECURE)).toMatchObject({ path: '/', secure: true });
	});
});

function decodeExp(token: string): number {
	const [payload] = token.split('.');
	const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	return claims.exp;
}

describe('session TTL config', () => {
	beforeEach(() => {
		process.env.HOST = '127.0.0.1';
		process.env.AUTH_MODE = 'shared-secret';
		process.env.SHARED_SECRET = 'x'.repeat(32);
		process.env.SESSION_SECRET = randomBytes(48).toString('base64');
		process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
		delete process.env.SESSION_TTL_SECONDS;
		resetConfigForTests();
	});

	it('defaults to a 30-day session lifetime', () => {
		const { cookies } = makeCookies();
		const now = Math.floor(Date.now() / 1000);
		const tok = issue(cookies, 'u1', true);
		expect(decodeExp(tok)).toBeCloseTo(now + 60 * 60 * 24 * 30, -1);
	});

	it('honors SESSION_TTL_SECONDS for newly issued sessions', () => {
		process.env.SESSION_TTL_SECONDS = '3600';
		resetConfigForTests();
		const { cookies } = makeCookies();
		const now = Math.floor(Date.now() / 1000);
		const tok = issue(cookies, 'u1', true);
		expect(decodeExp(tok)).toBeCloseTo(now + 3600, -1);
	});

	it('does not invalidate existing cookies with a longer exp when TTL is shortened', () => {
		const now = Math.floor(Date.now() / 1000);
		const existing = sign({ sub: 'u1', iat: now, exp: now + 60 * 60 * 24 * 30 });
		process.env.SESSION_TTL_SECONDS = '3600';
		resetConfigForTests();
		expect(verify(existing)?.sub).toBe('u1');
	});
});

describe('CSRF token entropy', () => {
	beforeEach(() => {
		process.env.HOST = '127.0.0.1';
		process.env.AUTH_MODE = 'shared-secret';
		process.env.SHARED_SECRET = 'x'.repeat(32);
		process.env.SESSION_SECRET = randomBytes(48).toString('base64');
		process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
		resetConfigForTests();
	});

	it('generates 32 bytes (256 bits) of entropy', () => {
		const tok = generateCsrfToken();
		expect(Buffer.from(tok, 'base64url').length).toBe(32);
	});
});
