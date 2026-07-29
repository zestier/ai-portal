import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { loadConfig } from './config';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;

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

export interface ManagedWorktreeMetadata {
	sourceWorkdir: string;
	path: string;
	gitCommonDir: string;
	branch: string;
	baseSha: string;
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

export interface CreateManagedWorktreeInput {
	sourceWorkdir: string;
	userId: string;
	conversationId: string;
	baseRef?: string;
}

export interface CreateManagedWorktreeFromSnapshotInput extends CreateManagedWorktreeInput {
	baseCommitSha?: string;
	treeSha: string;
}

interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
}

function runGit(cwd: string, args: string[], timeoutMs?: number): Promise<GitResult> {
	return new Promise((done) => {
		const child = spawn('git', args, {
			cwd,
			shell: false,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
				LC_ALL: 'C'
			}
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let timedOut = false;
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done({ stdout: stdout.toString(), stderr: stderr.toString(), code, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs ?? loadConfig().WORKTREE_CREATE_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on('data', (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) {
				stdout = Buffer.concat([stdout, chunk.subarray(0, MAX_OUTPUT_BYTES - stdout.length)]);
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 65_536) {
				stderr = Buffer.concat([stderr, chunk.subarray(0, 65_536 - stderr.length)]);
			}
		});
		child.on('error', (error) => {
			stderr = Buffer.concat([stderr, Buffer.from(`\n${error.message}`)]);
			finish(-1);
		});
		child.on('close', (code) => finish(code ?? -1));
	});
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
	const result = await runGit(cwd, args);
	if (result.code !== 0) {
		throw new WorktreeError(
			'git_failed',
			result.timedOut ? `git ${args[0]} timed out` : `git ${args[0]} failed`,
			{ stderr: result.stderr.trim() }
		);
	}
	return result.stdout.trim();
}

function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function assertIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_RE.test(value)) {
		throw new WorktreeError('invalid_identifier', `invalid ${label}`);
	}
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
function prepareGeneratedParent(path: string, slot: WorktreeSlot): void {
	const root = resolve(loadConfig().WORKTREE_ROOT);
	mkdirSync(dirname(path), { recursive: true });
	const expected = resolve(realpathSync(root), ...slotParentSegments(slot));
	const parentReal = realpathSync(dirname(path));
	if (parentReal !== expected) {
		throw new WorktreeError('invalid_identifier', 'generated worktree parent escapes root');
	}
}

export async function inspectRepository(sourceWorkdir: string): Promise<{
	sourceWorkdir: string;
	gitCommonDir: string;
	baseSha: string;
}> {
	const source = realpathOrResolve(sourceWorkdir);
	const inside = await runGit(source, ['rev-parse', '--is-inside-work-tree']);
	if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
		throw new WorktreeError('not_git_repository', 'source is not a git repository');
	}
	const topLevel = realpathOrResolve(await gitOk(source, ['rev-parse', '--show-toplevel']));
	const head = await runGit(topLevel, ['rev-parse', '--verify', 'HEAD^{commit}']);
	if (head.code !== 0) {
		throw new WorktreeError('repository_has_no_commits', 'repository has no commits');
	}
	const commonRaw = await gitOk(topLevel, [
		'rev-parse',
		'--path-format=absolute',
		'--git-common-dir'
	]);
	return {
		sourceWorkdir: topLevel,
		gitCommonDir: realpathOrResolve(commonRaw),
		baseSha: head.stdout.trim()
	};
}

type LockMap = Map<string, Promise<void>>;
const locks: LockMap = new Map();

async function withRepositoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((done) => (release = done));
	const queued = previous.then(() => current);
	locks.set(key, queued);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (locks.get(key) === queued) locks.delete(key);
	}
}

/**
 * Create a portal-owned linked worktree for any slot. Shared by conversation
 * primaries and leases so both get identical containment, locking, and
 * rollback behavior — the only difference is the derived path and branch.
 */
