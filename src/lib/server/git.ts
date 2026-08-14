// Thin, safe wrapper over the `git` CLI.
//
// All commands are spawned with `shell: false`, an explicit cwd, a hard
// timeout, and a capped output size. Path arguments are always validated
// against the workdir realpath via `files.safeResolve` and passed after a
// `--` separator so they can't be interpreted as flags.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isolatedChildEnv } from './child-env';
import { safeResolve } from './files';
import { log as logger } from './log';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
	truncated: boolean;
}

export class GitError extends Error {
	constructor(
		message: string,
		public readonly result: GitRunResult
	) {
		super(message);
		this.name = 'GitError';
	}
}

export interface RunOptions {
	cwd: string;
	timeoutMs?: number | undefined;
	maxBytes?: number | undefined;
	// Optional streaming hook. When provided, invoked with the full cumulative
	// combined (stdout+stderr, in arrival order) snapshot each time child output
	// arrives. The snapshot is bounded by `maxBytes`, so emission size stays
	// capped. Callers that omit this stay fully buffered/silent (unchanged).
	onData?: ((snapshot: string) => void) | undefined;
	// Optional abort signal. When it fires, the child is SIGKILLed and no further
	// `onData` snapshots are emitted (mirrors the existing timeout kill path).
	signal?: AbortSignal | undefined;
}

// Streaming context for `commitChanges`. Structurally satisfied by the tool
// layer's `ToolStreamContext`, but kept independent here to avoid a server→tools
// import cycle. All fields optional so non-streaming callers pass nothing.
export interface CommitProgress {
	progress?(message: string): void;
	partial?(snapshot: string): void;
	readonly signal?: AbortSignal | undefined;
}

function runGit(args: string[], opts: RunOptions): Promise<GitRunResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	return new Promise((resolve) => {
		const child = spawn('git', args, {
			cwd: opts.cwd,
			shell: false,
			env: isolatedChildEnv(process.env, {
				// Disable interactive prompts and pagers. Git hooks still run for commits.
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
				GIT_OPTIONAL_LOCKS: '0',
				LC_ALL: 'C'
			})
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const settle = (result: GitRunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanupSignal();
			resolve(result);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);

		// Combined stdout+stderr buffer in arrival order, only maintained when a
		// streaming consumer is attached. Emitting the full current string each
		// time matches `tool.partial_output` replace-not-append semantics. Bounded
		// by `maxBytes` so snapshot (and downstream queue) growth stays capped.
		const onData = opts.onData;
		let combined = onData ? Buffer.alloc(0) : null;
		const emitSnapshot = (chunk: Buffer) => {
			if (!onData || combined === null || aborted) return;
			if (combined.length >= maxBytes) return;
			const room = maxBytes - combined.length;
			combined = Buffer.concat([combined, chunk.subarray(0, room)]);
			onData(combined.toString('utf-8'));
		};

		let aborted = false;
		const signal = opts.signal;
		const killForAbort = () => {
			aborted = true;
			child.kill('SIGKILL');
			// Resolve promptly rather than waiting for `close`: an orphaned hook
			// process can keep the stdio pipes open after the git child is killed,
			// which would otherwise stall `close` until the hook itself exits.
			settle({
				stdout: stdout.toString('utf-8'),
				stderr: stderr.toString('utf-8'),
				code: -1,
				timedOut,
				truncated
			});
		};
		const cleanupSignal = () => {
			if (signal) signal.removeEventListener('abort', killForAbort);
		};
		if (signal) {
			if (signal.aborted) {
				killForAbort();
			} else {
				signal.addEventListener('abort', killForAbort, { once: true });
			}
		}

		child.stdout.on('data', (chunk: Buffer) => {
			if (stdout.length >= maxBytes) {
				truncated = true;
				return;
			}
			const room = maxBytes - stdout.length;
			const slice = chunk.subarray(0, room);
			stdout = Buffer.concat([stdout, slice]);
			emitSnapshot(slice);
			if (chunk.length > room) {
				truncated = true;
				child.stdout.destroy();
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			// Cap stderr at 64 KiB to avoid runaway logs.
			if (stderr.length < 65_536) {
				const slice = chunk.subarray(0, 65_536 - stderr.length);
				stderr = Buffer.concat([stderr, slice]);
				emitSnapshot(slice);
			}
		});
		child.on('error', (err) => {
			settle({
				stdout: stdout.toString('utf-8'),
				stderr: (stderr.toString('utf-8') + '\n' + err.message).trim(),
				code: -1,
				timedOut,
				truncated
			});
		});
		child.on('close', (code) => {
			settle({
				stdout: stdout.toString('utf-8'),
				stderr: stderr.toString('utf-8'),
				code: code ?? -1,
				timedOut,
				truncated
			});
		});
	});
}

// Exposed for sibling server modules (e.g. `worktree-integration`) that need the
// same hardened spawn wrapper — no shell, explicit cwd, hard timeout, capped
// output — rather than re-implementing it. Not for route/tool code, which should
// use the typed helpers below.
export { runGit as runGitRaw };

async function runGitOk(args: string[], opts: RunOptions): Promise<string> {
	const r = await runGit(args, opts);
	if (r.timedOut) throw new GitError('git command timed out', r);
	if (r.code !== 0) throw new GitError(`git ${args[0]} exited ${r.code}: ${r.stderr.trim()}`, r);
	return r.stdout;
}

// ---------- Public API ----------

export interface RepoInitState {
	initialized: false;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
	return r.code === 0 && r.stdout.trim() === 'true';
}

export async function repositoryRoot(cwd: string): Promise<string> {
	if (!(await isGitRepo(cwd))) throw new GitError('not a git repository', emptyResult());
	return (await runGitOk(['rev-parse', '--show-toplevel'], { cwd })).trim();
}

/**
 * The repository's git common dir — the key every mutating operation locks on.
 *
 * Shared by a repository's main checkout and all of its linked worktrees, so a
 * commit in a lease serializes against a merge or worktree removal in the same
 * repository. Realpath'd to match `worktrees.ts` / `worktree-integration.ts`,
 * which resolve it too: an unresolved symlink would silently produce a second,
 * non-excluding lock key.
 *
 * Throws rather than falling back to the cwd when git cannot answer. A fallback
 * key would look like locking while excluding nothing — the exact silent,
 * timing-dependent failure `repo-lock.ts` exists to prevent — and a caller that
 * cannot reach git has nothing to commit anyway.
 */
export async function repositoryLockKey(cwd: string): Promise<string> {
	const r = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
	const raw = r.code === 0 ? r.stdout.trim() : '';
	if (!raw) {
		throw new GitError('not a git repository: could not determine the git common dir', r);
	}
	try {
		return realpathSync(raw);
	} catch {
		return resolve(raw);
	}
}

export interface HeadInfo {
	initialized: true;
	branch: string | null;
	sha: string | null;
	shortSha: string | null;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	dirtyCount: number;
}

export async function headInfo(cwd: string): Promise<HeadInfo | RepoInitState> {
	if (!(await isGitRepo(cwd))) return { initialized: false };
	const sha = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim() || null;
	const shortSha = sha ? sha.slice(0, 8) : null;
	const branchOut = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
	const branch = branchOut.code === 0 ? branchOut.stdout.trim() : null;
	const detached = branch === null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	const upRes = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
		cwd
	});
	if (upRes.code === 0) {
		upstream = upRes.stdout.trim() || null;
		if (upstream) {
			const counts = await runGit(['rev-list', '--left-right', '--count', `HEAD...@{upstream}`], {
				cwd
			});
			if (counts.code === 0) {
				const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
				if (Number.isFinite(a)) ahead = a;
				if (Number.isFinite(b)) behind = b;
			}
		}
	}
	const statusOut = await runGit(['status', '--porcelain=v1', '-uall'], { cwd });
	const dirtyCount = statusOut.code === 0 ? statusOut.stdout.split('\n').filter(Boolean).length : 0;
	return {
		initialized: true,
		branch,
		sha,
		shortSha,
		detached,
		upstream,
		ahead,
		behind,
		dirtyCount
	};
}

