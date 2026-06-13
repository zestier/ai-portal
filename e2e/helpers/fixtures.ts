import { test as base, expect, type APIRequestContext } from '@playwright/test';

export { expect };

// hooks.server.ts issues the CSRF token under one of these cookie names
// (`__Host-` prefix only over HTTPS; the e2e server runs over http).
const CSRF_COOKIE_NAMES = ['portal_csrf', '__Host-portal_csrf'];

/**
 * Overrides the built-in `request` fixture so API-driven specs satisfy the
 * hooks.server.ts CSRF double-submit guard. The server pins a token in a
 * cookie and requires a matching `X-CSRF-Token` header on mutating `/api/*`
 * calls, but Playwright's default APIRequestContext sends neither.
 *
 * We prime the cookie with a public GET, read back the issued token, then
 * build the real context with that cookie pre-seeded and the matching header
 * attached — mirroring what the browser client does via hooks.client.ts. The
 * `Origin` header (also required by the guard) is re-added here because a
 * freshly created context does not inherit `use.extraHTTPHeaders`.
 */
export const test = base.extend<{ request: APIRequestContext }>({
	request: async ({ playwright, baseURL }, use) => {
		const origin = baseURL ?? '';
		const probe = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: { Origin: origin }
		});
		await probe.get('/api/health');
		const { cookies } = await probe.storageState();
		await probe.dispose();
		const csrf = cookies.find((c) => CSRF_COOKIE_NAMES.includes(c.name));

		const ctx = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: {
				Origin: origin,
				...(csrf ? { 'X-CSRF-Token': csrf.value } : {})
			},
			storageState: csrf ? { cookies: [csrf], origins: [] } : undefined
		});
		await use(ctx);
		await ctx.dispose();
	}
});
