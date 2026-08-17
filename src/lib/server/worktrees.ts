import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { isolatedChildEnv } from "./child-env";
import { loadConfig } from "./config";
import { withRepositoryLock } from "./repo-lock";
import {
  prepareGeneratedParent,
  slotBranch,
  slotPath,
  WorktreeError,
  type WorktreeSlot,
} from "./worktree-slots";

export * from "./worktree-slots";

const MAX_OUTPUT_BYTES = 1024 * 1024;

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

function runGit(
  cwd: string,
  args: string[],
  timeoutMs?: number,
): Promise<GitResult> {
  return new Promise((done) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: isolatedChildEnv(process.env, {
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        LC_ALL: "C",
      }),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs ?? loadConfig().WORKTREE_CREATE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout = Buffer.concat([
          stdout,
          chunk.subarray(0, MAX_OUTPUT_BYTES - stdout.length),
        ]);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) {
        stderr = Buffer.concat([
          stderr,
          chunk.subarray(0, 65_536 - stderr.length),
        ]);
      }
    });
    child.on("error", (error) => {
      stderr = Buffer.concat([stderr, Buffer.from(`\n${error.message}`)]);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new WorktreeError(
      "git_failed",
      result.timedOut ? `git ${args[0]} timed out` : `git ${args[0]} failed`,
      { stderr: result.stderr.trim() },
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

export async function inspectRepository(sourceWorkdir: string): Promise<{
  sourceWorkdir: string;
  gitCommonDir: string;
  baseSha: string;
}> {
  const source = realpathOrResolve(sourceWorkdir);
  const inside = await runGit(source, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new WorktreeError(
      "not_git_repository",
      "source is not a git repository",
    );
  }
  const topLevel = realpathOrResolve(
    await gitOk(source, ["rev-parse", "--show-toplevel"]),
  );
  const head = await runGit(topLevel, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (head.code !== 0) {
    throw new WorktreeError(
      "repository_has_no_commits",
      "repository has no commits",
    );
  }
  const commonRaw = await gitOk(topLevel, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return {
    sourceWorkdir: topLevel,
    gitCommonDir: realpathOrResolve(commonRaw),
    baseSha: head.stdout.trim(),
  };
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
  const baseRef = input.baseRef?.trim() || "HEAD";
  if (baseRef.startsWith("-")) {
    throw new WorktreeError(
      "invalid_base_ref",
      "base ref cannot start with a dash",
    );
  }
  const resolved = await runGit(repository.sourceWorkdir, [
    "rev-parse",
    "--verify",
    `${baseRef}^{commit}`,
  ]);
  if (resolved.code !== 0) {
    throw new WorktreeError(
      "invalid_base_ref",
      `base ref does not resolve: ${baseRef}`,
    );
  }
  const baseSha = resolved.stdout.trim();

  return withRepositoryLock(repository.gitCommonDir, async () => {
    if (existsSync(path)) {
      throw new WorktreeError(
        "worktree_exists",
        "managed worktree path already exists",
      );
    }
    prepareGeneratedParent(path, input.slot);
    const existingBranch = await runGit(repository.sourceWorkdir, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (existingBranch.code === 0) {
      throw new WorktreeError(
        "branch_exists",
        `branch already exists: ${branch}`,
      );
    }
    const added = await runGit(repository.sourceWorkdir, [
      "worktree",
      "add",
      "-b",
      branch,
      path,
      baseSha,
    ]);
    if (added.code !== 0) {
      await runGit(repository.sourceWorkdir, [
        "worktree",
        "remove",
        "--force",
        path,
      ]);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      // Do not delete the branch here: a concurrent external process may
      // have created it after our preflight check, causing this add to fail.
      // Deleting an ambiguously-owned branch would risk user data loss.
      throw new WorktreeError("git_failed", "git worktree add failed", {
        stderr: added.stderr.trim(),
      });
    }
    const metadata: ManagedWorktreeMetadata = {
      sourceWorkdir: repository.sourceWorkdir,
      path: realpathOrResolve(path),
      gitCommonDir: repository.gitCommonDir,
      branch,
      baseSha,
    };
    if (input.onCreated) {
      // Persist-inside-the-lock hook. A throw here must not leave an orphan
      // checkout, so roll the worktree back before propagating.
      try {
        await input.onCreated(metadata);
      } catch (cause) {
        await runGit(repository.sourceWorkdir, [
          "worktree",
          "remove",
          "--force",
          path,
        ]);
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
        await runGit(repository.sourceWorkdir, ["branch", "-D", branch]);
        throw cause;
      }
    }
    return metadata;
  });
}

export async function createManagedWorktree(
  input: CreateManagedWorktreeInput,
): Promise<ManagedWorktreeMetadata> {
  return createWorktreeForSlot({
    sourceWorkdir: input.sourceWorkdir,
    slot: {
      kind: "conversation",
      userId: input.userId,
      conversationId: input.conversationId,
    },
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
  });
}

/**
 * Create a linked worktree at the snapshot's original HEAD, then overlay the
 * captured tree as ordinary unstaged/untracked changes.
 */
export async function createManagedWorktreeFromSnapshot(
  input: CreateManagedWorktreeFromSnapshotInput,
): Promise<ManagedWorktreeMetadata> {
  if (
    (input.baseCommitSha !== undefined &&
      !/^[0-9a-f]{40,64}$/.test(input.baseCommitSha)) ||
    !/^[0-9a-f]{40,64}$/.test(input.treeSha)
  ) {
    throw new WorktreeError(
      "invalid_base_ref",
      "snapshot contains invalid git object ids",
    );
  }
  const metadata = await createManagedWorktree({
    sourceWorkdir: input.sourceWorkdir,
    userId: input.userId,
    conversationId: input.conversationId,
    ...(input.baseCommitSha ? { baseRef: input.baseCommitSha } : {}),
  });
  try {
    await gitOk(metadata.path, ["read-tree", "--reset", "-u", input.treeSha]);
    await gitOk(metadata.path, ["reset", "--mixed", "HEAD"]);
    return metadata;
  } catch (cause) {
    await rollbackManagedWorktree(metadata).catch(() => undefined);
    throw cause;
  }
}

export async function inspectManagedWorktree(
  metadata: ManagedWorktreeMetadata,
): Promise<{ dirtyCount: number }> {
  if (!existsSync(metadata.path)) {
    throw new WorktreeError(
      "worktree_unavailable",
      "managed worktree path is missing",
    );
  }
  const actualCommon = realpathOrResolve(
    await gitOk(metadata.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  if (actualCommon !== realpathOrResolve(metadata.gitCommonDir)) {
    throw new WorktreeError(
      "worktree_unavailable",
      "managed worktree repository does not match",
    );
  }
  const status = await gitOk(metadata.path, [
    "status",
    "--porcelain=v1",
    "-uall",
  ]);
  return { dirtyCount: status ? status.split("\n").filter(Boolean).length : 0 };
}

export async function removeManagedWorktree(
  metadata: ManagedWorktreeMetadata,
  opts: { force?: boolean; owner?: WorktreeSlot } = {},
): Promise<void> {
  await withRepositoryLock(
    realpathOrResolve(metadata.gitCommonDir),
    async () => {
      if (!existsSync(metadata.path)) {
        await runGit(metadata.sourceWorkdir, ["worktree", "prune"]);
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
        throw new WorktreeError(
          "worktree_dirty",
          "managed worktree has uncommitted changes",
          {
            dirtyCount,
          },
        );
      }
      const args = ["worktree", "remove"];
      if (opts.force) args.push("--force");
      args.push(metadata.path);
      const removed = await runGit(metadata.sourceWorkdir, args);
      if (removed.code !== 0) {
        throw new WorktreeError("git_failed", "git worktree remove failed", {
          stderr: removed.stderr.trim(),
        });
      }
    },
  );
}

function removeUnavailableOwnedWorktree(
  path: string,
  owner: WorktreeSlot,
): void {
  const expected = realpathOrResolve(slotPath(owner));
  const stored = resolve(path);
  try {
    const entry = lstatSync(stored);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      realpathSync(stored) !== expected
    ) {
      throw new Error("path does not resolve to the owned worktree");
    }
  } catch {
    throw new WorktreeError(
      "worktree_unavailable",
      "managed worktree path cannot be safely force-removed",
    );
  }
  if (stored !== expected) {
    throw new WorktreeError(
      "worktree_unavailable",
      "managed worktree path cannot be safely force-removed",
    );
  }
  rmSync(stored, { recursive: true, force: true });
}

/**
 * Roll back a just-created worktree when later persistence fails.
 *
 * Uses `-D` rather than `-d` because the branch is unmerged by construction —
 * it was created moments ago at `baseSha` and never used. That is safe ONLY on
 * this path; every other caller must go through {@link deleteMergedBranch}.
 *
 * The ref deletion takes the repository lock like every other mutation here:
 * `removeManagedWorktree` releases the lock before returning, so without this
 * the delete could interleave with a merge into the source checkout or a
 * concurrent worktree add/remove.
 */
export async function rollbackManagedWorktree(
  metadata: ManagedWorktreeMetadata,
): Promise<void> {
  await removeManagedWorktree(metadata, { force: true });
  await withRepositoryLock(
    realpathOrResolve(metadata.gitCommonDir),
    async () => {
      await runGit(metadata.sourceWorkdir, ["branch", "-D", metadata.branch]);
    },
  );
}

/**
 * Delete a branch only if it is fully merged (`git branch -d`, never `-D`).
 *
 * Returns false when the branch was kept because it still holds unmerged
 * commits. This is what makes dropping a lease non-destructive: the checkout
 * goes away, but committed work survives under its branch name for the user to
 * merge or delete deliberately.
 *
 * Takes the repository lock, like every other mutation in this module: ref
 * deletion must not interleave with a `to-source` merge or a concurrent
 * `worktree add`/`remove` on the same repository.
 */
export async function deleteMergedBranch(
  cwd: string,
  branch: string,
): Promise<boolean> {
  const { gitCommonDir } = await inspectRepository(cwd);
  return withRepositoryLock(gitCommonDir, async () => {
    const result = await runGit(cwd, ["branch", "-d", branch]);
    return result.code === 0;
  });
}

/**
 * Drop git's administrative entries for worktrees whose directory is gone.
 *
 * Removing a checkout out-of-band (a crash, a manual `rm -rf`) leaves
 * `.git/worktrees/<name>` behind, so `git worktree list` keeps reporting a tree
 * that does not exist. Nothing reads those stale records incorrectly today, but
 * they accumulate for the life of the repository, so startup reconciliation
 * clears them. Best-effort: a prune failure is not worth failing boot over.
 */
export async function pruneWorktrees(cwd: string): Promise<boolean> {
  try {
    const { gitCommonDir } = await inspectRepository(cwd);
    return await withRepositoryLock(gitCommonDir, async () => {
      const result = await runGit(cwd, ["worktree", "prune"]);
      return result.code === 0;
    });
  } catch {
    return false;
  }
}