export type StatusCode =
	| 'unmodified'
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'copied'
	| 'updated'
	| 'untracked'
	| 'ignored'
	| 'conflicted';

export interface StatusEntry {
	/** POSIX-style path relative to repo root. */
	path: string;
	/** Original path for renames/copies. */
	origPath: string | null;
	/** Index (staged) status. */
	index: StatusCode;
	/** Working tree status. */
	worktree: StatusCode;
}

const STATUS_MAP: Record<string, StatusCode> = {
	' ': 'unmodified',
	M: 'modified',
	A: 'added',
	D: 'deleted',
	R: 'renamed',
	C: 'copied',
	U: 'updated',
	'?': 'untracked',
	'!': 'ignored'
};

function decodeStatusChar(c: string): StatusCode {
	return STATUS_MAP[c] ?? 'unmodified';
}

export interface StatusOptions {
	includeIgnored?: boolean;
}

/**
 * Collapse a {@link StatusEntry} into a single high-level status value, mirroring
 * how the UI presents a path. Returns `null` for unmodified entries (and for
 * ignored entries when `includeIgnored` is false).
 */
export function aggregateStatus(
	e: StatusEntry,
	opts: { includeIgnored?: boolean } = {}
): 'untracked' | 'ignored' | 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted' | null {
	if (e.index === 'conflicted' || e.worktree === 'conflicted') return 'conflicted';
	if (e.index === 'untracked' || e.worktree === 'untracked') return 'untracked';
	if (opts.includeIgnored && (e.index === 'ignored' || e.worktree === 'ignored')) return 'ignored';
	if (e.index === 'renamed' || e.worktree === 'renamed') return 'renamed';
	if (e.index === 'added' || e.worktree === 'added') return 'added';
	if (e.index === 'deleted' || e.worktree === 'deleted') return 'deleted';
	if (e.index === 'modified' || e.worktree === 'modified') return 'modified';
	return null;
}

/**
 * Returns one entry per changed (or untracked/ignored) path. Unchanged
 * tracked files are omitted to keep the response small; the UI merges
 * statuses into directory listings client-side or via `mergeStatusIntoTree`.
 */
