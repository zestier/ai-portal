import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { emptyResult, GitError, runGit, runGitOk } from "./run";

export interface RepoInitState {
  initialized: false;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function repositoryRoot(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd)))
    throw new GitError("not a git repository", emptyResult());
  return (await runGitOk(["rev-parse", "--show-toplevel"], { cwd })).trim();
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
  const r = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  const raw = r.code === 0 ? r.stdout.trim() : "";
  if (!raw) {
    throw new GitError(
      "not a git repository: could not determine the git common dir",
      r,
    );
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
  const sha =
    (await runGit(["rev-parse", "HEAD"], { cwd })).stdout.trim() || null;
  const shortSha = sha ? sha.slice(0, 8) : null;
  const branchOut = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd },
  );
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() : null;
  const detached = branch === null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const upRes = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    {
      cwd,
    },
  );
  if (upRes.code === 0) {
    upstream = upRes.stdout.trim() || null;
    if (upstream) {
      const counts = await runGit(
        ["rev-list", "--left-right", "--count", `HEAD...@{upstream}`],
        {
          cwd,
        },
      );
      if (counts.code === 0) {
        const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
        if (Number.isFinite(a)) ahead = a;
        if (Number.isFinite(b)) behind = b;
      }
    }
  }
  const statusOut = await runGit(["status", "--porcelain=v1", "-uall"], {
    cwd,
  });
  const dirtyCount =
    statusOut.code === 0
      ? statusOut.stdout.split("\n").filter(Boolean).length
      : 0;
  return {
    initialized: true,
    branch,
    sha,
    shortSha,
    detached,
    upstream,
    ahead,
    behind,
    dirtyCount,
  };
}

const REF_RE = /^[A-Za-z0-9._\-/@^~]+$/;

// Reflog/stash selectors (`@{...}`, `stash`, `refs/stash`) can expose
// deliberately-uncommitted content, so they are rejected even though their
// characters pass REF_RE.
const STASH_REF_RE = /^(refs\/)?stash$/;

export function isSafeRef(ref: string): boolean {
  if (!REF_RE.test(ref) || ref.startsWith("-")) return false;
  if (ref.includes("@{")) return false;
  if (STASH_REF_RE.test(ref)) return false;
  return true;
}
