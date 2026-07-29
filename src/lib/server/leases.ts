// Workspace leases: portal-owned checkouts an agent creates so parallel
// sub-agents can work without colliding in one working tree.
//
// A lease is a linked Git worktree with its own ULID identity, held by a
// conversation. It differs from the conversation's own (primary) managed
// worktree in exactly two ways: its path/branch are derived from the lease id
// instead of the conversation id, and its lifecycle is independent — an agent
// creates and drops leases mid-conversation.
//
// SECURITY MODEL (mirrors `resolveConversationWorkspace` in workdir.ts):
//   - The source repository is NEVER taken from a caller argument. It comes
//     from the holding conversation's persisted workspace. Accepting it from a
//     tool argument would turn lease creation into an ALLOWED_WORKDIRS bypass.
//   - A persisted `path` is never trusted on its own. It is re-derived from
//     (userId, leaseId), realpath'd, and checked for containment under
//     WORKTREE_ROOT before use. Resolution FAILS CLOSED — it never falls back
//     to PROJECT_ROOT the way a plain `workdir` does.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ulid } from './db/ids';
import { loadConfig } from './config';
import { log } from './log';
import * as leaseRepo from './db/repos/leases';
import type { LeaseRow } from './db/repos/leases';
import * as convs from './db/repos/conversations';
import {
	createWorktreeForSlot,
	deleteMergedBranch,
	inspectManagedWorktree,
	removeManagedWorktree,
	sanitizeLeaseLabel,
	slotPath,
	WorktreeError,
	type ManagedWorktreeMetadata,
	type WorktreeSlot
} from './worktrees';
import { resolveConversationWorkspace, WorkspaceUnavailableError } from './workdir';
import type { Conversation } from '$lib/types';

export type Lease = LeaseRow;

/** The metadata shape the shared worktree helpers operate on. */
function toMetadata(lease: Lease): ManagedWorktreeMetadata {
	return {
		sourceWorkdir: lease.sourceWorkdir,
		path: lease.path,
		gitCommonDir: lease.gitCommonDir,
		branch: lease.branch,
		baseSha: lease.baseSha
	};
}

function leaseSlot(lease: Pick<Lease, 'userId' | 'id'>): WorktreeSlot {
	return { kind: 'lease', userId: lease.userId, leaseId: lease.id };
}

/**
 * The repository a conversation's leases are cut from.
 *
 * For a managed-worktree conversation this is the SOURCE repository, not the
 * conversation's own checkout: that checkout is disposable and removed with the
 * conversation, so cutting leases from it would tie their lifetime to it.
 */
function sourceRepositoryFor(conversation: Conversation): string {
	if (conversation.workspaceKind === 'managed-worktree') {
		const managed = convs.getManagedWorktree(conversation.id, conversation.userId);
		if (!managed) {
			throw new WorktreeError('worktree_unavailable', 'managed source workspace is unavailable');
		}
		return managed.sourceWorkdir;
	}
	// A shared-workdir conversation resolves through the normal allowlist, so a
	// stale / out-of-allowlist stored value has already been folded back to
	// PROJECT_ROOT by the time we see it.
	return resolveConversationWorkspace(conversation);
}

export class LeaseQuotaError extends Error {
	readonly code = 'lease_quota_exceeded';
	constructor(message: string) {
		super(message);
		this.name = 'LeaseQuotaError';
	}
}

export interface CreateLeaseInput {
	conversation: Conversation;
	label: string;
	baseRef?: string;
}

/**
 * Create a lease for `conversation`. The checkout and its DB row are created
 * inside the repository lock, so concurrent creates from one orchestrator
 * serialize and the quota check cannot be raced.
 */
