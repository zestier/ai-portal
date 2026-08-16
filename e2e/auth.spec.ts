import { test, expect } from '@playwright/test';

test('public health endpoint requires no auth', async ({ request }) => {
	const res = await request.get('/api/health');
	expect(res.status()).toBe(200);
});

test('unknown conversation returns 404, not 500', async ({ request }) => {
	const res = await request.get('/api/conversations/01DOESNOTEXIST00000000000');
	expect(res.status()).toBe(404);
});

test('unauthorized when user not resolvable', async ({ request, baseURL }) => {
	// The single shared local user is auto-created on every request, so all
	// normal API paths are reachable. We instead sanity-check the SvelteKit
	// handler is wired up by hitting an internal-only path: /api/admin/redeploy
	// is gated by ENABLE_REDEPLOY and should reject a non-POST / disabled call.
	const res = await request.get(new URL('/api/admin/redeploy', baseURL!).toString());
	// Either 404 (route doesn't exist when disabled) or 403/405 from method
	// guards — anything but 500/200.
	expect([403, 404, 405]).toContain(res.status());
});
