import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runGitRaw, type GitRunResult } from "../git";

export const TIMEOUT_MS = 20_000;
/**
 * Longer budget for the one call here that runs repository hooks (the squash
 * commit). Matches `commitChanges`, whose `pre-commit` can be a whole test
 * suite; the plumbing calls around it stay on the short timeout.
 */
export const HOOK_TIMEOUT_MS = 60_000;

export type WorktreeIntegrationErrorCode =
  | "not_git_repository"
  | "not_a_worktree"
  | "detached_head"
  | "upstream_detached"
  | "worktree_dirty"
  | "upstream_dirty"
  | "not_fast_forwardable"
  | "merge_conflict"
  | "squash_not_applicable"
  | "squash_behind_source"
  | "invalid_squash_message"
  | "git_failed";

export class WorktreeIntegrationError extends Error {
  constructor(
    public readonly code: WorktreeIntegrationErrorCode,
    message: string,
    public readonly detail?: {
      stderr?: string;
      dirtyCount?: number;
      conflicts?: string[];
      ahead?: number;
      behind?: number;
    },
  ) {
    super(message);
    this.name = "WorktreeIntegrationError";
  }
}

export async function git(
  cwd: string,
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<GitRunResult> {
  return runGitRaw(args, { cwd, timeoutMs });
}

export async function gitOk(
  cwd: string,
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  const result = await git(cwd, args, timeoutMs);
  if (result.code !== 0) {
    throw new WorktreeIntegrationError(
      "git_failed",
      result.timedOut ? `git ${args[0]} timed out` : `git ${args[0]} failed`,
      { stderr: result.stderr.trim() },
    );
  }
  return result.stdout.trim();
}

export interface WorktreeRecord {
  path: string;
  branch: string | null;
  /** Commit checked out in the tree, or null for a bare repository. */
  head: string | null;
  /** True for the record describing a bare repository (it has no working tree). */
  bare: boolean;
  /** True when HEAD points at a commit rather than a branch. */
  detached: boolean;
  /** Reason given to `git worktree lock`, '' when locked without one, null when unlocked. */
  lockedReason: string | null;
  /** Why git considers the record removable (e.g. its directory is gone), else null. */
  prunableReason: string | null;
}

/** `<keyword>` alone or `<keyword> <value>`; returns the value ('' when bare). */
export function porcelainValue(line: string, keyword: string): string | null {
  if (line === keyword) return "";
  if (line.startsWith(`${keyword} `))
    return line.slice(keyword.length + 1).trim();
  return null;
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated and
 * the FIRST one is always the main worktree, which is the property this module
 * relies on to identify "upstream".
 */
export function parseWorktreeList(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length).trim(),
        branch: null,
        head: null,
        bare: false,
        detached: false,
        lockedReason: null,
        prunableReason: null,
      };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else {
      const locked = porcelainValue(line, "locked");
      if (locked !== null) {
        current.lockedReason = locked;
        continue;
      }
      const prunable = porcelainValue(line, "prunable");
      if (prunable !== null) current.prunableReason = prunable;
    }
  }
  return records;
}

export function countLines(text: string): number {
  return text ? text.split("\n").filter(Boolean).length : 0;
}

/** Realpath when possible, lexical resolve otherwise (mirrors `worktrees.ts`). */
export function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
