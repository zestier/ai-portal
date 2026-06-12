// Generic interactive-request registry.
//
// Bridges the SDK's interactive callbacks (onPermissionRequest,
// onAutoModeSwitch, onUserInputRequest, onElicitationRequest,
// onExitPlanMode) and information-only events (sampling.requested,
// mcp_oauth.required, external_tool.requested) to deferreds resolved by an
// HTTP endpoint. The flow is:
//
//   1. Bridge handler creates a deferred, calls register({...}), and emits
//      an `interactive.request` PortalEvent into the turn's stream.
//   2. UI sees the event, renders a dialog, and POSTs the user's response
//      to `/api/conversations/:id/interactive/:requestId`.
//   3. The endpoint calls resolve(requestId, ...). We emit an
//      `interactive.resolved` PortalEvent (so replayed event logs don't
//      resurrect a dialog that was already answered), record any side
//      effects (e.g. permission grants), and unblock the bridge.
//
// Cancellation: if the turn is aborted, the runner calls
// cancelConversation(conversationId) to reject all pending requests for
// that conversation so the SDK stops waiting.
//
// Timeout: each pending request has a server-side timeout (default 10 min)
// so a forgotten dialog doesn't pin the session forever.

import { ulid } from 'ulid';
import * as settingsRepo from '../db/repos/settings';
import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../global-singleton';
import { log } from '../log';
import type {
	InteractiveKind,
	InteractiveRequestView,
	InteractiveResponse,
	PermissionDecision,
	PermissionPolicy,
	PortalEvent
} from '$lib/types';
import { defaultInteractiveResponse } from '$lib/interactive/request-registry';
import { isFilesystemPermissionKind } from '$lib/permissions/metadata';

// Default = no timeout. We used to default to 10 minutes "so a forgotten
// dialog doesn't pin the session forever", but in headless mode (where
// the portal IS the only UI for the agent) a missed window manifested as
// an indistinguishable "user denied", which was worse than the resource
// leak. Turn abort (`cancelConversation`) still cancels every pending
// prompt for the conversation, so the only thing left holding a request
// is a literal "user hasn't clicked yet" — which is fine to wait on.
//
// Callers can still pass an explicit `timeoutMs` if they want one.
const DEFAULT_TIMEOUT_MS = 0;

export interface PendingInteractive {
	requestId: string;
	conversationId: string;
	kind: InteractiveKind;
	view: InteractiveRequestView;
	resolve: (response: InteractiveResponse) => void;
	reject: (err: unknown) => void;
	createdAt: number;
	/**
	 * Broadcasts an event into the active turn's stream. Used to publish an
	 * `interactive.resolved` event so that any future re-subscriber (a page
	 * refresh, a visibility-driven reconnect, etc.) which replays the turn's
	 * event log learns that the request has already been decided and can
	 * clear the prompt. Without this, the original `interactive.request`
	 * event in the log would resurrect a dialog that was already answered.
	 */
	emit?: (ev: PortalEvent) => void;
	timeoutHandle?: ReturnType<typeof setTimeout>;
}

// Per-process map. Acceptable for single-instance deployment.
//
// NOTE (multi-instance): this is still NOT multi-instance safe — a resolve
// POST that lands on a different process can't see another process's pending
// deferred. Out of scope for this ticket; flagged deliberately.
//
// Stashed on globalThis (mirroring pool.sessions and the turn registry) so a
// Vite SSR HMR re-import of this module mid-prompt does not orphan a live
// deferred in the old module's closure. Without this, an edit during an open
// prompt would create a fresh empty map: the resolve route would 404,
// listForConversation would return [] (dialog vanishes), and the original
// deferred would never settle -> the turn hangs forever.
const PENDING_KEYS = appGlobalSymbols('interactive.pending');
const pending = getOrCreateGlobalSingleton(
	PENDING_KEYS,
	() => new Map<string, PendingInteractive>()
);

export function newRequestId(): string {
	return ulid();
}

export interface RegisterOptions {
	requestId: string;
	conversationId: string;
	kind: InteractiveKind;
	view: InteractiveRequestView;
	resolve: (response: InteractiveResponse) => void;
	reject: (err: unknown) => void;
	emit?: (ev: PortalEvent) => void;
	timeoutMs?: number;
}

