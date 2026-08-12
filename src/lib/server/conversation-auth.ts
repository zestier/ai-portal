// Shared helper for conversation-scoped API routes: looks up the
// conversation, asserts ownership, and returns the full row so handlers
// don't each re-implement the same `userId / convs.get / 404` dance.

import { error } from '@sveltejs/kit';
import * as convs from '$lib/server/db/repos/conversations';
import { resolveWorkspaceRoot } from '$lib/server/files';
import { resolveConversationWorkspace, WorkspaceUnavailableError } from '$lib/server/workdir';
import { getLease, resolveLeaseWorkspace, touchLease, type Lease } from '$lib/server/leases';
import type { Conversation } from '$lib/types';

export function authorizeConversation(
	convId: string | undefined,
	userId: number | null | undefined
): Conversation {
	if (!userId) throw error(401);
	if (!convId) throw error(400, 'missing conversation id');
	const id = Number(convId);
	if (!Number.isInteger(id) || id <= 0) throw error(404);
	const conv = convs.get(id, userId);
	if (!conv) throw error(404);
	return conv;
}

export function authorizeConversationWorkdir(
	convId: string | undefined,
	userId: number | null | undefined
): { conversation: Conversation; workdir: string } {
	const conversation = authorizeConversation(convId, userId);
	return { conversation, workdir: resolveWorkspace(conversation) };
}

/**
 * Resolve the directory a conversation-scoped read should target: the
 * conversation's own workspace by default, or one of its worktree leases when
 * `leaseId` is supplied.
 *
 * Omitting `leaseId` is byte-for-byte today's behavior, so every existing
 * caller is unaffected. A supplied lease must be owned by the SAME user AND
 * held by THIS conversation — a lease id appears in URLs, so an id belonging to
 * another conversation (even the caller's own) must not become a readable root.
 * Both failures are a flat 404 rather than a 403, so the endpoint does not
 * confirm that an id exists.
 */
export function authorizeConversationWorkspace(
	convId: string | undefined,
	userId: number | null | undefined,
	leaseId?: string | null
): { conversation: Conversation; workdir: string; lease: Lease | null } {
	const conversation = authorizeConversation(convId, userId);
	if (!leaseId) {
		return { conversation, workdir: resolveWorkspace(conversation), lease: null };
	}
	const lease = getLease(Number(leaseId), conversation.userId);
	if (!lease || lease.heldByConversationId !== conversation.id) throw error(404);
	let workdir: string;
	try {
		workdir = resolveWorkspaceRoot(resolveLeaseWorkspace(lease));
	} catch (cause) {
		if (cause instanceof WorkspaceUnavailableError) {
			throw error(409, { message: cause.message, code: cause.code });
		}
		throw cause;
	}
	// Browsing a lease is activity: keep the reaper from collecting a checkout
	// the user is actively looking at.
	touchLease(lease.id);
	return { conversation, workdir, lease };
}

function resolveWorkspace(conversation: Conversation): string {
	try {
		return resolveWorkspaceRoot(resolveConversationWorkspace(conversation));
	} catch (cause) {
		if (cause instanceof WorkspaceUnavailableError) {
			throw error(409, { message: cause.message, code: cause.code });
		}
		throw cause;
	}
}

/** Read the optional `?worktree=<leaseId>` selector from a request URL. */
export function leaseIdFromUrl(url: URL): string | null {
	return url.searchParams.get('worktree');
}
