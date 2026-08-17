// CSRF double-submit protection for mutating /api/* requests. The same random
// token is pinned here (httpOnly cookie) and exposed to client JS via the
// `<meta name="csrf-token">` tag; the server compares the X-CSRF-Token request
// header against the cookie on mutating requests. A cross-site attacker can
// neither read the token nor set a custom header on a forged request, so a
// matching header proves same-origin intent. This is request-hardening, not
// authentication — see hooks.server.ts for the origin + header double check.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";

const CSRF_COOKIE_NAME = "__Host-portal_csrf";
const DEV_CSRF_COOKIE_NAME = "portal_csrf"; // when not over HTTPS, drop __Host-
const CSRF_MAX_AGE = 60 * 60 * 24 * 30;

function csrfCookieName(secure: boolean): string {
  return secure ? CSRF_COOKIE_NAME : DEV_CSRF_COOKIE_NAME;
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readCsrfCookie(cookies: Cookies, secure = true): string | null {
  // Mirror the pre-auth cookie policy: in secure mode only accept the
  // `__Host-` cookie; in dev/http mode accept either name.
  const v = secure
    ? cookies.get(CSRF_COOKIE_NAME)
    : (cookies.get(csrfCookieName(secure)) ??
      cookies.get(csrfCookieName(!secure)));
  return v ?? null;
}

export function issueCsrfCookie(
  cookies: Cookies,
  token: string,
  secure = true,
): void {
  cookies.set(csrfCookieName(secure), token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: CSRF_MAX_AGE,
  });
}

export function csrfTokensMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
