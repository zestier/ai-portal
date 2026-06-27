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
import { defaultInteractiveResponse, isBlockingKind } from '$lib/interactive/request-registry';
import { isFilesystemPermissionKind } from '$lib/permissions/metadata';
import { publishAppEvent } from './app-events';

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

/**
 * Brand keyed in the global symbol registry so the guard below works even
 * when the module is evaluated more than once (Vite SSR HMR, test
 * `vi.resetModules()`), where a plain `instanceof` would fail because each
 * evaluation produces a distinct class identity.
 */
const CANCELLED_BRAND = Symbol.for('copilot-portal.interactive.prompt-cancelled');

/**
 * Thrown to settle a pending interactive deferred when the prompt is
 * abandoned by the server (turn abort, timeout, browser disconnect, or
 * capacity-pressure session eviction) rather than answered by the user.
 *
 * We reject — not resolve — so consumers can tell a server-side
 * cancellation apart from a real user decision. A resolved fallback would
 * be indistinguishable from a genuine "deny", which is exactly the
 * misleading behaviour this exists to avoid: the SDK would log a tool
 * denial and the audit would show a deny the user never made.
 *
 * `auditDecision` lets the cancel/expire callers tag the permission audit
 * row appropriately (`auto-cancelled` for abort/timeout, `auto-expired`
 * for capacity eviction).
 */
export class InteractivePromptCancelledError extends Error {
	readonly [CANCELLED_BRAND] = true;
	readonly reason: string;
	readonly auditDecision: 'auto-cancelled' | 'auto-expired';
	constructor(reason: string, auditDecision: 'auto-cancelled' | 'auto-expired') {
		super(reason);
		this.name = 'InteractivePromptCancelledError';
		this.reason = reason;
		this.auditDecision = auditDecision;
	}
}

/**
 * True if `err` is an {@link InteractivePromptCancelledError}. Prefer this
 * over `instanceof` at module boundaries — it matches on a global-symbol
 * brand, so it stays correct across duplicate module evaluations.
 */
export function isInteractivePromptCancelledError(
	err: unknown
): err is InteractivePromptCancelledError {
	return (
		typeof err === 'object' &&
		err !== null &&
		(err as Record<symbol, unknown>)[CANCELLED_BRAND] === true
	);
}

export interface PendingInteractive {
	requestId: string;
	conversationId: string;
	/**
	 * Owner of the conversation. Needed to publish awaiting-input transitions
	 * to the right per-user global feed when this prompt is registered or
	 * cleared. Optional because some non-user-facing call sites (and older
	 * tests) register without it; transitions are simply not published then.
	 */
	userId?: string;
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
	/** Conversation owner; enables awaiting-input feed transitions (see above). */
	userId?: string;
	kind: InteractiveKind;
	view: InteractiveRequestView;
	resolve: (response: InteractiveResponse) => void;
	reject: (err: unknown) => void;
	emit?: (ev: PortalEvent) => void;
	timeoutMs?: number;
}

/**
 * True if `conversationId` currently has ≥1 outstanding prompt whose kind
 * blocks on the user. Drives the awaiting-input transition dedup below:
 * we only publish `awaiting.changed` when this answer flips for a
 * conversation, not once per prompt.
 */
function conversationHasBlocking(conversationId: string): boolean {
	for (const p of pending.values()) {
		if (p.conversationId === conversationId && isBlockingKind(p.kind)) return true;
	}
	return false;
}

/**
 * Publish an awaiting-input transition to the conversation owner's global
 * feed. No-op when the userId is unknown (call site didn't thread it) — the
 * sidebar still reconciles from layout `load` in that case. Non-fatal: a feed
 * hiccup must never break prompt registration/resolution.
 */
function publishAwaitingChanged(
	userId: string | undefined,
	conversationId: string,
	awaiting: boolean
): void {
	if (!userId) return;
	try {
		publishAppEvent(userId, { type: 'awaiting.changed', conversationId, awaiting });
	} catch {
		/* non-fatal */
	}
}

/**
 * After a blocking prompt `p` has been removed from `pending`, publish the
 * leaving transition iff it was the conversation's *last* blocking prompt.
 * Call AFTER `pending.delete(...)` so `conversationHasBlocking` reflects the
 * post-removal state. No-op for info-only kinds (they never set awaiting).
 */
function maybePublishLeft(p: PendingInteractive): void {
	if (!isBlockingKind(p.kind)) return;
	if (conversationHasBlocking(p.conversationId)) return;
	publishAwaitingChanged(p.userId, p.conversationId, false);
}

export function register(opts: RegisterOptions) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	// Snapshot the transition BEFORE inserting: was this conversation already
	// blocking on the user? If not and this prompt blocks, it's entering the
	// awaiting-input state and we publish once.
	const wasBlocking = conversationHasBlocking(opts.conversationId);
	const entry: PendingInteractive = {
		requestId: opts.requestId,
		conversationId: opts.conversationId,
		userId: opts.userId,
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
	if (isBlockingKind(opts.kind) && !wasBlocking) {
		publishAwaitingChanged(opts.userId, opts.conversationId, true);
	}
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

/**
 * Set of conversation ids that currently have ≥1 outstanding prompt whose
 * kind actually blocks on the user (see {@link isBlockingKind}). Used by the
 * sidebar "awaiting input" indicator. Unlike {@link hasPending}, this ignores
 * the auto-resolving "info" kinds (sampling / mcp_oauth / external_tool),
 * which never wait on the user.
 *
 * Per-process only — correct for single-instance deployments (same caveat as
 * the `pending` map and {@link hasPending}); a resolve landing on another
 * process won't be reflected here.
 */
export function awaitingInputConversationIds(): Set<string> {
	const out = new Set<string>();
	for (const p of pending.values()) {
		if (isBlockingKind(p.kind)) out.add(p.conversationId);
	}
	return out;
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
	maybePublishLeft(p);

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
 * Cancel a pending request. Used when the turn is aborted or times out.
 *
 * The deferred is **rejected** (not resolved with a deny fallback) so the
 * waiting handler can tell this apart from a real user denial: a resolved
 * "deny" would make the SDK log a tool denial and pollute the audit with a
 * decision the user never made. The `interactive.resolved` event still
 * carries `cancelled: true` + the provided `reason` (with a neutral
 * default outcome for display) so the UI can clear the dialog, and for
 * permission requests we write an `auto-cancelled` audit row — distinct
 * from `auto-deny` — so the settings page shows the prompt was abandoned,
 * not denied.
 */
export function cancel(requestId: string, reason: string = 'cancelled') {
	const p = pending.get(requestId);
	if (!p) return;
	pending.delete(requestId);
	if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
	maybePublishLeft(p);

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
				'auto-cancelled'
			);
		} catch (e) {
			log.warn('interactive.cancel_audit_failed', { requestId, err: String(e) });
		}
	}
	log.info('interactive.cancelled', { requestId, kind: p.kind, reason });
	p.reject(new InteractivePromptCancelledError(reason, 'auto-cancelled'));
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
	maybePublishLeft(p);

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
	p.reject(new InteractivePromptCancelledError(reason, 'auto-expired'));
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
