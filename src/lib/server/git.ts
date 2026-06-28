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

interface RunOptions {
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
			env: {
				...process.env,
				// Disable interactive prompts and pagers. Git hooks still run for commits.
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
				GIT_OPTIONAL_LOCKS: '0',
				LC_ALL: 'C'
			}
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
	const conflicts = entries.filter((e) => e.index === 'conflicted' || e.worktree === 'conflicted');
	if (conflicts.length > 0) {
		throw new GitError(
			`cannot commit while conflicted files are present: ${conflicts.map((e) => e.path).join(', ')}`,
			emptyResult()
		);
	}

	const selectedPaths = opts.paths === 'all' ? null : validateCommitPaths(repoRoot, opts.paths);
	const selectedEntries =
		selectedPaths === null
			? entries
			: entries.filter((entry) => statusEntryMatches(entry, selectedPaths));
	if (selectedEntries.length === 0) {
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
	let messageDir: string | null = null;

	try {
		messageDir = await mkdtemp(join(tmpdir(), 'portal-git-commit-'));
		const messagePath = join(messageDir, 'message.txt');
		writeFileSync(messagePath, commitMessage, 'utf8');
		ctx?.progress?.('staging changes…');
		if (selectedPaths === null) {
			await runGitOk(['add', '-A', '--', '.'], { cwd: repoRoot });
		} else {
			await runGitOk(['--literal-pathspecs', 'add', '-A', '--', ...selectedPaths], {
				cwd: repoRoot
			});
		}
		const stagedFiles = await nameStatus(repoRoot, { kind: 'index-vs-head' });
		if (stagedFiles.length === 0) {
			throw new GitError('no selected changes to commit', emptyResult());
		}
		ctx?.progress?.('running git commit (pre-commit / commit-msg hooks)…');
		await runGitOk(['commit', '-F', messagePath], {
			cwd: repoRoot,
			timeoutMs: 60_000,
			onData: ctx?.partial ? (snap) => ctx.partial?.(snap) : undefined,
			signal: ctx?.signal
		});
		ctx?.progress?.('finalizing commit…');
	} catch (err) {
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
	const [files, fileStats, remaining] = await Promise.all([
		nameStatus(repoRoot, { kind: 'commit', sha }),
		numstat(repoRoot, { kind: 'commit', sha }),
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
		}))
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