export async function status(cwd: string, opts: StatusOptions = {}): Promise<StatusEntry[]> {
	const args = ['status', '--porcelain=v1', '-uall', '-z'];
	if (opts.includeIgnored) args.push('--ignored');
	const out = await runGitOk(args, { cwd });
	// -z output: entries separated by NUL. For R/C entries there are two
	// NUL-separated paths.
	const entries: StatusEntry[] = [];
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (!rec) continue;
		if (rec.length < 3) continue;
		const xy = rec.slice(0, 2);
		const path = rec.slice(3);
		let origPath: string | null = null;
		if (xy[0] === 'R' || xy[0] === 'C') {
			// Next part is the original path.
			origPath = parts[i + 1] ?? null;
			i++;
		}
		// Conflicted entries are codes like DD, AU, UD, UA, DU, AA, UU.
		const conflictPairs = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
		if (conflictPairs.has(xy)) {
			entries.push({ path, origPath, index: 'conflicted', worktree: 'conflicted' });
			continue;
		}
		if (xy === '??') {
			entries.push({ path, origPath, index: 'untracked', worktree: 'untracked' });
			continue;
		}
		if (xy === '!!') {
			entries.push({ path, origPath, index: 'ignored', worktree: 'ignored' });
			continue;
		}
		entries.push({
			path,
			origPath,
			index: decodeStatusChar(xy[0]),
			worktree: decodeStatusChar(xy[1])
		});
	}
	return entries;
}

export async function discardAllLocalChanges(cwd: string): Promise<void> {
	if (!(await isGitRepo(cwd))) throw new GitError('not a git repository', emptyResult());

	const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd });
	if (head.code === 0) {
		await runGitOk(['reset', '--hard', 'HEAD'], { cwd });
	} else {
		const entries = await status(cwd);
		const hasIndexEntries = entries.some(
			(e) => e.index !== 'unmodified' && e.index !== 'untracked' && e.index !== 'ignored'
		);
		if (hasIndexEntries) {
			await runGitOk(['rm', '-r', '--cached', '--ignore-unmatch', '--', '.'], { cwd });
		}
	}
	await runGitOk(['clean', '-fd'], { cwd });
}

export interface LogEntry {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
}

const LOG_SEP = '\x1f';
const LOG_REC = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%at', '%s'].join(LOG_SEP) + LOG_REC;
const REF_RE = /^[A-Za-z0-9._\-/@^~]+$/;

// Reflog/stash selectors (`@{...}`, `stash`, `refs/stash`) can expose
// deliberately-uncommitted content, so they are rejected even though their
// characters pass REF_RE.
const STASH_REF_RE = /^(refs\/)?stash$/;

function isSafeRef(ref: string): boolean {
	if (!REF_RE.test(ref) || ref.startsWith('-')) return false;
	if (ref.includes('@{')) return false;
	if (STASH_REF_RE.test(ref)) return false;
	return true;
}

export async function log(
	cwd: string,
	opts: {
		limit?: number | undefined;
		skip?: number | undefined;
		ref?: string | undefined;
		path?: string | undefined;
	} = {}
): Promise<LogEntry[]> {
	const limit = Math.min(opts.limit ?? 20, 200);
	const skip = Math.max(opts.skip ?? 0, 0);
	const args = ['log', `--max-count=${limit}`, `--skip=${skip}`, `--pretty=format:${LOG_FORMAT}`];
	if (opts.ref) {
		// Only allow refs matching a conservative pattern (no spaces, no
		// flags, no shell metacharacters).
		if (!isSafeRef(opts.ref)) {
			throw new GitError('invalid ref', {
				stdout: '',
				stderr: 'invalid ref',
				code: -1,
				timedOut: false,
				truncated: false
			});
		}
		args.push(opts.ref);
	}
	if (opts.path !== undefined && opts.path !== '') {
		const r = safeResolve(cwd, opts.path);
		if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
		args.push('--', r.rel);
	}
	const out = await runGitOk(args, { cwd });
	const records = out.split(LOG_REC).filter((s) => s.length > 0);
	return records.map((rec) => {
		const [sha, shortSha, author, email, ts, ...subjectParts] = rec.trim().split(LOG_SEP);
		return {
			sha,
			shortSha,
			author,
			email,
			timestamp: Number(ts) * 1000,
			subject: subjectParts.join(LOG_SEP)
		};
	});
}

const SHA_RE = /^[0-9a-f]{4,64}$/;

export interface CommitFile {
	status: StatusCode;
	path: string;
	origPath: string | null;
}

export interface CommitDetail {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
	body: string;
	parents: string[];
	files: CommitFile[];
	patch?: string;
}

export async function showCommit(
	cwd: string,
	sha: string,
	opts: { includePatch?: boolean } = {}
): Promise<CommitDetail> {
	if (!SHA_RE.test(sha)) throw new GitError('invalid sha', emptyResult());
	const SEP = '\x1f';
	const fmt = ['%H', '%h', '%an', '%ae', '%at', '%P', '%s', '%b'].join(SEP);
	const meta = await runGitOk(['show', '-s', `--pretty=format:${fmt}`, sha], { cwd });
	const [full, shortSha, author, email, ts, parentsRaw, subject, ...bodyParts] = meta.split(SEP);
	const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
	// Changed files via name-status.
	const nameStatus = await runGitOk(['show', '--name-status', '--format=', '-z', sha], { cwd });
	const files: CommitFile[] = [];
	const parts = nameStatus.split('\0').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i];
		// Status codes: M, A, D, T, R100, C75, ...
		const head = code[0];
		if (head === 'R' || head === 'C') {
			const orig = parts[++i] ?? '';
			const dest = parts[++i] ?? '';
			files.push({
				status: head === 'R' ? 'renamed' : 'copied',
				path: dest,
				origPath: orig
			});
		} else {
			const path = parts[++i] ?? '';
			files.push({
				status: decodeStatusChar(head),
				path,
				origPath: null
			});
		}
	}
	const detail: CommitDetail = {
		sha: full,
		shortSha,
		author,
		email,
		timestamp: Number(ts) * 1000,
		subject,
		body: bodyParts.join(SEP).trim(),
		parents,
		files
	};
	if (opts.includePatch) {
		detail.patch = await runGitOk(
			['show', '--no-color', '--no-ext-diff', '--format=', '--patch', sha],
			{
				cwd,
				maxBytes: DEFAULT_MAX_BYTES
			}
		);
	}
	return detail;
}

