import type { Handle, HandleServerError } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { getDb } from '$lib/server/db';
import * as users from '$lib/server/db/repos/users';
import * as settings from '$lib/server/db/repos/settings';
import {
	read as readSession,
	generateCsrfToken,
	readCsrfCookie,
	issueCsrfCookie,
	csrfTokensMatch
} from '$lib/server/auth/session';
import { apiErrorResponse } from '$lib/server/http';
import { startIdleReaper } from '$lib/server/runtime/pool';
import { startMemoryMaintenance } from '$lib/server/runtime/memory-maintenance';
import { startTicketEventBridge } from '$lib/server/runtime/ticket-events';
import * as messages from '$lib/server/db/repos/messages';
import { faviconDataUri, normalizeThemeAccent, type ThemeAccent } from '$lib/types';

// One-time bootstrap.
let booted = false;
function boot() {
	if (booted) return;
	booted = true;
	loadConfig(); // throws if invalid
	getDb(); // opens + migrates
	messages.recoverInterruptedInFlight();
	startIdleReaper();
	startMemoryMaintenance();
	startTicketEventBridge();
	log.info('boot.ok');
}
boot();

const PUBLIC_PATHS = new Set(['/login', '/auth/callback', '/api/health']);
const PUBLIC_PREFIXES = ['/_app/', '/favicon'];

function isPublic(pathname: string): boolean {
	if (PUBLIC_PATHS.has(pathname)) return true;
	return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export const handle: Handle = async ({ event, resolve }) => {
	const cfg = loadConfig();
	const secure = event.url.protocol === 'https:';

	// Default locals
	event.locals.userId = null;
	event.locals.user = null;

	// CSRF double-submit token: reuse the value already pinned in the browser's
	// cookie so the token rendered into the <meta> tag (and echoed back by the
	// client in the X-CSRF-Token header) matches what we validate below. Mint +
	// set it on first contact.
	let csrf = readCsrfCookie(event.cookies, secure);
	if (!csrf) {
		csrf = generateCsrfToken();
		issueCsrfCookie(event.cookies, csrf, secure);
	}
	event.locals.csrfToken = csrf;

	// AUTH_MODE=none: auto-login the local user.
	if (cfg.AUTH_MODE === 'none') {
		const u = users.ensureLocalUser();
		event.locals.userId = u.id;
		event.locals.user = u;
	} else {
		const claims = readSession(event.cookies, secure);
		if (claims) {
			const u = users.getById(claims.sub);
			if (u) {
				event.locals.userId = u.id;
				event.locals.user = u;
			}
		}
	}

	// Auth gate.
	const path = event.url.pathname;
	if (!isPublic(path) && !event.locals.userId) {
		if (path.startsWith('/api/')) {
			return apiErrorResponse(401, 'unauthorized');
		}
		return new Response(null, {
			status: 302,
			headers: { location: '/login' }
		});
	}

	// Origin check for mutating JSON API calls. SvelteKit covers form
	// actions; this keeps JSON API mutations on the same boundary.
	if (path.startsWith('/api/') && event.request.method !== 'GET') {
		const origin = event.request.headers.get('origin');
		const referer = event.request.headers.get('referer');
		const expectedOrigin = event.url.origin;
		const ok =
			(origin && origin === expectedOrigin) ||
			(referer && referer.startsWith(expectedOrigin + '/'));
		if (!ok) {
			return apiErrorResponse(403, 'bad_origin');
		}

		// CSRF double-submit validation (defense in depth alongside the Origin
		// check above). The client echoes the cookie-pinned token — exposed via
		// the <meta name="csrf-token"> tag — in this header. A cross-site
		// attacker can neither read that token nor set a custom header on a
		// forged request, so a matching header proves same-origin intent.
		const headerToken = event.request.headers.get('x-csrf-token');
		if (!csrfTokensMatch(headerToken, csrf)) {
			return apiErrorResponse(403, 'bad_csrf');
		}
	}

	// Resolve theme for SSR so the first paint matches the user's preference.
	// 'system' is resolved client-side via prefers-color-scheme (see app.html).
	// NOTE: we read settings inside transformPageChunk (not before resolve())
	// so that form actions which mutate the theme are reflected in the same
	// response, without requiring a page refresh.
	const response = await resolve(event, {
		transformPageChunk: ({ html }) => {
			let themeMode: 'dark' | 'light' | 'system' = 'system';
			let accent: ThemeAccent = 'default';
			if (event.locals.userId) {
				const s = settings.get(event.locals.userId);
				if (s) {
					themeMode = s.theme;
					accent = normalizeThemeAccent(s.accent);
				}
			}
			const initialTheme = themeMode === 'light' ? 'light' : 'dark';
			return html
				.replace('%csrf.token%', event.locals.csrfToken)
				.replace('%theme.initial%', initialTheme)
				.replace('%theme.mode%', themeMode)
				.replace('%theme.accent%', accent)
				.replace('%theme.favicon%', faviconDataUri(accent));
		}
	});

	// Security headers.
	if (!response.headers.has('content-security-policy')) {
		response.headers.set(
			'content-security-policy',
			[
				"default-src 'self'",
				// No 'unsafe-inline' for scripts: the pre-hydrate bootstrap
				// lives in `/static/prehydrate.js`, and SvelteKit's own
				// inline hydration scripts are emitted with integrity
				// hashes that browsers accept under `'self'` via the
				// `'strict-dynamic'`-less default. If you need to add an
				// inline <script>, move it to /static or use SvelteKit's
				// `kit.csp.directives` with mode: 'hash' instead.
				"script-src 'self'",
				// 'unsafe-inline' still required for Svelte component
				// styles; tightening this needs a Svelte compiler change.
				"style-src 'self' 'unsafe-inline'",
				"connect-src 'self'",
				"img-src 'self' data: https://avatars.githubusercontent.com",
				"font-src 'self' data:",
				"frame-ancestors 'none'",
				"base-uri 'self'",
				"form-action 'self'"
			].join('; ')
		);
	}
	response.headers.set('x-content-type-options', 'nosniff');
	// 'same-origin' (not 'no-referrer') so browsers still send the Origin
	// header on same-site form POSTs. With 'no-referrer' the browser sends
	// `Origin: null`, which SvelteKit's built-in CSRF check rejects. The
	// path is still stripped for cross-origin requests, which is what the
	// privacy intent was.
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-frame-options', 'DENY');
	if (secure) {
		response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
	}

	return response;
};

export const handleError: HandleServerError = ({ error, event, status }) => {
	// 404s aren't server errors; don't spam the log with browser/extension
	// probes for /favicon.ico and friends.
	if (status === 404) {
		return { message: 'Not found', code: 'not_found' };
	}
	const id = Math.random().toString(36).slice(2, 10);
	log.error('unhandled', {
		id,
		path: event.url.pathname,
		err: error instanceof Error ? (error.stack ?? error.message) : String(error)
	});
	return { message: 'Internal server error', code: id };
};
