import { error, isHttpError } from '@sveltejs/kit';
import { log } from '$lib/server/log';

/**
 * Map an unexpected (non-domain) failure raised while starting a rerun turn —
 * inline edit (`/edit`), regenerate (`/regenerate`), or fork (`/fork`) — to a
 * clear client error instead of leaking a bare SvelteKit 500
 * (`{"message":"Internal server error"}`), which tells the user nothing about
 * what actually went wrong.
 *
 * Domain rejections (`InlineEditRejected` / `ForkRejected`) are mapped to their
 * specific 4xx codes by the caller *before* this is reached; anything else
 * (e.g. a provider session failing to open, an auth-token lookup blowing up)
 * lands here. We:
 *   - rethrow an already-mapped `HttpError` untouched (so a nested
 *     `error(404, ...)` keeps its status), and
 *   - otherwise log with context and surface a `502` carrying the underlying
 *     message so the client banner is actionable.
 *
 * The message is kept safe: only `Error.message` is forwarded. Provider auth
 * tokens never live on these errors (they're attached to the SDK client at
 * construction time), so there is nothing secret to leak here.
 */
export function throwRerunFailure(
	context: { route: string; conversationId?: string; userId?: string },
	e: unknown
): never {
	// A handler that already chose a specific HTTP status (e.g. a nested
	// `authorizeConversation` 404) should pass through unchanged.
	if (isHttpError(e)) throw e;

	const message = e instanceof Error ? e.message : String(e);
	log.error('rerun.start_failed', {
		route: context.route,
		conversationId: context.conversationId,
		userId: context.userId,
		err: message
	});
	throw error(502, `Couldn't start the rerun: ${message}`);
}