export function register(opts: RegisterOptions) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const entry: PendingInteractive = {
		requestId: opts.requestId,
		conversationId: opts.conversationId,
		kind: opts.kind,
		view: opts.view,
		resolve: opts.resolve,
		reject: opts.reject,
		emit: opts.emit,
		createdAt: Date.now()
	};
	if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
		const t = setTimeout(() => {
			log.warn('interactive.timeout', {
				requestId: opts.requestId,
				kind: opts.kind,
				timeoutMs
			});
			cancel(opts.requestId, 'timeout');
		}, timeoutMs);
		(t as { unref?: () => void }).unref?.();
		entry.timeoutHandle = t;
	}
	pending.set(opts.requestId, entry);
	log.info('interactive.registered', { requestId: opts.requestId, kind: opts.kind });
}

export function get(requestId: string): PendingInteractive | undefined {
	return pending.get(requestId);
}

/**
 * Snapshot every prompt still outstanding for a conversation. Used by
 * the conversation GET endpoint so a page load (or a stream-reconnect
 * after a blip) can rehydrate `pendingInteractive` without waiting for
 * the original `interactive.request` event to be re-emitted.
 */
export function listForConversation(conversationId: string): InteractiveRequestView[] {
	const out: InteractiveRequestView[] = [];
	for (const p of pending.values()) {
		if (p.conversationId === conversationId) out.push(p.view);
	}
	return out;
}

/**
 * Resolve a pending request with the given response. Returns true if the
 * request existed and was resolved. The response shape must match the
 * registered kind; mismatched responses are rejected with `kind_mismatch`.
 */
/**
 * True if any prompt is still outstanding for the conversation. Used by the
 * session pool's idle reaper / capacity eviction so it never disposes the SDK
 * session backing an open prompt (which would strand the deferred: the dialog
 * stays answerable and the resolve POST 200s, but the tool can never run).
 */
export function hasPending(conversationId: string): boolean {
	for (const p of pending.values()) {
		if (p.conversationId === conversationId) return true;
	}
	return false;
}

export function resolve(requestId: string, userId: string, response: InteractiveResponse): boolean {
	const p = pending.get(requestId);
	if (!p) return false;
	if (p.kind !== response.kind) {
		log.warn('interactive.kind_mismatch', {
			requestId,
			expected: p.kind,
			got: response.kind
		});
		return false;
	}
	response = normalizeResponse(response);
	pending.delete(requestId);
	if (p.timeoutHandle) clearTimeout(p.timeoutHandle);

	// Permission-specific bookkeeping: audit + grants.
	if (response.kind === 'permission' && p.view.kind === 'permission') {
		try {
			settingsRepo.recordDecision(
				p.conversationId,
				p.view.tool,
				typeof p.view.summary === 'string' ? p.view.summary : '',
				response.decision
			);
			const isAlways =
				p.view.canPersistDecision !== false &&
				(response.decision === 'allow-always' || response.decision === 'deny-always');
			if (isAlways) {
				const grantDecision = response.decision === 'allow-always' ? 'allow' : 'deny';
				const targetConversationId = response.applyToAllConversations ? null : p.conversationId;
				const expiresAt =
					typeof response.expiresInMs === 'number' ? Date.now() + response.expiresInMs : null;

				// Build the list of grants to persist: the primary `scope`
				// plus any `additionalScopes` (shell picker emits several
				// when the user checks per-argv0 boxes for a pipeline).
				// `undefined` entries fall back to `{}` (the legacy
				// "any kind / any pattern" grant) so the existing
				// single-scope code path is preserved exactly.
				const scopes: Array<typeof response.scope> = [response.scope];
				if (response.additionalScopes) scopes.push(...response.additionalScopes);

				// Defense in depth: if the user's current policy is deny-all,
				// don't persist a positive grant that would silently override
				// it on the next call. Deny grants are always safe to record.
				if (grantDecision === 'allow') {
					const s = settingsRepo.get(userId);
					if (s && s.defaultPolicy === 'deny-all') {
						log.warn('interactive.allow_always_under_deny_all_ignored', {
							requestId,
							userId,
							conversationId: p.conversationId,
							tool: p.view.tool
						});
					} else {
						for (const scope of scopes) {
							settingsRepo.addGrant({
								userId,
								conversationId: targetConversationId,
								tool: p.view.tool,
								permissionKind: scope?.permissionKind ?? null,
								scopePattern: scope?.pattern ?? null,
								scope: scope?.scope ?? null,
								decision: 'allow',
								expiresAt,
								source: 'prompt'
							});
						}
					}
				} else {
					const denyReason = normalizeDenyFeedback(response.feedback);
					for (const scope of scopes) {
						settingsRepo.addGrant({
							userId,
							conversationId: targetConversationId,
							tool: p.view.tool,
							permissionKind: scope?.permissionKind ?? null,
							scopePattern: scope?.pattern ?? null,
							scope: scope?.scope ?? null,
							decision: 'deny',
							denyReason,
							expiresAt,
							source: 'prompt'
						});
					}
				}
			}
		} catch (e) {
			log.warn('interactive.permission_persist_failed', { requestId, err: String(e) });
		}
	}

	// Broadcast resolution BEFORE unblocking the SDK so the event lands in
	// the turn's event log before any subsequent tool.call/result.
	try {
		p.emit?.({
			type: 'interactive.resolved',
			requestId: p.requestId,
			kind: p.kind,
			outcome: response
		});
	} catch {
		/* non-fatal */
	}

	log.info('interactive.resolved', { requestId, kind: p.kind });
	p.resolve(response);
	return true;
}

