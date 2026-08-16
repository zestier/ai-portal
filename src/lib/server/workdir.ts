// Resolve a conversation's workdir to an absolute path.
//
// The "workdir" is the directory the pi agent session runs against (its
// workspace) — i.e. the real project tree the agent reads and
// edits. Earlier versions of the portal kept a private, per-conversation
// directory under `DATA_DIR/workspaces/<id>/` and tried to snapshot it
// per turn, but the SDK was never actually pointed at those dirs — the
// agent inherited the server's cwd instead, so every snapshot was of an
// empty tree and the fork-into-a-new-workdir machinery was unreachable
// in practice. We now just route everything to the configured
// PROJECT_ROOT (env or cwd), with an optional per-user override.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { loadConfig, type AppConfig } from './config';
import type { Conversation } from '$lib/types';
import { expectedManagedWorktreePath } from './worktrees';

export class WorkspaceUnavailableError extends Error {
	readonly code = 'workspace_unavailable';

	constructor(message: string) {
		super(message);
		this.name = 'WorkspaceUnavailableError';
	}
}

/**
 * The default workdir for newly created conversations when the user has
 * not set a per-user override and no explicit value is supplied at
 * creation time.
 */
export function projectRoot(): string {
	return resolve(loadConfig().PROJECT_ROOT);
}

/**
 * Translate a value stored in `conversations.workdir` into the path we
 * actually hand to the SDK and snapshotter. Falls back to PROJECT_ROOT
 * when:
 *  - the stored value is empty, or
 *  - it points into the legacy `<DATA_DIR>/workspaces/` tree (old, empty
 *    per-conversation sandboxes from before workdirs were wired through
 *    to the SDK; their on-disk dirs are still there but unusable), or
 *  - it no longer resolves inside the configured allowlist (see
 *    {@link allowedWorkdirRoots}).
 *
 * The allowlist fallback is defense-in-depth for the *read* boundary: the
 * conversation-scoped file-browser / git endpoints derive their containment
 * root from the stored `conversations.workdir` via this function, so a value
 * that was persisted before the allowlist existed (or after an operator
 * narrowed it) — e.g. a stored `"/"` — must not become a live root. Such a
 * value is folded back to PROJECT_ROOT instead of being trusted.
 */
export function effectiveWorkdir(stored: string | null | undefined): string {
	if (!stored) return projectRoot();
	const abs = resolve(stored);
	const legacy = resolve(loadConfig().DATA_DIR, 'workspaces');
	if (abs === legacy || abs.startsWith(legacy + sep)) return projectRoot();
	if (!withinAllowedRoots(abs)) return projectRoot();
	return abs;
}

/**
 * Resolve the directory used by a conversation. Managed worktrees are
 * portal-owned and therefore bypass ALLOWED_WORKDIRS, but only at their exact
 * generated path. They fail closed instead of falling back to PROJECT_ROOT.
 */
export function resolveConversationWorkspace(conversation: Conversation): string {
	if (conversation.workspaceKind !== 'managed-worktree') {
		return effectiveWorkdir(conversation.workdir);
	}
	const expected = resolve(
		expectedManagedWorktreePath(String(conversation.userId), String(conversation.id))
	);
	const stored = resolve(conversation.workdir);
	if (stored !== expected || !existsSync(stored)) {
		throw new WorkspaceUnavailableError('managed worktree path is unavailable');
	}
	try {
		const rootReal = realpathSync(resolve(loadConfig().WORKTREE_ROOT));
		const storedReal = realpathSync(stored);
		const expectedReal = resolve(rootReal, String(conversation.userId), String(conversation.id));
		if (
			!statSync(stored).isDirectory() ||
			storedReal !== expectedReal ||
			storedReal === rootReal ||
			!storedReal.startsWith(rootReal + sep)
		) {
			throw new WorkspaceUnavailableError('managed worktree path is invalid');
		}
		return storedReal;
	} catch (error) {
		if (error instanceof WorkspaceUnavailableError) throw error;
		throw new WorkspaceUnavailableError('managed worktree path is not accessible');
	}
}

/**
 * Validate a user-supplied workdir path. The path must exist, be a directory,
 * and resolve (after symlinks) inside one of the configured allowed roots
 * (see {@link allowedWorkdirRoots}). The allowlist is what keeps an
 * authenticated user from pointing a conversation at `/` (or any other host
 * directory) and then reading arbitrary files via the conversation-scoped
 * file-browser / git endpoints.
 */
export function resolveAndValidate(
	input: string
): { ok: true; path: string } | { ok: false; reason: string } {
	const abs = resolve(input);
	if (!existsSync(abs)) {
		return { ok: false, reason: 'workdir does not exist' };
	}
	try {
		if (!statSync(abs).isDirectory()) {
			return { ok: false, reason: 'workdir is not a directory' };
		}
	} catch (e) {
		return { ok: false, reason: `workdir not accessible: ${(e as Error).message}` };
	}
	// Containment is checked against the *realpath* of the candidate so a
	// symlink inside an allowed root that points back out (e.g. an attacker
	// drops `allowed/link -> /`) cannot smuggle the root past the allowlist.
	if (!withinAllowedRoots(abs)) {
		return { ok: false, reason: 'workdir is not within an allowed root' };
	}
	return { ok: true, path: abs };
}

/**
 * True when `abs` resolves (after symlinks) inside one of the configured
 * allowed roots. Shared by the write boundary ({@link resolveAndValidate})
 * and the read boundary ({@link effectiveWorkdir}).
 */
function withinAllowedRoots(abs: string): boolean {
	const real = safeRealpath(abs);
	return allowedWorkdirRoots().some((root) => isWithin(root, real));
}

/**
 * Resolve a path to its realpath, falling back to the lexical path when the
 * realpath cannot be taken (missing path / transient I/O error). Callers that
 * need existence guarantees check that separately.
 */
function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** True when `candidate` is `root` itself or a descendant of it. */
function isWithin(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root + sep);
}

/**
 * The set of realpath'd roots a user-supplied workdir is allowed to resolve
 * inside.
 *
 * Defaults to `[PROJECT_ROOT]`. An operator running a single trusted account
 * can widen it with the `ALLOWED_WORKDIRS` env var (comma-separated absolute
 * paths) to point conversations at several project trees.
 */
export function allowedWorkdirRoots(cfg: AppConfig = loadConfig()): string[] {
	const configured = cfg.ALLOWED_WORKDIRS.length > 0 ? cfg.ALLOWED_WORKDIRS : [cfg.PROJECT_ROOT];
	const roots = configured.map((r) => safeRealpath(resolve(r)));
	return [...new Set(roots)];
}
