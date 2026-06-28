import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Handle } from '@sveltejs/kit';
import { setupAuthedEnv, setupLocalEnv } from './helpers/env';

type HandleEvent = Parameters<Handle>[0]['event'];

/**
 * Exercises the SvelteKit `handle` hook directly. The auth gate is the
 * single enforcement point for API authentication; these tests guard the
 * invariant.
 */

function makeEvent(opts: {
	path: string;
	method?: string;
	origin?: string;
	csrfHeader?: string;
	csrfCookie?: string;
}): HandleEvent {
	const url = new URL(`http://127.0.0.1${opts.path}`);
	const headers = new Headers();
	if (opts.origin) headers.set('origin', opts.origin);
	if (opts.csrfHeader !== undefined) headers.set('x-csrf-token', opts.csrfHeader);
	const request = new Request(url, {
		method: opts.method ?? 'GET',
		headers
	});
	// Cast through unknown — we only populate the fields the `handle` hook
	// actually reads. The non-secure (http) CSRF cookie name is `portal_csrf`.
	return {
		url,
		request,
		cookies: {
			get: (name: string) => (name === 'portal_csrf' ? (opts.csrfCookie ?? undefined) : undefined),
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		locals: {} as App.Locals,
		getClientAddress: () => '127.0.0.1',
		params: {},
		route: { id: null },
		setHeaders: () => {},
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false
	} as unknown as HandleEvent;
}

async function loadHandle() {
	// Lazy import after env is set, and reset modules first so any
	// previous test's hooks.server (with its boot()-time config snapshot)
	// is discarded — otherwise switching between authed/no-auth modes
	// inside a single test file would silently keep the old auth gate.
	vi.resetModules();
	const mod = await import('../src/hooks.server');
	return mod.handle;
}

describe('hooks auth gate', () => {
	beforeEach(async () => {
		await setupAuthedEnv('portal-hooks-test-');
	});

	it('returns 401 for unauthenticated /api/* requests', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/api/conversations' });
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(401);
	});

	it('redirects unauthenticated page requests to /login', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/' });
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/login');
	});

	it('allows /api/health without auth', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/api/health' });
		const res = await handle({
			event,
			resolve: async () => new Response('ok', { status: 200 })
		});
		expect(res.status).toBe(200);
	});

	it('allows /api/health/liveness without auth', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/api/health/liveness' });
		const res = await handle({
			event,
			resolve: async () => new Response('ok', { status: 200 })
		});
		expect(res.status).toBe(200);
	});

	it('allows /login without auth', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/login' });
		const res = await handle({
			event,
			resolve: async () => new Response('login page', { status: 200 })
		});
		expect(res.status).toBe(200);
	});

	it('blocks cross-origin mutating /api/* even when authenticated', async () => {
		// Switch to AUTH_MODE=none so the request is authorized via the
		// local user; this lets us reach the origin gate.
		await setupLocalEnv('portal-hooks-test-');

		const handle = await loadHandle();
		const event = makeEvent({
			path: '/api/conversations',
			method: 'POST',
			origin: 'https://evil.example.com'
		});
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(403);
	});

	it('rejects same-origin mutating /api/* without a matching CSRF token', async () => {
		await setupLocalEnv('portal-hooks-test-');

		const handle = await loadHandle();
		const event = makeEvent({
			path: '/api/conversations',
			method: 'POST',
			origin: 'http://127.0.0.1',
			csrfCookie: 'cookie-token',
			csrfHeader: 'mismatched-token'
		});
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(403);
	});

	it('rejects same-origin mutating /api/* when the CSRF header is missing', async () => {
		await setupLocalEnv('portal-hooks-test-');

		const handle = await loadHandle();
		const event = makeEvent({
			path: '/api/conversations',
			method: 'POST',
			origin: 'http://127.0.0.1',
			csrfCookie: 'cookie-token'
		});
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(403);
	});

	it('allows same-origin mutating /api/* when the CSRF token matches the cookie', async () => {
		await setupLocalEnv('portal-hooks-test-');

		const handle = await loadHandle();
		const event = makeEvent({
			path: '/api/conversations',
			method: 'POST',
			origin: 'http://127.0.0.1',
			csrfCookie: 'matching-token',
			csrfHeader: 'matching-token'
		});
		const res = await handle({
			event,
			resolve: async () => new Response('ok', { status: 200 })
		});
		expect(res.status).toBe(200);
	});
});

describe('hooks security headers', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-hooks-test-');
	});

	it('sets a restrictive Permissions-Policy on responses', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/' });
		const res = await handle({
			event,
			resolve: async () => new Response('ok', { status: 200 })
		});
		expect(res.headers.get('permissions-policy')).toBe(
			'camera=(), microphone=(), geolocation=(), usb=(), payment=()'
		);
	});
});

describe('hooks handleError correlation id', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-hooks-test-');
	});

	it('uses a CSPRNG hex correlation id (not Math.random base36) for 500s', async () => {
		vi.resetModules();
		const mod = await import('../src/hooks.server');
		const event = makeEvent({ path: '/api/boom', method: 'GET' });
		const result = mod.handleError({
			error: new Error('boom'),
			event,
			status: 500,
			message: 'Internal Error'
		} as unknown as Parameters<typeof mod.handleError>[0]) as { code: string };
		// randomBytes(4).toString('hex') => exactly 8 lowercase hex chars.
		expect(result.code).toMatch(/^[0-9a-f]{8}$/);
	});
});
