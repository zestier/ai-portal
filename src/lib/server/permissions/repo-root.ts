// Per-repository canonical key for `.zap/permissions.toml` policy state.
//
// The file is checked into git, so every worktree/lease of a repository
// carries an identical copy at a different absolute path. Gating and storing
// grants keyed by the literal checkout path re-reviews the file once per
// worktree ("tries to reload") and lets approved file grants silently stop
// applying inside leases. Canonicalizing to the repository's main checkout
// root fixes both: one approval per repo, active in every worktree.
//
// Canonical root = dirname(realpath(git-common-dir)) — the same command
// `repositoryLockKey` uses, but run synchronously because the permission
// path cannot await. Non-git roots fall back to their realpath; a
// non-existent root stays `resolve`d (fail-closed: it can't be a repo if it
// doesn't exist).
//
// A worktree branch where the file differs still gets the MAIN copy through
// this canonical root: an edit in an unmerged worktree can never widen active
// grants until merged (fail-closed, review just delayed).

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CACHE = new Map<string, string>();

export function canonicalWorkspaceRoot(root: string): string {
  const key = resolve(root);
  const cached = CACHE.get(key);
  if (cached !== undefined) return cached;
  if (!existsSync(key)) {
    CACHE.set(key, key);
    return key;
  }
  let canonical: string;
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: key,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    canonical = out ? dirname(realpathSync(out)) : realpathSync(key);
  } catch {
    canonical = realpathSync(key);
  }
  CACHE.set(key, canonical);
  return canonical;
}
