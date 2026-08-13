// Workspace leases: portal-owned checkouts an agent creates so parallel
// sub-agents can work without colliding in one working tree.
//
// A lease is a linked Git worktree with its own integer identity, held by a
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
import { loadConfig } from './config';
import { log } from './log';
import * as leaseRepo from './db/repos/leases';
import type { LeaseRow } from './db/repos/leases';
import * as convs from './db/repos/conversations';
import { conversationId as convCodec, leaseId as leaseCodec } from '$lib/ids';
import {
	createWorktreeForSlot,
	deleteMergedBranch,
	inspectManagedWorktree,
	pruneWorktrees,
	removeManagedWorktree,
	sanitizeLeaseLabel,
	slotPath,
	WorktreeError,
	type ManagedWorktreeMetadata,
	type WorktreeSlot
} from './worktrees';
import { resolveConversationWorkspace, WorkspaceUnavailableError } from './workdir';
import {
	mergeWorktree,
	worktreeIntegrationStatus,
	type MergeDirection,
	type MergeWorktreeResult,
	type SquashMessage,
	type WorktreeIntegrationStatus
} from './worktree-integration';
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
	return { kind: 'lease', userId: String(lease.userId), leaseId: String(leaseCodec.parse(lease.id)) };
}

/**
 * The tree a conversation's leases are cut from and merge back into.
 *
 * This is the conversation's OWN workspace, including when that is a managed
 * worktree. Sub-agents working in parallel leases are working on sub-tasks of
 * whatever the conversation is doing, so they must start from its current state
 * and their results must gather back into its branch — to be reviewed and
 * tested together before any of it reaches the shared checkout.
 *
 * (An earlier version cut leases from the source repository instead, on the
 * theory that branching from a disposable checkout would tie the lease's
 * lifetime to it. That was wrong on the mechanism: git worktrees are flat
 * siblings sharing one common dir, so removing one does not affect another.
 * Registering in the same repository does not require branching from the same
 * commit — and branching from main meant sub-agents could not see the
 * orchestrator's in-progress work.)
 */
