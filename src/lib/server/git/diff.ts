import { emptyResult, GitError, runGitOk } from "./run";
import { decodeStatusChar, type StatusCode } from "./status";
import { safeResolve } from "../files";
import { DEFAULT_MAX_BYTES, SHA_RE } from "./common";

export type DiffTarget =
  | { kind: "worktree-vs-head" }
  | { kind: "worktree-vs-index" }
  | { kind: "index-vs-head" }
  | { kind: "commit"; sha: string }
  | { kind: "commit-vs-parent"; sha: string };

function diffPathArgs(cwd: string, relPath?: string): string[] {
  if (relPath !== undefined && relPath !== "") {
    const r = safeResolve(cwd, relPath);
    if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
    return ["--", r.rel];
  }
  return [];
}

export function diffArgs(
  cwd: string,
  target: DiffTarget,
  extraArgs: string[] = [],
  relPath?: string,
): string[] {
  const pathArgs = diffPathArgs(cwd, relPath);
  const baseArgs = ["diff", "--no-color", "--no-ext-diff", ...extraArgs];
  switch (target.kind) {
    case "worktree-vs-head":
      return [...baseArgs, "HEAD", ...pathArgs];
    case "worktree-vs-index":
      return [...baseArgs, ...pathArgs];
    case "index-vs-head":
      return [...baseArgs, "--cached", ...pathArgs];
    case "commit": {
      if (!SHA_RE.test(target.sha))
        throw new GitError("invalid sha", emptyResult());
      return [...baseArgs, `${target.sha}^!`, ...pathArgs];
    }
    case "commit-vs-parent": {
      if (!SHA_RE.test(target.sha))
        throw new GitError("invalid sha", emptyResult());
      return [...baseArgs, `${target.sha}^`, target.sha, ...pathArgs];
    }
  }
}

/**
 * Returns a unified diff for an optional path. If `relPath` is provided it
 * must be resolvable inside `cwd`.
 */
export async function diff(
  cwd: string,
  target: DiffTarget,
  relPath?: string,
): Promise<string> {
  const args = diffArgs(cwd, target, [], relPath);
  return await runGitOk(args, { cwd, maxBytes: DEFAULT_MAX_BYTES });
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
  relPath?: string,
): Promise<NumstatEntry[]> {
  const args = diffArgs(cwd, target, ["--numstat", "-z"], relPath);
  const out = await runGitOk(args, { cwd });
  // With -z, each record is "added\tremoved\tpath\0" except for renames,
  // which are "added\tremoved\t\0origPath\0newPath\0".
  const entries: NumstatEntry[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const tab1 = rec.indexOf("\t");
    const tab2 = rec.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const aStr = rec.slice(0, tab1);
    const rStr = rec.slice(tab1 + 1, tab2);
    const rest = rec.slice(tab2 + 1);
    const added = aStr === "-" ? null : Number.parseInt(aStr, 10);
    const removed = rStr === "-" ? null : Number.parseInt(rStr, 10);
    if (rest === "") {
      // Rename: next two parts are origPath and newPath.
      const origPath = parts[i + 1] ?? "";
      const newPath = parts[i + 2] ?? "";
      i += 2;
      entries.push({
        path: newPath,
        origPath: origPath || null,
        added,
        removed,
      });
    } else {
      entries.push({ path: rest, origPath: null, added, removed });
    }
  }
  return entries;
}

export async function diffStat(
  cwd: string,
  target: DiffTarget,
  relPath?: string,
): Promise<DiffStat> {
  const files = await numstat(cwd, target, relPath);
  const total = files.reduce(
    (acc, file) => {
      acc.filesChanged += 1;
      acc.added += file.added ?? 0;
      acc.removed += file.removed ?? 0;
      return acc;
    },
    { filesChanged: 0, added: 0, removed: 0 },
  );
  return { files, total };
}

export async function nameOnly(
  cwd: string,
  target: DiffTarget,
  relPath?: string,
): Promise<string[]> {
  const out = await runGitOk(
    diffArgs(cwd, target, ["--name-only", "-z"], relPath),
    { cwd },
  );
  return out.split("\0").filter(Boolean);
}

export async function nameStatus(
  cwd: string,
  target: DiffTarget,
  relPath?: string,
): Promise<NameStatusEntry[]> {
  const out = await runGitOk(
    diffArgs(cwd, target, ["--name-status", "-z"], relPath),
    { cwd },
  );
  const entries: NameStatusEntry[] = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const statusCode = parts[i];
    const head = statusCode[0];
    if (head === "R" || head === "C") {
      const origPath = parts[++i] ?? "";
      const path = parts[++i] ?? "";
      entries.push({
        statusCode,
        status: head === "R" ? "renamed" : "copied",
        path,
        origPath: origPath || null,
      });
    } else {
      entries.push({
        statusCode,
        status: decodeStatusChar(head),
        path: parts[++i] ?? "",
        origPath: null,
      });
    }
  }
  return entries;
}
