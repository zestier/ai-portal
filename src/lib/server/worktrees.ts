import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { loadConfig } from './config';
import { withRepositoryLock } from './repo-lock';

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

function generatedPath(userId: string, conversationId: string): string {
	assertIdentifier(userId, 'user id');
	assertIdentifier(conversationId, 'conversation id');
	const root = resolve(loadConfig().WORKTREE_ROOT);
	const candidate = resolve(root, userId, conversationId);
	const rel = relative(root, candidate);
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new WorktreeError('invalid_identifier', 'generated worktree path escapes root');
	}
	return candidate;
}

function prepareGeneratedParent(path: string, userId: string): void {
	const root = resolve(loadConfig().WORKTREE_ROOT);
	mkdirSync(dirname(path), { recursive: true });
	const rootReal = realpathSync(root);
	const parentReal = realpathSync(dirname(path));
	if (parentReal !== resolve(rootReal, userId)) {
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

export async function createManagedWorktree(
	input: CreateManagedWorktreeInput
): Promise<ManagedWorktreeMetadata> {
	const repository = await inspectRepository(input.sourceWorkdir);
	const path = generatedPath(input.userId, input.conversationId);
	const branch = `portal/${input.conversationId}`;
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
		prepareGeneratedParent(path, input.userId);
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
		return {
			sourceWorkdir: repository.sourceWorkdir,
			path: realpathOrResolve(path),
			gitCommonDir: repository.gitCommonDir,
			branch,
			baseSha
		};
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
	opts: { force?: boolean; owner?: { userId: string; conversationId: string } } = {}
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

function removeUnavailableOwnedWorktree(
	path: string,
	owner: { userId: string; conversationId: string }
): void {
	const expected = realpathOrResolve(
		expectedManagedWorktreePath(owner.userId, owner.conversationId)
	);
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

export function expectedManagedWorktreePath(userId: string, conversationId: string): string {
	return generatedPath(userId, conversationId);
}