function leaseCounterpartWorkspace(conversation: Conversation): string {
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
	const sourceWorkdir = leaseCounterpartWorkspace(conversation);
	const cfg = loadConfig();
	// Mint the lease id before the checkout exists: the checkout path/branch
	// derive from it (`portal/lease/<id>`), so the DB row is created with stub
	// values and completed once the worktree is on disk. The stub row lives only
	// for the duration of the checkout creation below.
	const id = leaseRepo.mintPlaceholder({
		userId: conversation.userId,
		heldByConversationId: convCodec.parse(conversation.id),
		label
	});

	let created: Lease | null = null;
	try {
		const metadata = await createWorktreeForSlot({
			sourceWorkdir,
			slot: { kind: 'lease', userId: String(conversation.userId), leaseId: String(id), label },
			...(input.baseRef ? { baseRef: input.baseRef } : {}),
			// Runs inside the repository lock. Quotas are enforced here (not before
			// the lock) so two concurrent creates can't both observe "n-1 leases" and
			// both succeed. A throw rolls the checkout back.
			onCreated: (meta) => {
				const perConversation = leaseRepo.countByConversation(convCodec.parse(conversation.id));
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
				created = leaseRepo.completePlaceholder(id, conversation.userId, {
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
	} catch (cause) {
		// A checkout that never got created (or a failed onCreated) leaves the
		// placeholder row behind — drop it so it doesn't count toward quota.
		leaseRepo.remove(id);
		throw cause;
	}
}

export function getLease(leaseId: string | number, userId: number): Lease | null {
	// Handles parse via the codec; raw ints pass through (the lease routes parse
	// at entry, but callers holding a repo-shaped `Lease` pass the handle).
	const intId = typeof leaseId === 'number' ? leaseId : leaseCodec.parse(leaseId);
	return leaseRepo.getById(intId, userId);
}

export function listLeases(conversationId: string | number, userId: number): Lease[] {
	const intConv = typeof conversationId === 'number' ? conversationId : convCodec.parse(conversationId);
	return leaseRepo.listByConversation(intConv, userId);
}

export function touchLease(leaseId: string | number): void {
	const intId = typeof leaseId === 'number' ? leaseId : leaseCodec.parse(leaseId);
	leaseRepo.touch(intId);
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
		const expectedReal = resolve(rootReal, String(lease.userId), 'leases', String(leaseCodec.parse(lease.id)));
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
	leaseRepo.remove(leaseCodec.parse(lease.id));
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

/** Why a lease was left in place instead of being removed. */
export type LeaseRetentionReason = 'dirty' | 'unmerged';

export interface RetainedLease {
	lease: Lease;
	reason: LeaseRetentionReason;
	/** Uncommitted files, for `reason: 'dirty'`. */
	dirtyCount: number;
	/** Commits not present on the source branch, for `reason: 'unmerged'`. */
	ahead: number;
}

export interface RemoveLeasesResult {
	removed: string[];
	/** Leases left in place because removing them would lose sight of work. */
	retained: RetainedLease[];
}

/**
 * Commits on a lease's branch that its counterpart — the conversation holding
 * it — does not have. A missing or broken checkout reports 0 so a stale lease
 * stays deletable; the guard exists to prevent surprise, not to strand the user.
 */
async function unmergedCommitCount(lease: Lease, conversation: Conversation): Promise<number> {
	try {
		return (await leaseIntegrationStatus(lease, conversation)).ahead;
	} catch {
		return 0;
	}
}

/**
 * Remove every lease held by a conversation. Used by conversation deletion,
 * which must not orphan checkouts on disk.
 *
 * Refuses on two counts unless forced:
 *  - uncommitted changes, which removal would destroy outright;
 *  - commits not merged into the source branch. Those survive as a branch
 *    (removal only ever deletes a merged one), but deleting the conversation
 *    destroys the only thing that named them — and a lease branch
 *    (`portal/lease/<ulid>--<label>`) is even less discoverable than a
 *    conversation's own. Same reasoning as the primary worktree's guard.
 */
export async function removeLeasesForConversation(
	conversationId: number,
	userId: number,
	opts: { force?: boolean } = {}
): Promise<RemoveLeasesResult> {
	const result: RemoveLeasesResult = { removed: [], retained: [] };
	const conversation = convs.get(conversationId, userId);
	for (const lease of leaseRepo.listByConversation(conversationId, userId)) {
		if (!opts.force && conversation) {
			const ahead = await unmergedCommitCount(lease, conversation);
			if (ahead > 0) {
				result.retained.push({ lease, reason: 'unmerged', ahead, dirtyCount: 0 });
				continue;
			}
		}
		try {
			await removeLease(lease, opts);
			result.removed.push(lease.id);
		} catch (cause) {
			if (cause instanceof WorktreeError && cause.code === 'worktree_dirty') {
				result.retained.push({
					lease,
					reason: 'dirty',
					dirtyCount: cause.detail?.dirtyCount ?? 1,
					ahead: 0
				});
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
	for (const lease of leaseRepo.listByConversation(convCodec.parse(conversation.id), conversation.userId)) {
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
 * Live containment roots for a conversation id, for the provider permission
 * adapters. Falls back to `fallback` (the session's working directory) when the
 * conversation row can't be read or contributes no roots, so permission
 * behavior is never *narrower* than it was before leases existed.
 *
 * Called per permission request rather than cached: a lease created mid-turn
 * must be writable within that same turn.
 */
export function workspaceRootsFor(
	conversationId: number,
	userId: number,
	fallback: string
): string[] {
	try {
		const conversation = convs.get(conversationId, userId);
		if (!conversation) return [fallback];
		const roots = conversationWorkspaceRoots(conversation);
		return roots.length > 0 ? roots : [fallback];
	} catch {
		return [fallback];
	}
}

/**
 * Merge a lease's branch back into the conversation that holds it — the point
 * of fanning work out in the first place.
 *
 * The counterpart is the HOLDING CONVERSATION's workspace, not the repository's
 * main checkout, so parallel sub-agent results gather into one branch that can
 * be reviewed and tested together before any of it reaches the shared tree.
 *
 * Direction mirrors `git_worktree_merge` and keeps the same asymmetry:
 *  - `to-source` moves the lease's commits into the conversation. A conflict
 *    there is always rolled back, because that tree is the one the user (and
 *    the orchestrator's own turns) are working in.
 *  - `from-source` refreshes the lease with the conversation's newer commits,
 *    and may leave a conflict in place for a sub-agent to resolve, since the
 *    lease is isolated — that is where conflict resolution belongs.
 */
export async function mergeLease(
	lease: Lease,
	conversation: Conversation,
	opts: {
		direction?: MergeDirection;
		allowMergeCommit?: boolean;
		onConflict?: 'abort' | 'keep';
		squash?: SquashMessage;
	} = {}
): Promise<MergeWorktreeResult> {
	const leasePath = resolveLeaseWorkspace(lease);
	const counterpart = leaseCounterpartWorkspace(conversation);
	const result = await mergeWorktree(leasePath, {
		direction: opts.direction ?? 'to-source',
		...(opts.allowMergeCommit === undefined ? {} : { allowMergeCommit: opts.allowMergeCommit }),
		...(opts.onConflict === undefined ? {} : { onConflict: opts.onConflict }),
		...(opts.squash === undefined ? {} : { squash: opts.squash }),
		upstreamPath: counterpart
	});
	touchLease(lease.id);
	log.info('lease.merged', {
		leaseId: lease.id,
		conversationId: conversation.id,
		direction: result.direction,
		merged: result.merged,
		into: result.into
	});
	return result;
}

/**
 * Where a lease sits relative to the conversation holding it: how many commits
 * it carries that the conversation lacks, and vice versa.
 */
export async function leaseIntegrationStatus(
	lease: Lease,
	conversation: Conversation
): Promise<WorktreeIntegrationStatus> {
	return worktreeIntegrationStatus(resolveLeaseWorkspace(lease), {
		upstreamPath: leaseCounterpartWorkspace(conversation)
	});
}

/**
 * Remove idle leases that hold nothing worth keeping.
 *
 * Skips a lease with uncommitted changes (removal would destroy it outright)
 * AND one with commits not yet merged into its holding conversation. The second
 * guard matters more here than on the delete path: the reaper runs on a timer
 * with nobody present, so collecting committed work would quietly turn it into
 * a branch no one is left to look for. Removal itself is non-destructive —
 * `deleteMergedBranch` is merged-only — but discoverability is the thing being
 * lost, and that is exactly what an automatic sweep must not take away.
 *
 * Note that `last_used_at` is bumped by lease tools and by browsing a lease in
 * the UI, but NOT by a sub-agent's ordinary file writes (those go through the
 * provider, which knows nothing about leases). So a sub-agent could in principle
 * still be using a lease the reaper collects. That is deliberate rather than
 * overlooked: reaching this point requires the tree to be clean AND fully merged
 * AND untouched for TTL, which together mean there is no work left to lose. A
 * sub-agent's cwd is the session workspace, not the lease, so nothing is
 * stranded either. Guarding on "is a turn running" would need a cross-module
 * predicate (leases -> turn-runner -> provider -> leases is a cycle), which is
 * more machinery than a no-loss inconvenience justifies.
 */
export async function reapIdleLeases(now = Date.now()): Promise<{ removed: number }> {
	const cutoff = now - loadConfig().WORKTREE_LEASE_TTL_MS;
	let removed = 0;
	for (const lease of leaseRepo.listIdle(cutoff)) {
		try {
			const { dirtyCount } = await inspectLease(lease);
			if (dirtyCount > 0) continue;
			const conversation = lease.heldByConversationId
				? convs.get(convCodec.parse(lease.heldByConversationId), lease.userId)
				: null;
			// A lease whose conversation is gone has no counterpart to measure
			// against; the FK cascade means the row is orphaned anyway, so let it go.
			if (conversation && (await unmergedCommitCount(lease, conversation)) > 0) continue;
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
 * FK cascade that removed the row's owner), then clear git's administrative
 * entries for those checkouts. Runs once at boot.
 *
 * Pruning is deliberately keyed on the distinct repositories the dropped rows
 * came from, and happens AFTER the rows are gone: a prune is only correct once
 * nothing expects the registration to still be there.
 */
export async function reconcileLeases(): Promise<{ rowsDropped: number; reposPruned: number }> {
	let rowsDropped = 0;
	const staleRepos = new Set<string>();
	for (const lease of leaseRepo.listAll()) {
		try {
			resolveLeaseWorkspace(lease);
		} catch {
			leaseRepo.remove(leaseCodec.parse(lease.id));
			staleRepos.add(lease.sourceWorkdir);
			rowsDropped++;
		}
	}
	let reposPruned = 0;
	for (const repo of staleRepos) {
		if (await pruneWorktrees(repo)) reposPruned++;
	}
	if (rowsDropped > 0) log.info('lease.reconciled', { rowsDropped, reposPruned });
	return { rowsDropped, reposPruned };
}