export async function createLease(input: CreateLeaseInput): Promise<Lease> {
	const { conversation } = input;
	const label = sanitizeLeaseLabel(input.label);
	const sourceWorkdir = sourceRepositoryFor(conversation);
	const cfg = loadConfig();
	const id = ulid();

	let created: Lease | null = null;
	const metadata = await createWorktreeForSlot({
		sourceWorkdir,
		slot: { kind: 'lease', userId: conversation.userId, leaseId: id, label },
		...(input.baseRef ? { baseRef: input.baseRef } : {}),
		// Runs inside the repository lock. Quotas are enforced here (not before
		// the lock) so two concurrent creates can't both observe "n-1 leases" and
		// both succeed. A throw rolls the checkout back.
		onCreated: (meta) => {
			const perConversation = leaseRepo.countByConversation(conversation.id);
			if (perConversation >= cfg.WORKTREE_MAX_LEASES_PER_CONVERSATION) {
				throw new LeaseQuotaError(
					`this conversation already holds ${perConversation} worktrees (limit ${cfg.WORKTREE_MAX_LEASES_PER_CONVERSATION}); remove one before creating another`
				);
			}
			const perUser = leaseRepo.countByUser(conversation.userId);
			if (perUser >= cfg.WORKTREE_MAX_LEASES_PER_USER) {
				throw new LeaseQuotaError(
					`you already hold ${perUser} worktrees (limit ${cfg.WORKTREE_MAX_LEASES_PER_USER}); remove one before creating another`
				);
			}
			created = leaseRepo.insert({
				id,
				userId: conversation.userId,
				heldByConversationId: conversation.id,
				label,
				sourceWorkdir: meta.sourceWorkdir,
				gitCommonDir: meta.gitCommonDir,
				path: meta.path,
				branch: meta.branch,
				baseSha: meta.baseSha
			});
		}
	});

	if (!created) throw new Error('lease creation did not persist');
	log.info('lease.created', {
		leaseId: id,
		conversationId: conversation.id,
		branch: metadata.branch
	});
	return created;
}

export function getLease(leaseId: string, userId: string): Lease | null {
	return leaseRepo.getById(leaseId, userId);
}

export function listLeases(conversationId: string, userId: string): Lease[] {
	return leaseRepo.listByConversation(conversationId, userId);
}

export function touchLease(leaseId: string): void {
	leaseRepo.touch(leaseId);
}

/**
 * Resolve a lease's checkout to a path safe to hand to tools and file reads.
 *
 * Deliberately parallel to `resolveConversationWorkspace`: the stored path must
 * equal the path re-derived from ids, must exist, must be a real directory, and
 * must resolve strictly inside WORKTREE_ROOT. Any deviation throws rather than
 * degrading to a fallback root.
 */
export function resolveLeaseWorkspace(lease: Lease): string {
	const expected = resolve(slotPath(leaseSlot(lease)));
	const stored = resolve(lease.path);
	if (stored !== expected || !existsSync(stored)) {
		throw new WorkspaceUnavailableError('lease worktree path is unavailable');
	}
	try {
		const rootReal = realpathSync(resolve(loadConfig().WORKTREE_ROOT));
		const storedReal = realpathSync(stored);
		const expectedReal = resolve(rootReal, lease.userId, 'leases', lease.id);
		if (
			!statSync(stored).isDirectory() ||
			storedReal !== expectedReal ||
			storedReal === rootReal ||
			!storedReal.startsWith(rootReal + sep)
		) {
			throw new WorkspaceUnavailableError('lease worktree path is invalid');
		}
		return storedReal;
	} catch (error) {
		if (error instanceof WorkspaceUnavailableError) throw error;
		throw new WorkspaceUnavailableError('lease worktree path is not accessible');
	}
}

export async function inspectLease(lease: Lease): Promise<{ dirtyCount: number }> {
	return inspectManagedWorktree(toMetadata(lease));
}

/**
 * Remove a lease's checkout and row.
 *
 * Refuses while the checkout has uncommitted changes unless `force`, matching
 * the conversation-primary behavior. The branch is deleted only with
 * `git branch -d` (merged-only): an unmerged lease branch is RETAINED and
 * reported, so dropping a worktree can never silently destroy committed work.
 */