export type DiffTarget =
	| { kind: 'worktree-vs-head' }
	| { kind: 'worktree-vs-index' }
	| { kind: 'index-vs-head' }
	| { kind: 'commit'; sha: string }
	| { kind: 'commit-vs-parent'; sha: string };

function diffPathArgs(cwd: string, relPath?: string): string[] {
	if (relPath !== undefined && relPath !== '') {
		const r = safeResolve(cwd, relPath);
		if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
		return ['--', r.rel];
	}
	return [];
}

function diffArgs(
	cwd: string,
	target: DiffTarget,
	extraArgs: string[] = [],
	relPath?: string
): string[] {
	const pathArgs = diffPathArgs(cwd, relPath);
	const baseArgs = ['diff', '--no-color', '--no-ext-diff', ...extraArgs];
	switch (target.kind) {
		case 'worktree-vs-head':
			return [...baseArgs, 'HEAD', ...pathArgs];
		case 'worktree-vs-index':
			return [...baseArgs, ...pathArgs];
		case 'index-vs-head':
			return [...baseArgs, '--cached', ...pathArgs];
		case 'commit': {
			if (!SHA_RE.test(target.sha)) throw new GitError('invalid sha', emptyResult());
			return [...baseArgs, `${target.sha}^!`, ...pathArgs];
		}
		case 'commit-vs-parent': {
			if (!SHA_RE.test(target.sha)) throw new GitError('invalid sha', emptyResult());
			return [...baseArgs, `${target.sha}^`, target.sha, ...pathArgs];
		}
	}
}

/**
 * Returns a unified diff for an optional path. If `relPath` is provided it
 * must be resolvable inside `cwd`.
 */
export async function diff(cwd: string, target: DiffTarget, relPath?: string): Promise<string> {
	const args = diffArgs(cwd, target, [], relPath);
	return await runGitOk(args, { cwd, maxBytes: DEFAULT_MAX_BYTES });
}

/** Read a file at a specific revision. */
export async function showFile(cwd: string, ref: string, relPath: string): Promise<string> {
	if (!isSafeRef(ref)) throw new GitError('invalid ref', emptyResult());
	const r = safeResolve(cwd, relPath);
	if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
	// `git show <ref>:<path>` resolves <path> relative to the repository root,
	// not `cwd`. When the workdir is a subdirectory, recompute the path
	// relative to the repo root so the correct blob is read.
	const repoRoot = await repositoryRoot(cwd);
	const repoRootReal = existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
	const treePath = relative(repoRootReal, r.abs).split(sep).join('/');
	if (treePath === '' || treePath === '..' || treePath.startsWith('../')) {
		throw new GitError('invalid path', emptyResult());
	}
	return await runGitOk(['show', `${ref}:${treePath}`], { cwd: repoRoot });
}

export interface CommitTrailer {
	token: string;
	value: string;
}

export interface CommitChangesOptions {
	paths: 'all' | string[];
	subject: string;
	body?: string | undefined;
	trailers?: CommitTrailer[] | undefined;
	/**
	 * Allow committing a previously-conflicted file that still contains conflict
	 * markers. Off by default: the overwhelmingly likely reason a resolved file
	 * still has `<<<<<<<` in it is that it was never actually resolved, and
	 * committing that is silent corruption. The escape hatch exists because a
	 * file can legitimately contain marker-shaped lines (documentation about
	 * conflicts, test fixtures).
	 */
	allowConflictMarkers?: boolean | undefined;
}

/** In-progress merge state for a tree, as needed to finish or roll one back. */
export interface MergeState {
	/** True when the tree is mid-merge (a `MERGE_HEAD` exists). */
	inProgress: boolean;
	/** The commit being merged in, when one is recorded. */
	mergeHeadSha: string | null;
	/** Paths git still considers unmerged (conflicted). */
	conflictedPaths: string[];
	/**
	 * The sequenced operation the tree is in the middle of, when it is not a
	 * plain merge. A rebase or a multi-commit cherry-pick/revert has MORE work
	 * queued after the current conflict is committed, and the portal has no
	 * structured `--continue` for it — so it must be reported rather than
	 * described as finishable, which is the difference between honest guidance
	 * and pointing an agent at a dead end.
	 */
	sequencer: 'rebase' | 'cherry-pick' | 'revert' | null;
}

/**
 * Report whether a tree is mid-merge, mid-sequencer, and which paths are still
 * unmerged.
 *
 * The parts matter independently: a merge can be in progress with every conflict
 * already staged (ready to commit), and unmerged index entries can exist with no
 * `MERGE_HEAD` (a conflicted `git stash pop`, cherry-pick, or rebase).
 */
