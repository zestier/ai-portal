// Per-process serialization of mutating git operations on one repository.
//
// Extracted from `worktrees.ts` so every module that mutates a repository can
// take the SAME lock. That sharing is the whole point: a second lock keyed the
// same way in a different module would provide no mutual exclusion at all, and
// the failure would be silent and timing-dependent.
//
// Callers key on the repository's **git common dir** (`git rev-parse
// --git-common-dir`), which is shared by a repository's main worktree and all
// of its linked worktrees — so `git worktree add`, `git worktree remove`, and a
// merge into the source checkout all serialize against each other even though
// they run with different cwds.
//
// Scope and limits: this is an in-process mutex, not a file lock. It does not
// coordinate with git operations from other processes (a human's shell, an
// agent's own subprocess), which git guards with its own `index.lock`. It
// exists to stop the portal from racing *itself*.

type LockMap = Map<string, Promise<void>>;

const locks: LockMap = new Map();

export async function withRepositoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
