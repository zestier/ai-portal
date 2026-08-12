import { error } from '@sveltejs/kit';

/**
 * Returns the authenticated user id from `event.locals`, narrowing the
 * type from `string | null` to `string`.
 *
 * The hooks auth gate (`src/hooks.server.ts`) is the primary enforcement
 * point — it 401s `/api/*` and 302s page routes for unauthenticated
 * requests before handlers run. This helper exists as a defense-in-depth
 * assertion and as a type narrower, so handlers can drop the
 * `if (!locals.userId) throw error(401)` boilerplate and operate on a
 * plain `string` userId.
 */
export function requireUserId(locals: App.Locals): number {
	if (!locals.userId) throw error(401);
	return locals.userId;
}