export async function mergeState(cwd: string): Promise<MergeState> {
	const repoRoot = await repositoryRoot(cwd);
	const head = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repoRoot });
	const mergeHeadSha = head.code === 0 ? head.stdout.trim() || null : null;
	return {
		inProgress: mergeHeadSha !== null,
		mergeHeadSha,
		conflictedPaths: await unmergedPaths(repoRoot),
		sequencer: await sequencerState(repoRoot)
	};
}

/** Which sequenced operation (if any) the tree is in the middle of. */
async function sequencerState(
	repoRoot: string
): Promise<'rebase' | 'cherry-pick' | 'revert' | null> {
	const gitPath = async (name: string): Promise<string | null> => {
		const r = await runGit(['rev-parse', '--git-path', name], { cwd: repoRoot });
		if (r.code !== 0) return null;
		const raw = r.stdout.trim();
		if (!raw) return null;
		return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
	};
	for (const dir of ['rebase-merge', 'rebase-apply']) {
		const path = await gitPath(dir);
		if (path && existsSync(path)) return 'rebase';
	}
	// `CHERRY_PICK_HEAD`/`REVERT_HEAD` mark the current conflicted pick; the
	// `sequencer` directory means further picks are still queued behind it.
	for (const [file, kind] of [
		['CHERRY_PICK_HEAD', 'cherry-pick'],
		['REVERT_HEAD', 'revert']
	] as const) {
		const path = await gitPath(file);
		if (path && existsSync(path)) return kind;
	}
	const seq = await gitPath('sequencer');
	if (seq && existsSync(seq)) return 'cherry-pick';
	return null;
}

/**
 * `git merge --abort` — roll an in-progress merge back to pre-merge HEAD.
 *
 * The counterpart to committing a resolution: without it a tree left mid-merge
 * by `onConflict: "keep"` has no structured way out, since a conflicted tree can
 * neither be committed (until resolved) nor merged (it is dirty).
 *
 * Destructive by nature — it discards whatever resolution work is in the tree —
 * so it refuses when no merge is in progress rather than falling through to
 * git's own broader reset behavior.
 */
export async function abortMerge(cwd: string): Promise<{ headSha: string }> {
	const repoRoot = await repositoryRoot(cwd);
	const state = await mergeState(repoRoot);
	if (!state.inProgress) {
		throw new GitError('no merge is in progress in this tree', emptyResult());
	}
	await runGitOk(['merge', '--abort'], { cwd: repoRoot, timeoutMs: 60_000 });
	return { headSha: (await runGitOk(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim() };
}

/** Paths with unmerged index entries, relative to the repo root. */
async function unmergedPaths(repoRoot: string): Promise<string[]> {
	const out = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: repoRoot });
	if (out.code !== 0) return [];
	return out.stdout.split('\0').filter(Boolean);
}

/**
 * True when `content` still carries git's conflict markers.
 *
 * Matches a line STARTING with `<<<<<<<`, `|||||||`, or `>>>>>>>`, so a
 * half-cleaned conflict — the realistic botched resolution — is caught, not just
 * an untouched one. A bare `=======` is deliberately not a marker on its own:
 * it is a Markdown/RST heading underline, and flagging it would refuse ordinary
 * documentation commits.
 */
export function hasConflictMarkers(content: string): boolean {
	for (const line of content.split('\n')) {
		if (line.startsWith('<<<<<<<') || line.startsWith('>>>>>>>') || line.startsWith('|||||||')) {
			return true;
		}
	}
	return false;
}

export interface CommitChangesResult {
	sha: string;
	shortSha: string;
	subject: string;
	body: string;
	trailers: CommitTrailer[];
	files: NameStatusEntry[];
	fileStats: NumstatEntry[];
	diffStat: DiffStat['total'];
	remainingDirtyFiles: Array<StatusEntry & { status: ReturnType<typeof aggregateStatus> }>;
	/** True when this commit concluded an in-progress merge (it has 2+ parents). */
	mergeCommit: boolean;
	/** Paths that were unmerged going in and were resolved by this commit. */
	resolvedConflicts: string[];
}

const TRAILER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function formatCommitMessage(opts: {
	subject: string;
	body?: string | undefined;
	trailers?: CommitTrailer[] | undefined;
}): string {
	if (!opts.subject.trim()) throw new GitError('commit subject is required', emptyResult());
	if (hasControlCharacter(opts.subject)) {
		throw new GitError(
			'commit subject must be a single line without control characters',
			emptyResult()
		);
	}
	const lines = [opts.subject];
	const body = opts.body;
	if (body !== undefined && body.length > 0) {
		if (hasControlCharacter(body, { allowWhitespace: true }))
			throw new GitError('commit body must not contain control characters', emptyResult());
		lines.push('', body.trimEnd());
	}
	if (opts.trailers?.length) {
		lines.push('');
		for (const trailer of opts.trailers) {
			if (
				!TRAILER_TOKEN_RE.test(trailer.token) ||
				trailer.token.includes('\n') ||
				trailer.token.includes('\r') ||
				hasControlCharacter(trailer.token)
			) {
				throw new GitError(`invalid trailer token: ${trailer.token}`, emptyResult());
			}
			if (
				trailer.value.includes('\n') ||
				trailer.value.includes('\r') ||
				hasControlCharacter(trailer.value)
			) {
				throw new GitError(`invalid trailer value for ${trailer.token}`, emptyResult());
			}
			lines.push(`${trailer.token}: ${trailer.value}`);
		}
	}
	return lines.join('\n') + '\n';
}