export async function createWorktreeForSlot(input: {
	sourceWorkdir: string;
	slot: WorktreeSlot;
	baseRef?: string;
	/** Runs inside the repository lock, after the checkout exists. */
	onCreated?: (metadata: ManagedWorktreeMetadata) => void | Promise<void>;
}): Promise<ManagedWorktreeMetadata> {
	const repository = await inspectRepository(input.sourceWorkdir);
	const path = slotPath(input.slot);
	const branch = slotBranch(input.slot);
	const baseRef = input.baseRef?.trim() || 'HEAD';
	if (baseRef.startsWith('-')) {
		throw new WorktreeError('invalid_base_ref', 'base ref cannot start with a dash');
	}
	const resolved = await runGit(repository.sourceWorkdir, [
		'rev-parse',
		'--verify',
		`${baseRef}^{commit}`
	]);
	if (resolved.code !== 0) {
		throw new WorktreeError('invalid_base_ref', `base ref does not resolve: ${baseRef}`);
	}
	const baseSha = resolved.stdout.trim();

	return withRepositoryLock(repository.gitCommonDir, async () => {
		if (existsSync(path)) {
			throw new WorktreeError('worktree_exists', 'managed worktree path already exists');
		}
		prepareGeneratedParent(path, input.slot);
		const existingBranch = await runGit(repository.sourceWorkdir, [
			'show-ref',
			'--verify',
			'--quiet',
			`refs/heads/${branch}`
		]);
		if (existingBranch.code === 0) {
			throw new WorktreeError('branch_exists', `branch already exists: ${branch}`);
		}
		const added = await runGit(repository.sourceWorkdir, [
			'worktree',
			'add',
			'-b',
			branch,
			path,
			baseSha
		]);
		if (added.code !== 0) {
			await runGit(repository.sourceWorkdir, ['worktree', 'remove', '--force', path]);
			if (existsSync(path)) rmSync(path, { recursive: true, force: true });
			// Do not delete the branch here: a concurrent external process may
			// have created it after our preflight check, causing this add to fail.
			// Deleting an ambiguously-owned branch would risk user data loss.
			throw new WorktreeError('git_failed', 'git worktree add failed', {
				stderr: added.stderr.trim()
			});
		}
		const metadata: ManagedWorktreeMetadata = {
			sourceWorkdir: repository.sourceWorkdir,
			path: realpathOrResolve(path),
			gitCommonDir: repository.gitCommonDir,
			branch,
			baseSha
		};
		if (input.onCreated) {
			// Persist-inside-the-lock hook. A throw here must not leave an orphan
			// checkout, so roll the worktree back before propagating.
			try {
				await input.onCreated(metadata);
			} catch (cause) {
				await runGit(repository.sourceWorkdir, ['worktree', 'remove', '--force', path]);
				if (existsSync(path)) rmSync(path, { recursive: true, force: true });
				await runGit(repository.sourceWorkdir, ['branch', '-D', branch]);
				throw cause;
			}
		}
		return metadata;
	});
}

export async function createManagedWorktree(
	input: CreateManagedWorktreeInput
): Promise<ManagedWorktreeMetadata> {
	return createWorktreeForSlot({
		sourceWorkdir: input.sourceWorkdir,
		slot: {
			kind: 'conversation',
			userId: input.userId,
			conversationId: input.conversationId
		},
		...(input.baseRef ? { baseRef: input.baseRef } : {})
	});
}

/**
 * Create a linked worktree at the snapshot's original HEAD, then overlay the
 * captured tree as ordinary unstaged/untracked changes.
 */
export async function createManagedWorktreeFromSnapshot(
	input: CreateManagedWorktreeFromSnapshotInput
): Promise<ManagedWorktreeMetadata> {
	if (
		(input.baseCommitSha !== undefined && !/^[0-9a-f]{40,64}$/.test(input.baseCommitSha)) ||
		!/^[0-9a-f]{40,64}$/.test(input.treeSha)
	) {
		throw new WorktreeError('invalid_base_ref', 'snapshot contains invalid git object ids');
	}
	const metadata = await createManagedWorktree({
		sourceWorkdir: input.sourceWorkdir,
		userId: input.userId,
		conversationId: input.conversationId,
		...(input.baseCommitSha ? { baseRef: input.baseCommitSha } : {})
	});
	try {
		await gitOk(metadata.path, ['read-tree', '--reset', '-u', input.treeSha]);
		await gitOk(metadata.path, ['reset', '--mixed', 'HEAD']);
		return metadata;
	} catch (cause) {
		await rollbackManagedWorktree(metadata).catch(() => undefined);
		throw cause;
	}
}

