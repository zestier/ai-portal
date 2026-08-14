// Per-message workdir snapshots, backed by a private git ref namespace
// inside the workdir's own repository.
//
// Snapshots are commit objects under `refs/portal/turns/{messageId}` that
// capture the entire working tree (including untracked files) at the
// instant they're taken. They live alongside whatever real branches /
// history exist in the workdir, but never touch any user-visible refs.
//
// We deliberately call git via spawn (not through the safe wrapper in
// git.ts) for a couple of operations that need GIT_INDEX_FILE or finer-
// grained timeouts than the helpers there expose. All paths still go
// through validated workdirs and shell:false.

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { messageId as msgCodec } from '$lib/ids';
import { isolatedChildEnv } from './child-env';
import { getDb } from './db';

const SNAP_TIMEOUT_MS = 30_000;
const SNAP_MAX_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "Zestier's AI Portal",
	GIT_AUTHOR_EMAIL: 'portal@localhost',
	GIT_COMMITTER_NAME: "Zestier's AI Portal",
	GIT_COMMITTER_EMAIL: 'portal@localhost',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: 'commit.gpgsign',
	GIT_CONFIG_VALUE_0: 'false'
};

export type SnapshotKind = 'pre' | 'post';

export interface SnapshotRow {
	messageId: string;
	kind: SnapshotKind;
	gitRef: string;
	commitSha: string;
	treeSha: string;
	baseCommitSha: string | null;
	createdAt: number;
}

interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
}