export async function commitChanges(
	cwd: string,
	opts: CommitChangesOptions,
	ctx?: CommitProgress
): Promise<CommitChangesResult> {
	const repoRoot = await repositoryRoot(cwd);
	const commitMessage = formatCommitMessage(opts);
	const entries = await status(repoRoot);
	const merge = await mergeState(repoRoot);
	const mergeInProgress = merge.inProgress;
	const conflicts = entries.filter((e) => e.index === 'conflicted' || e.worktree === 'conflicted');
	// True when this commit is the one that concludes a merge / clears a
	// conflicted index, which changes what `paths: "all"` may stage and whether
	// an empty staged diff is a reason to refuse.
	const concludesMerge = mergeInProgress || conflicts.length > 0;
	if (concludesMerge) {
		// A conflicted tree is committable — that is how a merge left by
		// `onConflict: "keep"` is finished — but only as a whole. Git refuses to
		// commit anything at all while paths remain unmerged, and mid-merge the
		// index already holds every cleanly-merged path, so a path selection here
		// would quietly commit far more than it named.
		if (opts.paths !== 'all') {
			throw new GitError(
				(conflicts.length > 0
					? `this tree has ${conflicts.length} unmerged (conflicted) file(s): ${conflicts.map((e) => e.path).join(', ')}. Resolve them and `
					: 'this tree has an in-progress merge; ') +
					'commit with paths: "all" (a commit that concludes a merge cannot be partial)',
				emptyResult()
			);
		}
		if (opts.allowConflictMarkers !== true) {
			const unresolved = conflicts.filter((entry) => fileHasConflictMarkers(repoRoot, entry.path));
			if (unresolved.length > 0) {
				throw new GitError(
					`cannot commit unresolved conflict markers in: ${unresolved.map((e) => e.path).join(', ')}. ` +
						'Edit each file to keep the intended content and delete the <<<<<<< / ======= / >>>>>>> lines, ' +
						'or pass allowConflictMarkers: true if the markers are genuinely part of the file.',
					emptyResult()
				);
			}
		}
	}

	const selectedPaths = opts.paths === 'all' ? null : validateCommitPaths(repoRoot, opts.paths);
	const selectedEntries =
		selectedPaths === null
			? entries
			: entries.filter((entry) => statusEntryMatches(entry, selectedPaths));
	// Mid-merge there may be nothing in `status` at all (every conflict already
	// resolved and staged, or a clean `--no-commit` merge) and the commit is
	// still required to conclude the merge. Bailing there would strand the tree
	// in the unfinishable state this path exists to leave.
	if (selectedEntries.length === 0 && !concludesMerge) {
		throw new GitError('no selected changes to commit', emptyResult());
	}

	if (selectedPaths !== null) {
		const unrelatedStaged = entries.filter(
			(entry) => hasIndexChange(entry) && !statusEntryMatches(entry, selectedPaths)
		);
		if (unrelatedStaged.length > 0) {
			throw new GitError(
				`cannot commit selected paths while unrelated changes are staged: ${unrelatedStaged.map((e) => e.path).join(', ')}`,
				emptyResult()
			);
		}
	}

	const snapshot = await snapshotIndex(repoRoot);
	const headBefore = (await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
	let messageDir: string | null = null;

	try {
		messageDir = await mkdtemp(join(tmpdir(), 'portal-git-commit-'));
		const messagePath = join(messageDir, 'message.txt');
		writeFileSync(messagePath, commitMessage, 'utf8');
		ctx?.progress?.('staging changes…');
		if (selectedPaths !== null) {
			await runGitOk(['--literal-pathspecs', 'add', '-A', '--', ...selectedPaths], {
				cwd: repoRoot
			});
		} else if (concludesMerge) {
			// Mid-merge, `paths: "all"` means "stage my resolutions", NOT "sweep
			// the tree": the index already holds the merge result, and a merge
			// commit that also absorbed unrelated edits an agent happened to make
			// while resolving would be a worse trap than the one this path fixes.
			// Anything else stays dirty and is reported in `remainingDirtyFiles`.
			if (conflicts.length > 0) {
				await runGitOk(
					['--literal-pathspecs', 'add', '-A', '--', ...conflicts.map((entry) => entry.path)],
					{ cwd: repoRoot }
				);
			}
		} else {
			await runGitOk(['add', '-A', '--', '.'], { cwd: repoRoot });
		}
		const stagedFiles = await nameStatus(repoRoot, { kind: 'index-vs-head' });
		// An empty staged diff normally means the caller selected nothing real.
		// Mid-merge it does not: a resolution that lands back on HEAD's content
		// still has to be committed to conclude the merge.
		if (stagedFiles.length === 0 && !concludesMerge) {
			throw new GitError('no selected changes to commit', emptyResult());
		}
		// `git add` above is what resolves an unmerged entry. A backstop for the
		// paths git could not stage (skip-worktree / sparse entries): git would
		// otherwise fail the commit with a bare "cannot commit with unmerged
		// files" that names nothing.
		const stillUnmerged = await unmergedPaths(repoRoot);
		if (stillUnmerged.length > 0) {
			throw new GitError(
				`cannot commit while paths remain unmerged: ${stillUnmerged.join(', ')}`,
				emptyResult()
			);
		}
		ctx?.progress?.('running git commit (pre-commit / commit-msg hooks)…');
		await runGitOk(['commit', '-F', messagePath], {
			cwd: repoRoot,
			// Pre-commit hooks can run a full verify suite; keep the budget well
			// above a plain git op.
			timeoutMs: 180_000,
			onData: ctx?.partial ? (snap) => ctx.partial?.(snap) : undefined,
			signal: ctx?.signal
		});
		ctx?.progress?.('finalizing commit…');
	} catch (err) {
		// Restoring the pre-commit index is right only while the commit did NOT
		// land. An abort (or a hook timing out after the ref moved) can leave HEAD
		// advanced — restoring a stale, possibly unmerged index over a landed
		// commit would manufacture phantom changes and, after a merge, resurrect
		// conflicts git has already recorded as resolved.
		const headAfterRun = await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
		const headAfter = headAfterRun.code === 0 ? headAfterRun.stdout.trim() : null;
		if (headAfter !== null && headAfter !== headBefore) {
			logger.warn('git.commit.head_advanced_on_failure', {
				headBefore,
				headAfter,
				originalErr: String(err)
			});
			// Surfaced, not swallowed: the caller must not retry blindly and create
			// a second commit of the same work.
			throw new GitError(
				`${err instanceof Error ? err.message : String(err)} — but HEAD advanced from ${headBefore || '(none)'} to ${headAfter}, so the commit may have landed. ` +
					'Inspect the history before retrying; the index was left as git wrote it.',
				err instanceof GitError ? err.result : emptyResult()
			);
		}
		try {
			restoreIndex(snapshot);
		} catch (restoreErr) {
			logger.warn('git.commit.index_restore_failed', {
				err: String(restoreErr),
				originalErr: String(err)
			});
		}
		throw err;
	} finally {
		if (messageDir) rmSync(messageDir, { recursive: true, force: true });
	}

	const sha = (await runGitOk(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
	const parents = (await runGitOk(['rev-list', '-1', '--parents', sha], { cwd: repoRoot }))
		.trim()
		.split(/\s+/)
		.slice(1);
	const mergeCommit = parents.length > 1;
	// `<sha>^!` expands to the commit plus every parent negated, which `git diff`
	// cannot take for a merge. Diff a merge against its FIRST parent instead —
	// "what this commit brought into the branch it landed on".
	const fileTarget: DiffTarget = mergeCommit
		? { kind: 'commit-vs-parent', sha }
		: { kind: 'commit', sha };
	const [files, fileStats, remaining] = await Promise.all([
		nameStatus(repoRoot, fileTarget),
		numstat(repoRoot, fileTarget),
		status(repoRoot)
	]);
	const diffStatTotal = fileStats.reduce(
		(acc, file) => {
			acc.filesChanged += 1;
			acc.added += file.added ?? 0;
			acc.removed += file.removed ?? 0;
			return acc;
		},
		{ filesChanged: 0, added: 0, removed: 0 }
	);

	return {
		sha,
		shortSha: sha.slice(0, 8),
		subject: opts.subject,
		body: opts.body?.trimEnd() ?? '',
		trailers: opts.trailers ?? [],
		files,
		fileStats,
		diffStat: diffStatTotal,
		remainingDirtyFiles: remaining.map((entry) => ({
			...entry,
			status: aggregateStatus(entry)
		})),
		mergeCommit,
		resolvedConflicts: conflicts.map((entry) => entry.path)
	};
}

export interface NumstatEntry {
	/** Current path. For renames, the new path. */
	path: string;
	/** Original path for renames, else null. */
	origPath: string | null;
	/** Lines added. `null` means binary. */
	added: number | null;
	/** Lines removed. `null` means binary. */
	removed: number | null;
}

export interface DiffStat {
	files: NumstatEntry[];
	total: {
		filesChanged: number;
		added: number;
		removed: number;
	};
}

export interface NameStatusEntry {
	/** Raw git status code, e.g. M, A, D, R100. */
	statusCode: string;
	status: StatusCode;
	path: string;
	origPath: string | null;
}

/**
 * Returns per-file added/removed line counts. Uses `git diff --numstat -z`
 * so paths are unambiguous. Binary files report `null` for both counts.
 */
export async function numstat(
	cwd: string,
	target: DiffTarget,
	relPath?: string
): Promise<NumstatEntry[]> {
	const args = diffArgs(cwd, target, ['--numstat', '-z'], relPath);
	const out = await runGitOk(args, { cwd });
	// With -z, each record is "added\tremoved\tpath\0" except for renames,
	// which are "added\tremoved\t\0origPath\0newPath\0".
	const entries: NumstatEntry[] = [];
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (!rec) continue;
		const tab1 = rec.indexOf('\t');
		const tab2 = rec.indexOf('\t', tab1 + 1);
		if (tab1 < 0 || tab2 < 0) continue;
		const aStr = rec.slice(0, tab1);
		const rStr = rec.slice(tab1 + 1, tab2);
		const rest = rec.slice(tab2 + 1);
		const added = aStr === '-' ? null : Number.parseInt(aStr, 10);
		const removed = rStr === '-' ? null : Number.parseInt(rStr, 10);
		if (rest === '') {
			// Rename: next two parts are origPath and newPath.
			const origPath = parts[i + 1] ?? '';
			const newPath = parts[i + 2] ?? '';
			i += 2;
			entries.push({ path: newPath, origPath: origPath || null, added, removed });
		} else {
			entries.push({ path: rest, origPath: null, added, removed });
		}
	}
	return entries;
}

export async function diffStat(
	cwd: string,
	target: DiffTarget,
	relPath?: string
): Promise<DiffStat> {
	const files = await numstat(cwd, target, relPath);
	const total = files.reduce(
		(acc, file) => {
			acc.filesChanged += 1;
			acc.added += file.added ?? 0;
			acc.removed += file.removed ?? 0;
			return acc;
		},
		{ filesChanged: 0, added: 0, removed: 0 }
	);
	return { files, total };
}

export async function nameOnly(
	cwd: string,
	target: DiffTarget,
	relPath?: string
): Promise<string[]> {
	const out = await runGitOk(diffArgs(cwd, target, ['--name-only', '-z'], relPath), { cwd });
	return out.split('\0').filter(Boolean);
}

export async function nameStatus(
	cwd: string,
	target: DiffTarget,
	relPath?: string
): Promise<NameStatusEntry[]> {
	const out = await runGitOk(diffArgs(cwd, target, ['--name-status', '-z'], relPath), { cwd });
	const entries: NameStatusEntry[] = [];
	const parts = out.split('\0').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const statusCode = parts[i];
		const head = statusCode[0];
		if (head === 'R' || head === 'C') {
			const origPath = parts[++i] ?? '';
			const path = parts[++i] ?? '';
			entries.push({
				statusCode,
				status: head === 'R' ? 'renamed' : 'copied',
				path,
				origPath: origPath || null
			});
		} else {
			entries.push({
				statusCode,
				status: decodeStatusChar(head),
				path: parts[++i] ?? '',
				origPath: null
			});
		}
	}
	return entries;
}

function emptyResult(): GitRunResult {
	return { stdout: '', stderr: '', code: -1, timedOut: false, truncated: false };
}

function validateCommitPaths(repoRoot: string, paths: string[]): string[] {
	if (paths.length === 0)
		throw new GitError('paths must be "all" or a non-empty array', emptyResult());
	const validated: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (path.length === 0) throw new GitError('commit paths must not be empty', emptyResult());
		if (hasControlCharacter(path)) {
			throw new GitError(
				`invalid path: control characters are not allowed: ${path}`,
				emptyResult()
			);
		}
		const r = safeResolve(repoRoot, path);
		if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
		if (!r.rel)
			throw new GitError('use paths: "all" to commit the entire repository', emptyResult());
		if (!seen.has(r.rel)) {
			seen.add(r.rel);
			validated.push(r.rel);
		}
	}
	return validated;
}