export async function inspectManagedWorktree(
	metadata: ManagedWorktreeMetadata
): Promise<{ dirtyCount: number }> {
	if (!existsSync(metadata.path)) {
		throw new WorktreeError('worktree_unavailable', 'managed worktree path is missing');
	}
	const actualCommon = realpathOrResolve(
		await gitOk(metadata.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	);
	if (actualCommon !== realpathOrResolve(metadata.gitCommonDir)) {
		throw new WorktreeError('worktree_unavailable', 'managed worktree repository does not match');
	}
	const status = await gitOk(metadata.path, ['status', '--porcelain=v1', '-uall']);
	return { dirtyCount: status ? status.split('\n').filter(Boolean).length : 0 };
}

export async function removeManagedWorktree(
	metadata: ManagedWorktreeMetadata,
	opts: { force?: boolean; owner?: WorktreeSlot } = {}
): Promise<void> {
	await withRepositoryLock(realpathOrResolve(metadata.gitCommonDir), async () => {
		if (!existsSync(metadata.path)) {
			await runGit(metadata.sourceWorkdir, ['worktree', 'prune']);
			return;
		}
		let dirtyCount: number;
		try {
			({ dirtyCount } = await inspectManagedWorktree(metadata));
		} catch (cause) {
			if (opts.force && opts.owner) {
				removeUnavailableOwnedWorktree(metadata.path, opts.owner);
				return;
			}
			throw cause;
		}
		if (dirtyCount > 0 && !opts.force) {
			throw new WorktreeError('worktree_dirty', 'managed worktree has uncommitted changes', {
				dirtyCount
			});
		}
		const args = ['worktree', 'remove'];
		if (opts.force) args.push('--force');
		args.push(metadata.path);
		const removed = await runGit(metadata.sourceWorkdir, args);
		if (removed.code !== 0) {
			throw new WorktreeError('git_failed', 'git worktree remove failed', {
				stderr: removed.stderr.trim()
			});
		}
	});
}

function removeUnavailableOwnedWorktree(path: string, owner: WorktreeSlot): void {
	const expected = realpathOrResolve(slotPath(owner));
	const stored = resolve(path);
	try {
		const entry = lstatSync(stored);
		if (entry.isSymbolicLink() || !entry.isDirectory() || realpathSync(stored) !== expected) {
			throw new Error('path does not resolve to the owned worktree');
		}
	} catch {
		throw new WorktreeError(
			'worktree_unavailable',
			'managed worktree path cannot be safely force-removed'
		);
	}
	if (stored !== expected) {
		throw new WorktreeError(
			'worktree_unavailable',
			'managed worktree path cannot be safely force-removed'
		);
	}
	rmSync(stored, { recursive: true, force: true });
}

/** Roll back a just-created worktree when later persistence fails. */
export async function rollbackManagedWorktree(metadata: ManagedWorktreeMetadata): Promise<void> {
	await removeManagedWorktree(metadata, { force: true });
	await runGit(metadata.sourceWorkdir, ['branch', '-D', metadata.branch]);
}

/**
 * Delete a branch only if it is fully merged (`git branch -d`, never `-D`).
 *
 * Returns false when the branch was kept because it still holds unmerged
 * commits. This is what makes dropping a lease non-destructive: the checkout
 * goes away, but committed work survives under its branch name for the user to
 * merge or delete deliberately.
 */
export async function deleteMergedBranch(cwd: string, branch: string): Promise<boolean> {
	const result = await runGit(cwd, ['branch', '-d', branch]);
	return result.code === 0;
}

export function expectedManagedWorktreePath(userId: string, conversationId: string): string {
	return generatedPath(userId, conversationId);
}