interface RunOpts {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

function run(args: string[], opts: RunOpts): Promise<RunResult> {
	const timeoutMs = opts.timeoutMs ?? SNAP_TIMEOUT_MS;
	return new Promise((resolve) => {
		const child = spawn('git', args, {
			cwd: opts.cwd,
			shell: false,
			env: isolatedChildEnv(process.env, {
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
				GIT_OPTIONAL_LOCKS: '0',
				LC_ALL: 'C',
				...(opts.env ?? {})
			})
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		timer.unref?.();
		child.stdout.on('data', (c: Buffer) => {
			if (stdout.length < SNAP_MAX_BYTES) {
				stdout = Buffer.concat([stdout, c.subarray(0, SNAP_MAX_BYTES - stdout.length)]);
			}
		});
		child.stderr.on('data', (c: Buffer) => {
			if (stderr.length < 65_536) {
				stderr = Buffer.concat([stderr, c.subarray(0, 65_536 - stderr.length)]);
			}
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({
				stdout: stdout.toString('utf-8'),
				stderr: (stderr.toString('utf-8') + '\n' + err.message).trim(),
				code: -1,
				timedOut
			});
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({
				stdout: stdout.toString('utf-8'),
				stderr: stderr.toString('utf-8'),
				code: code ?? -1,
				timedOut
			});
		});
	});
}

async function runOk(args: string[], opts: RunOpts): Promise<string> {
	const r = await run(args, opts);
	if (r.timedOut) throw new Error(`git ${args[0]} timed out (${args.join(' ')})`);
	if (r.code !== 0) {
		throw new Error(`git ${args[0]} exited ${r.code}: ${r.stderr.trim()}`);
	}
	return r.stdout;
}

// ---------- Per-workdir lock ----------
//
// Snapshot/restore operations against the same workdir must not race. The
// turn runner already coordinates by conversation id (one in-flight turn
// per conversation), but we also serialise here as a defence in depth:
// e.g., a fork operation that materialises into a *new* workdir while the
// source's pre-snapshot is mid-flight on its existing workdir.
const locks = new Map<string, Promise<void>>();
async function withLock<T>(workdir: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(workdir) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => (release = r));
	locks.set(
		workdir,
		prev.then(() => next)
	);
	try {
		await prev;
		return await fn();
	} finally {
		release();
		if (locks.get(workdir) === next) locks.delete(workdir);
	}
}

// ---------- Public API ----------

const REF_PREFIX = 'refs/portal/turns';
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function refFor(messageId: string, kind: SnapshotKind): string {
	const s = String(messageId);
	if (!MESSAGE_ID_RE.test(s)) {
		throw new Error(`invalid message id for snapshot ref: ${s}`);
	}
	return `${REF_PREFIX}/${kind}/${s}`;
}

async function isSnapshotRepo(workdir: string): Promise<boolean> {
	if (!existsSync(workdir)) return false;
	const r = await run(['rev-parse', '--show-toplevel'], { cwd: workdir });
	if (r.code !== 0) return false;
	return realpathSync(r.stdout.trim()) === realpathSync(workdir);
}

/**
 * Take a snapshot of `workdir` and bind it to `(messageId, kind)`.
 *
 * Uses a private index file so the user's staging area is never touched.
 * If a snapshot for the same `(messageId, kind)` already exists, returns
 * the existing row unchanged. If the tree is identical to an existing
 * snapshot, the resulting commit reuses the same tree SHA (git dedups).
 */
export async function snapshot(
	workdir: string,
	messageId: string | number,
	kind: SnapshotKind
): Promise<SnapshotRow | null> {
	const db = getDb();
	const intMsg = typeof messageId === 'number' ? messageId : msgCodec.parse(messageId);
	const handleMsg = msgCodec.encode(intMsg);

	return withLock(workdir, async () => {
		// Existence check runs inside the per-workdir lock so that
		// check-then-insert is atomic: concurrent callers for the same
		// (messageId, kind) cannot both read NULL and both attempt the
		// INSERT, which would violate the (message_id, kind) primary key.
		const existing = db
			.prepare('SELECT * FROM turn_snapshots WHERE message_id = ? AND kind = ?')
			.get(intMsg, kind) as
			| {
					message_id: number;
					kind: SnapshotKind;
					git_ref: string;
					commit_sha: string;
					tree_sha: string;
					base_commit_sha: string | null;
					created_at: number;
			  }
			| undefined;
		if (existing) {
			return {
				messageId: msgCodec.encode(existing.message_id),
				kind: existing.kind,
				gitRef: existing.git_ref,
				commitSha: existing.commit_sha,
				treeSha: existing.tree_sha,
				baseCommitSha: existing.base_commit_sha,
				createdAt: existing.created_at
			};
		}

		if (!(await isSnapshotRepo(workdir))) return null;
		const ref = refFor(handleMsg, kind);
		// Use a private index file so the user's staging area (if any) is
		// not disturbed. We pick a path inside .git so concurrent processes
		// using a different convention don't conflict.
		const indexName = `portal-index-${intMsg}-${kind}`;
		const indexPath = (
			await runOk(['rev-parse', '--git-path', indexName], { cwd: workdir })
		).trim();
		const indexFile = isAbsolute(indexPath) ? indexPath : resolve(workdir, indexPath);
		try {
			const head = await run(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: workdir });
			const baseCommitSha = head.code === 0 ? head.stdout.trim() || null : null;
			await runOk(['add', '-A'], { cwd: workdir, env: { GIT_INDEX_FILE: indexFile } });
			const tree = (
				await runOk(['write-tree'], { cwd: workdir, env: { GIT_INDEX_FILE: indexFile } })
			).trim();
			const commit = (
				await runOk(['commit-tree', tree, '-m', `portal: ${kind} snapshot for ${messageId}`], {
					cwd: workdir,
					env: SNAPSHOT_IDENTITY
				})
			).trim();
			await runOk(['update-ref', ref, commit], { cwd: workdir });

			const row: SnapshotRow = {
				messageId: handleMsg,
				kind,
				gitRef: ref,
				commitSha: commit,
				treeSha: tree,
				baseCommitSha,
				createdAt: Date.now()
			};
			// Atomicity: the git ref now exists. Insert the DB row that
			// points at it, and if that INSERT fails roll the ref back so
			// git state and DB metadata can't diverge. We create the ref
			// first (rather than the row first) so there is never a DB row
			// referencing a ref that doesn't exist — a dangling row would
			// break restore, whereas a momentarily orphaned ref is inert.
			try {
				db.prepare(
					`INSERT INTO turn_snapshots(
					   message_id, kind, git_ref, commit_sha, tree_sha, base_commit_sha, created_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`
				).run(
					intMsg,
					row.kind,
					row.gitRef,
					row.commitSha,
					row.treeSha,
					row.baseCommitSha,
					row.createdAt
				);
			} catch (err) {
				// Best-effort cleanup of the ref we just created. If this
				// also fails the worst case is an orphaned, invisible ref
				// (no DB row points at it); we still surface the original
				// INSERT failure to the caller.
				await run(['update-ref', '-d', ref, commit], { cwd: workdir });
				throw err;
			}
			return row;
		} finally {
			try {
				if (existsSync(indexFile)) rmSync(indexFile, { force: true });
			} catch {
				/* best-effort */
			}
		}
	});
}

/**
 * Look up a snapshot row.
 */
export function getSnapshot(messageId: string | number, kind: SnapshotKind): SnapshotRow | null {
	const intMsg = typeof messageId === 'number' ? messageId : msgCodec.parse(messageId);
	const r = getDb()
		.prepare('SELECT * FROM turn_snapshots WHERE message_id = ? AND kind = ?')
		.get(intMsg, kind) as
		| {
				message_id: number;
				kind: SnapshotKind;
				git_ref: string;
				commit_sha: string;
				tree_sha: string;
				base_commit_sha: string | null;
				created_at: number;
		  }
		| undefined;
	if (!r) return null;
	return {
		messageId: msgCodec.encode(r.message_id),
		kind: r.kind,
		gitRef: r.git_ref,
		commitSha: r.commit_sha,
		treeSha: r.tree_sha,
		baseCommitSha: r.base_commit_sha,
		createdAt: r.created_at
	};
}

/**
 * Materialise the working tree of `srcWorkdir`@`commitSha` into a brand
 * new workdir at `dstWorkdir`. The destination must not already exist
 * (or must be empty). This is how a forked conversation gets its own
 * copy of the workdir at the state of the source's pre-snapshot.
 *
 * Implementation: init a fresh repo at dst, fetch the snapshot commit
 * across as a single object, then check out its tree. We never copy
 * across the source's other refs / objects, so the new workdir starts
 * with a clean history rooted at this snapshot.
 */
export async function materializeFromCommit(
	srcWorkdir: string,
	commitSha: string,
	dstWorkdir: string
): Promise<void> {
	if (!/^[0-9a-f]{4,64}$/.test(commitSha)) {
		throw new Error(`invalid commit sha: ${commitSha}`);
	}
	if (existsSync(dstWorkdir)) {
		// Allow an empty dir but reject anything pre-populated.
		const { readdirSync } = await import('node:fs');
		const entries = readdirSync(dstWorkdir);
		if (entries.length > 0) {
			throw new Error(`materializeFromCommit: dst not empty: ${dstWorkdir}`);
		}
	}
	mkdirSync(dstWorkdir, { recursive: true });

	await withLock(dstWorkdir, async () => {
		await runOk(['init', '-q', '-b', 'portal'], { cwd: dstWorkdir });
		await runOk(['config', 'user.email', 'portal@localhost'], { cwd: dstWorkdir });
		await runOk(['config', 'user.name', "Zestier's AI Portal"], { cwd: dstWorkdir });
		await runOk(['config', 'commit.gpgsign', 'false'], { cwd: dstWorkdir });
		// Use `fetch` from a local path so we only transfer the snapshot
		// commit and its tree, not the whole history graph. `--depth=1`
		// keeps it tight.
		await runOk(['fetch', '--no-tags', '--depth=1', srcWorkdir, `${commitSha}:refs/portal/seed`], {
			cwd: dstWorkdir,
			timeoutMs: 60_000
		});
		// Check out the snapshot tree into the worktree + index. We commit
		// it locally so the new repo has a sensible HEAD.
		await runOk(['read-tree', '-u', '--reset', 'refs/portal/seed'], { cwd: dstWorkdir });
		const tree = (await runOk(['write-tree'], { cwd: dstWorkdir })).trim();
		const newHead = (
			await runOk(['commit-tree', tree, '-m', 'portal: fork seed'], {
				cwd: dstWorkdir,
				env: SNAPSHOT_IDENTITY
			})
		).trim();
		await runOk(['update-ref', 'refs/heads/portal', newHead], { cwd: dstWorkdir });
		await runOk(['symbolic-ref', 'HEAD', 'refs/heads/portal'], { cwd: dstWorkdir });
		// Tidy up the temporary seed ref.
		await run(['update-ref', '-d', 'refs/portal/seed'], { cwd: dstWorkdir });
	});
}
