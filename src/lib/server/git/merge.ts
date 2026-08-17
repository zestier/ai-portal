import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { emptyResult, GitError, runGit, runGitOk } from "./run";
import { repositoryRoot } from "./repo";

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
  sequencer: "rebase" | "cherry-pick" | "revert" | null;
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
  const head = await runGit(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: repoRoot },
  );
  const mergeHeadSha = head.code === 0 ? head.stdout.trim() || null : null;
  return {
    inProgress: mergeHeadSha !== null,
    mergeHeadSha,
    conflictedPaths: await unmergedPaths(repoRoot),
    sequencer: await sequencerState(repoRoot),
  };
}

/** Which sequenced operation (if any) the tree is in the middle of. */
export async function sequencerState(
  repoRoot: string,
): Promise<"rebase" | "cherry-pick" | "revert" | null> {
  const gitPath = async (name: string): Promise<string | null> => {
    const r = await runGit(["rev-parse", "--git-path", name], {
      cwd: repoRoot,
    });
    if (r.code !== 0) return null;
    const raw = r.stdout.trim();
    if (!raw) return null;
    return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
  };
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const path = await gitPath(dir);
    if (path && existsSync(path)) return "rebase";
  }
  // `CHERRY_PICK_HEAD`/`REVERT_HEAD` mark the current conflicted pick; the
  // `sequencer` directory means further picks are still queued behind it.
  for (const [file, kind] of [
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ] as const) {
    const path = await gitPath(file);
    if (path && existsSync(path)) return kind;
  }
  const seq = await gitPath("sequencer");
  if (seq && existsSync(seq)) return "cherry-pick";
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
    throw new GitError("no merge is in progress in this tree", emptyResult());
  }
  await runGitOk(["merge", "--abort"], { cwd: repoRoot, timeoutMs: 60_000 });
  return {
    headSha: (await runGitOk(["rev-parse", "HEAD"], { cwd: repoRoot })).trim(),
  };
}

/** Paths with unmerged index entries, relative to the repo root. */
export async function unmergedPaths(repoRoot: string): Promise<string[]> {
  const out = await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: repoRoot,
  });
  if (out.code !== 0) return [];
  return out.stdout.split("\0").filter(Boolean);
}
