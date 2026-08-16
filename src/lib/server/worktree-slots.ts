import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { loadConfig } from './config';

export type WorktreeErrorCode =
	| 'not_git_repository'
	| 'repository_has_no_commits'
	| 'invalid_base_ref'
	| 'invalid_identifier'
	| 'branch_exists'
	| 'worktree_exists'
	| 'worktree_dirty'
	| 'worktree_unavailable'
	| 'git_failed';

export class WorktreeError extends Error {
	constructor(
		public readonly code: WorktreeErrorCode,
		message: string,
		public readonly detail?: { stderr?: string; dirtyCount?: number }
	) {
		super(message);
		this.name = 'WorktreeError';
	}
}

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;

function assertIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_RE.test(value)) {
		throw new WorktreeError('invalid_identifier', `invalid ${label}`);
	}
}

/**
 * Identifies which portal-owned checkout a path/branch is being derived for.
 *
 * Both slots live under WORKTREE_ROOT but in sibling namespaces:
 *   conversation → <root>/<userId>/<conversationId>       branch portal/<conversationId>
 *   lease        → <root>/<userId>/leases/<leaseId>       branch portal/lease/<leaseId>
 *
 * Deriving (rather than storing) these is what lets resolution fail closed: a
 * persisted path is only ever trusted after being recomputed from ids and
 * checked against the real filesystem.
 */
export type WorktreeSlot =
	| { kind: 'conversation'; userId: string; conversationId: string }
	| { kind: 'lease'; userId: string; leaseId: string; label?: string };

/**
 * Directory segment separating lease checkouts from conversation checkouts
 * under a user's worktree root. Reserved: a conversation whose id equalled this
 * would collide with the lease namespace, so {@link slotPath} rejects it.
 */
const LEASE_NAMESPACE = 'leases';

const LEASE_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,32}$/;

/**
 * Validate an agent-supplied lease label. Labels are cosmetic — they make a
 * generated branch name readable — so they are REJECTED rather than coerced
 * when malformed: silently rewriting a label would hand back a branch name the
 * caller did not ask for.
 */
export function sanitizeLeaseLabel(label: string): string {
	const trimmed = label.trim();
	if (!LEASE_LABEL_RE.test(trimmed)) {
		throw new WorktreeError(
			'invalid_identifier',
			'label must be 1-33 chars of lowercase letters, digits, or dashes, and start with a letter or digit'
		);
	}
	return trimmed;
}

/**
 * Derive the owned on-disk path for a slot, proving it stays inside
 * WORKTREE_ROOT. Every id component is validated as an identifier, so a
 * traversal segment can never reach the filesystem.
 */
export function slotPath(slot: WorktreeSlot): string {
	assertIdentifier(slot.userId, 'user id');
	const root = resolve(loadConfig().WORKTREE_ROOT);
	let candidate: string;
	if (slot.kind === 'conversation') {
		assertIdentifier(slot.conversationId, 'conversation id');
		// The lease namespace is a sibling directory under the same user root, so
		// a conversation literally named "leases" would own the whole namespace.
		// Unreachable with ULID ids, but IDENTIFIER_RE permits lowercase.
		if (slot.conversationId === LEASE_NAMESPACE) {
			throw new WorktreeError('invalid_identifier', 'conversation id is reserved');
		}
		candidate = resolve(root, slot.userId, slot.conversationId);
	} else {
		assertIdentifier(slot.leaseId, 'lease id');
		candidate = resolve(root, slot.userId, LEASE_NAMESPACE, slot.leaseId);
	}
	const rel = relative(root, candidate);
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new WorktreeError('invalid_identifier', 'generated worktree path escapes root');
	}
	return candidate;
}

/**
 * Derive the branch name for a slot. Lease branches are namespaced under
 * `portal/lease/` so they can never collide with a conversation's
 * `portal/<conversationId>` branch.
 */
export function slotBranch(slot: WorktreeSlot): string {
	if (slot.kind === 'conversation') {
		assertIdentifier(slot.conversationId, 'conversation id');
		return `portal/${slot.conversationId}`;
	}
	assertIdentifier(slot.leaseId, 'lease id');
	const base = `portal/lease/${slot.leaseId}`;
	return slot.label ? `${base}--${sanitizeLeaseLabel(slot.label)}` : base;
}

/** The path segments below WORKTREE_ROOT that contain a slot's checkout. */
function slotParentSegments(slot: WorktreeSlot): string[] {
	return slot.kind === 'conversation' ? [slot.userId] : [slot.userId, LEASE_NAMESPACE];
}

function generatedPath(userId: string, conversationId: string): string {
	return slotPath({ kind: 'conversation', userId, conversationId });
}

/**
 * Create the parent directory for a generated checkout and verify it is exactly
 * the slot's expected location.
 *
 * The expected value is the LEXICAL join of the real root and the slot's
 * segments — deliberately not `realpath(parent)`, which would follow an
 * escaping symlink and compare it to itself, defeating the check. Resolving
 * only one side is what detects a planted `<root>/<user> -> /elsewhere` link.
 */
export function prepareGeneratedParent(path: string, slot: WorktreeSlot): void {
	const root = resolve(loadConfig().WORKTREE_ROOT);
	mkdirSync(dirname(path), { recursive: true });
	const expected = resolve(realpathSync(root), ...slotParentSegments(slot));
	const parentReal = realpathSync(dirname(path));
	if (parentReal !== expected) {
		throw new WorktreeError('invalid_identifier', 'generated worktree parent escapes root');
	}
}

export function expectedManagedWorktreePath(userId: string, conversationId: string): string {
	return generatedPath(userId, conversationId);
}