export async function removeLease(
	lease: Lease,
	opts: { force?: boolean } = {}
): Promise<{ branch: string; branchDeleted: boolean }> {
	await removeManagedWorktree(toMetadata(lease), {
		...(opts.force ? { force: true } : {}),
		owner: leaseSlot(lease)
	});
	const branchDeleted = await deleteBranchIfMerged(lease);
	leaseRepo.remove(lease.id);
	log.info('lease.removed', {
		leaseId: lease.id,
		branch: lease.branch,
		branchDeleted,
		forced: opts.force === true
	});
	return { branch: lease.branch, branchDeleted };
}

async function deleteBranchIfMerged(lease: Lease): Promise<boolean> {
	return deleteMergedBranch(lease.sourceWorkdir, lease.branch);
}

export interface RemoveLeasesResult {
	removed: string[];
	/** Leases left in place because they were dirty and `force` was not set. */
	retained: Array<{ lease: Lease; dirtyCount: number }>;
}

/**
 * Remove every lease held by a conversation. Used by conversation deletion,
 * which must not orphan checkouts on disk.
 */
export async function removeLeasesForConversation(
	conversationId: string,
	userId: string,
	opts: { force?: boolean } = {}
): Promise<RemoveLeasesResult> {
	const result: RemoveLeasesResult = { removed: [], retained: [] };
	for (const lease of leaseRepo.listByConversation(conversationId, userId)) {
		try {
			await removeLease(lease, opts);
			result.removed.push(lease.id);
		} catch (cause) {
			if (cause instanceof WorktreeError && cause.code === 'worktree_dirty') {
				result.retained.push({ lease, dirtyCount: cause.detail?.dirtyCount ?? 1 });
				continue;
			}
			throw cause;
		}
	}
	return result;
}

/**
 * The set of filesystem roots a conversation's agent may write inside without
 * prompting: its own workspace plus every lease it holds.
 *
 * A lease that fails to resolve is SKIPPED rather than fatal — one broken
 * checkout must not lock the user out of their primary workspace. The primary
 * is always first so callers can treat `[0]` as the main workspace.
 */
export function conversationWorkspaceRoots(conversation: Conversation): string[] {
	const roots: string[] = [];
	try {
		roots.push(resolveConversationWorkspace(conversation));
	} catch {
		// A conversation whose own workspace is unavailable still fails closed at
		// the point of use; here we simply contribute no root for it.
	}
	for (const lease of leaseRepo.listByConversation(conversation.id, conversation.userId)) {
		if (lease.state !== 'active') continue;
		try {
			roots.push(resolveLeaseWorkspace(lease));
		} catch {
			continue;
		}
	}
	return [...new Set(roots)];
}

/**
 * Remove idle, clean leases. Dirty leases are NEVER auto-removed — they are
 * left for the user to review, since uncommitted work is unrecoverable.
 */
export async function reapIdleLeases(now = Date.now()): Promise<{ removed: number }> {
	const cutoff = now - loadConfig().WORKTREE_LEASE_TTL_MS;
	let removed = 0;
	for (const lease of leaseRepo.listIdle(cutoff)) {
		try {
			const { dirtyCount } = await inspectLease(lease);
			if (dirtyCount > 0) continue;
			await removeLease(lease);
			removed++;
		} catch (cause) {
			log.warn('lease.reap_failed', { leaseId: lease.id, err: String(cause) });
		}
	}
	if (removed > 0) log.info('lease.reaped', { removed });
	return { removed };
}

/**
 * Reconcile persisted leases with the filesystem after a restart: drop rows
 * whose checkout is gone (a crash between `worktree add` and row insert, or an
 * FK cascade that removed the row's owner). Runs once at boot.
 */
export async function reconcileLeases(): Promise<{ rowsDropped: number }> {
	let rowsDropped = 0;
	for (const lease of leaseRepo.listAll()) {
		try {
			resolveLeaseWorkspace(lease);
		} catch {
			leaseRepo.remove(lease.id);
			rowsDropped++;
		}
	}
	if (rowsDropped > 0) log.info('lease.reconciled', { rowsDropped });
	return { rowsDropped };
}