function statusEntryMatches(entry: StatusEntry, selectedPaths: string[]): boolean {
	return selectedPaths.some((path) => entry.path === path || entry.origPath === path);
}

/**
 * Read a repo-relative working-tree file and look for conflict markers.
 *
 * Missing/unreadable (a delete/modify conflict resolved by deleting) and binary
 * content both count as marker-free: the point is to catch a text file the agent
 * forgot to edit, not to second-guess a deliberate deletion.
 */
function fileHasConflictMarkers(repoRoot: string, relPath: string): boolean {
	const resolved = safeResolve(repoRoot, relPath);
	if (!resolved.ok) return false;
	try {
		const buf = readFileSync(resolved.abs);
		if (buf.includes(0)) return false;
		return hasConflictMarkers(buf.toString('utf-8'));
	} catch {
		return false;
	}
}

function hasIndexChange(entry: StatusEntry): boolean {
	return entry.index !== 'unmodified' && entry.index !== 'untracked' && entry.index !== 'ignored';
}

interface IndexSnapshot {
	path: string;
	existed: boolean;
	data: Buffer | null;
}

async function snapshotIndex(repoRoot: string): Promise<IndexSnapshot> {
	const gitIndexPath = (
		await runGitOk(['rev-parse', '--git-path', 'index'], { cwd: repoRoot })
	).trim();
	const indexPath = isAbsolute(gitIndexPath) ? gitIndexPath : resolve(repoRoot, gitIndexPath);
	return {
		path: indexPath,
		existed: existsSync(indexPath),
		data: existsSync(indexPath) ? readFileSync(indexPath) : null
	};
}

function restoreIndex(snapshot: IndexSnapshot): void {
	if (snapshot.existed && snapshot.data) {
		mkdirSync(dirname(snapshot.path), { recursive: true });
		writeFileSync(snapshot.path, snapshot.data);
		return;
	}
	rmSync(snapshot.path, { force: true });
}

function hasControlCharacter(value: string, opts: { allowWhitespace?: boolean } = {}): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (opts.allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
		// C0 controls and DEL (U+0000–U+001F, U+007F) plus C1 controls
		// (U+0080–U+009F). C1 includes NEL (U+0085), which can forge extra
		// commit lines, and the bytes used by ANSI escape sequences.
		if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
	}
	return false;
}