/**
 * Cancel a pending request, defaulting to a "deny / decline" response
 * appropriate for the kind. Used when the turn is aborted or times out.
 *
 * The `interactive.resolved` event carries `cancelled: true` + the
 * provided `reason` so the UI / audit log can distinguish a cancel
 * (timeout, turn-abort, browser disconnect) from a user-driven deny. For
 * permission requests we also write an `auto-deny` audit row so it shows
 * up on the settings page; the SDK still sees `{ kind: 'reject' }` either
 * way, but downstream debugging is much cleaner.
 */
export function cancel(requestId: string, reason: string = 'cancelled') {
	const p = pending.get(requestId);
	if (!p) return;
	pending.delete(requestId);
	if (p.timeoutHandle) clearTimeout(p.timeoutHandle);

	const fallback = defaultInteractiveResponse(p.kind);
	try {
		p.emit?.({
			type: 'interactive.resolved',
			requestId: p.requestId,
			kind: p.kind,
			outcome: fallback,
			cancelled: true,
			cancelReason: reason
		});
	} catch {
		/* non-fatal */
	}
	if (p.kind === 'permission' && p.view.kind === 'permission') {
		try {
			settingsRepo.recordDecision(
				p.conversationId,
				p.view.tool,
				typeof p.view.summary === 'string' ? p.view.summary : '',
				'auto-deny'
			);
		} catch (e) {
			log.warn('interactive.cancel_audit_failed', { requestId, err: String(e) });
		}
	}
	log.info('interactive.cancelled', { requestId, kind: p.kind, reason });
	p.resolve(fallback);
}

/**
 * Cancel every pending request for a conversation. Called from the turn
 * runner when a turn is aborted so the SDK doesn't hang waiting on
 * deferreds we've abandoned.
 */
export function cancelConversation(conversationId: string, reason: string = 'turn_aborted') {
	for (const [id, p] of pending) {
		if (p.conversationId === conversationId) cancel(id, reason);
	}
}

// Agent-facing feedback when a prompt's backing SDK session is reclaimed
// (capacity eviction) before the user answered. Distinct from a user deny:
// the request was never decided, so the agent should simply re-issue it.
const SESSION_EXPIRED_FEEDBACK =
	'The session backing this request was reclaimed (capacity pressure) before it was answered. ' +
	'This is not a denial — re-issue the tool call to try again.';

/**
 * Settle every pending request for a conversation because its backing SDK
 * session is being disposed out from under it (capacity eviction). Unlike
 * `cancel`, this is NOT a deny: it resolves with a distinct "session expired —
 * re-issue" outcome and audits it as `auto-expired` (not `auto-deny`) so the
 * agent unblocks instead of hanging and the audit log makes the cause obvious.
 *
 * The idle reaper deliberately never calls this (it skips sessions with
 * outstanding work entirely — "a leak is better than a silent deny"); only
 * the capacity-pressure escape hatch in the pool does.
 */
