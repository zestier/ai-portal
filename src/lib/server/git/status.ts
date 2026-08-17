import { emptyResult, GitError, runGit, runGitOk } from "./run";
import { isGitRepo } from "./repo";

export type StatusCode =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "updated"
  | "untracked"
  | "ignored"
  | "conflicted";

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
  " ": "unmodified",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "updated",
  "?": "untracked",
  "!": "ignored",
};

export function decodeStatusChar(c: string): StatusCode {
  return STATUS_MAP[c] ?? "unmodified";
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
  opts: { includeIgnored?: boolean } = {},
):
  | "untracked"
  | "ignored"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted"
  | null {
  if (e.index === "conflicted" || e.worktree === "conflicted")
    return "conflicted";
  if (e.index === "untracked" || e.worktree === "untracked") return "untracked";
  if (
    opts.includeIgnored &&
    (e.index === "ignored" || e.worktree === "ignored")
  )
    return "ignored";
  if (e.index === "renamed" || e.worktree === "renamed") return "renamed";
  if (e.index === "added" || e.worktree === "added") return "added";
  if (e.index === "deleted" || e.worktree === "deleted") return "deleted";
  if (e.index === "modified" || e.worktree === "modified") return "modified";
  return null;
}

/**
 * Returns one entry per changed (or untracked/ignored) path. Unchanged
 * tracked files are omitted to keep the response small; the UI merges
 * statuses into directory listings client-side or via `mergeStatusIntoTree`.
 */
export async function status(
  cwd: string,
  opts: StatusOptions = {},
): Promise<StatusEntry[]> {
  const args = ["status", "--porcelain=v1", "-uall", "-z"];
  if (opts.includeIgnored) args.push("--ignored");
  const out = await runGitOk(args, { cwd });
  // -z output: entries separated by NUL. For R/C entries there are two
  // NUL-separated paths.
  const entries: StatusEntry[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.length < 3) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    let origPath: string | null = null;
    if (xy[0] === "R" || xy[0] === "C") {
      // Next part is the original path.
      origPath = parts[i + 1] ?? null;
      i++;
    }
    // Conflicted entries are codes like DD, AU, UD, UA, DU, AA, UU.
    const conflictPairs = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
    if (conflictPairs.has(xy)) {
      entries.push({
        path,
        origPath,
        index: "conflicted",
        worktree: "conflicted",
      });
      continue;
    }
    if (xy === "??") {
      entries.push({
        path,
        origPath,
        index: "untracked",
        worktree: "untracked",
      });
      continue;
    }
    if (xy === "!!") {
      entries.push({ path, origPath, index: "ignored", worktree: "ignored" });
      continue;
    }
    entries.push({
      path,
      origPath,
      index: decodeStatusChar(xy[0]),
      worktree: decodeStatusChar(xy[1]),
    });
  }
  return entries;
}

export async function discardAllLocalChanges(cwd: string): Promise<void> {
  if (!(await isGitRepo(cwd)))
    throw new GitError("not a git repository", emptyResult());

  const head = await runGit(["rev-parse", "--verify", "HEAD"], { cwd });
  if (head.code === 0) {
    await runGitOk(["reset", "--hard", "HEAD"], { cwd });
  } else {
    const entries = await status(cwd);
    const hasIndexEntries = entries.some(
      (e) =>
        e.index !== "unmodified" &&
        e.index !== "untracked" &&
        e.index !== "ignored",
    );
    if (hasIndexEntries) {
      await runGitOk(["rm", "-r", "--cached", "--ignore-unmatch", "--", "."], {
        cwd,
      });
    }
  }
  await runGitOk(["clean", "-fd"], { cwd });
}