export function expireConversation(conversationId: string, reason: string = 'session_expired') {
	for (const [id, p] of pending) {
		if (p.conversationId === conversationId) expire(id, reason);
	}
}

function expire(requestId: string, reason: string) {
	const p = pending.get(requestId);
	if (!p) return;
	pending.delete(requestId);
	if (p.timeoutHandle) clearTimeout(p.timeoutHandle);

	const outcome = expiredResponse(p.kind);
	try {
		p.emit?.({
			type: 'interactive.resolved',
			requestId: p.requestId,
			kind: p.kind,
			outcome,
			cancelled: true,
			cancelReason: reason
		});
	} catch {
		/* non-fatal */
	}
	if (p.kind === 'permission' && p.view.kind === 'permission') {
		try {
			settingsRepo.recordDecision(
				p.conversationId,
				p.view.tool,
				typeof p.view.summary === 'string' ? p.view.summary : '',
				'auto-expired'
			);
		} catch (e) {
			log.warn('interactive.expire_audit_failed', { requestId, err: String(e) });
		}
	}
	log.warn('interactive.expired', { requestId, kind: p.kind, reason });
	p.resolve(outcome);
}

// The "session expired" outcome by kind. For permission requests we attach
// re-issue feedback so the agent (if its session somehow survives to read it)
// learns this was a reclaim, not a deny. Other kinds fall back to their
// neutral default response.
function expiredResponse(kind: InteractiveKind): InteractiveResponse {
	if (kind === 'permission') {
		return { kind: 'permission', decision: 'deny', feedback: SESSION_EXPIRED_FEEDBACK };
	}
	return defaultInteractiveResponse(kind);
}

export { defaultInteractiveResponse };

function normalizeDenyFeedback(feedback: string | undefined): string | null {
	const trimmed = feedback?.trim();
	return trimmed ? trimmed.slice(0, 500) : null;
}

function normalizeResponse(response: InteractiveResponse): InteractiveResponse {
	if (response.kind !== 'permission') return response;
	const feedback = normalizeDenyFeedback(response.feedback) ?? undefined;
	if (!feedback || (response.decision !== 'deny' && response.decision !== 'deny-always')) {
		const normalized = { ...response };
		delete normalized.feedback;
		return normalized;
	}
	return { ...response, feedback };
}

// --- Policy helpers ---
//
// Auto-approval is currently scoped to permission requests (the only kind
// the legacy policy applied to). Other kinds always 'ask' — auto-mode-switch
// in particular is a billing / quota decision that should never be silently
// approved.
//
// Under the default 'prompt' policy we auto-allow:
//   - `read` / `write` / `edit`: only when the target path resolves
//     (via realpath, with parent-fallback for not-yet-existing targets)
//     inside the conversation's working directory. Symlinks that escape
//     the workspace fail the check; reads of `~/.ssh`, writes to `/etc`,
//     edits in a sibling repo, etc. will still prompt.
//
// URL fetches are NOT auto-approved: the URL itself is attacker-controlled
// content under prompt injection (exfiltration via query string, SSRF to
// loopback / cloud metadata, etc.), so we always surface a dialog.
//
// If the caller can't supply a workspace root or scope key, the file-system
// kinds fall back to 'ask' (safer default).

import { isPathInWorkspace } from '../permissions/workspace';

export interface PolicyContext {
	/** The runtime scope key (file path / command / URL) for this request. */
	scopeKey?: string | null;
	/** The conversation's absolute working directory. */
	workspaceRoot?: string | null;
}

export function decideByPolicy(
	policy: PermissionPolicy,
	kind: InteractiveKind,
	permissionKind?: string,
	ctx?: PolicyContext
): 'approved' | 'denied' | 'ask' {
	if (kind !== 'permission') return 'ask';
	const pk = permissionKind ?? '';
	switch (policy) {
		case 'allow-all':
			return 'approved';
		case 'deny-all':
			return 'denied';
		case 'prompt':
		default:
			if (isFilesystemPermissionKind(pk)) {
				const root = ctx?.workspaceRoot;
				const target = ctx?.scopeKey;
				if (root && target && isPathInWorkspace(target, root)) return 'approved';
				return 'ask';
			}
			return 'ask';
	}
}

// Re-export so existing imports keep working through the rename.
export type { PermissionDecision };
