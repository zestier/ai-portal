import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  emptyResult,
  GitError,
  runGit,
  runGitOk,
  type CommitProgress,
} from "./run";
import { repositoryRoot } from "./repo";
import { aggregateStatus, status, type StatusEntry } from "./status";
import { mergeState, unmergedPaths } from "./merge";
import {
  nameStatus,
  numstat,
  type DiffStat,
  type DiffTarget,
  type NameStatusEntry,
  type NumstatEntry,
} from "./diff";
import { log as logger } from "../log";
import { safeResolve } from "../files";

export interface CommitTrailer {
  token: string;
  value: string;
}

export interface CommitChangesOptions {
  paths: "all" | string[];
  subject: string;
  body?: string | undefined;
  trailers?: CommitTrailer[] | undefined;
  /**
   * Allow committing a previously-conflicted file that still contains conflict
   * markers. Off by default: the overwhelmingly likely reason a resolved file
   * still has `<<<<<<<` in it is that it was never actually resolved, and
   * committing that is silent corruption. The escape hatch exists because a
   * file can legitimately contain marker-shaped lines (documentation about
   * conflicts, test fixtures).
   */
  allowConflictMarkers?: boolean | undefined;
}

/**
 * True when `content` still carries git's conflict markers.
 *
 * Matches a line STARTING with `<<<<<<<`, `|||||||`, or `>>>>>>>`, so a
 * half-cleaned conflict — the realistic botched resolution — is caught, not just
 * an untouched one. A bare `=======` is deliberately not a marker on its own:
 * it is a Markdown/RST heading underline, and flagging it would refuse ordinary
 * documentation commits.
 */
export function hasConflictMarkers(content: string): boolean {
  for (const line of content.split("\n")) {
    if (
      line.startsWith("<<<<<<<") ||
      line.startsWith(">>>>>>>") ||
      line.startsWith("|||||||")
    ) {
      return true;
    }
  }
  return false;
}

export interface CommitChangesResult {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  trailers: CommitTrailer[];
  files: NameStatusEntry[];
  fileStats: NumstatEntry[];
  diffStat: DiffStat["total"];
  remainingDirtyFiles: Array<
    StatusEntry & { status: ReturnType<typeof aggregateStatus> }
  >;
  /** True when this commit concluded an in-progress merge (it has 2+ parents). */
  mergeCommit: boolean;
  /** Paths that were unmerged going in and were resolved by this commit. */
  resolvedConflicts: string[];
}

const TRAILER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function formatCommitMessage(opts: {
  subject: string;
  body?: string | undefined;
  trailers?: CommitTrailer[] | undefined;
}): string {
  if (!opts.subject.trim())
    throw new GitError("commit subject is required", emptyResult());
  if (hasControlCharacter(opts.subject)) {
    throw new GitError(
      "commit subject must be a single line without control characters",
      emptyResult(),
    );
  }
  const lines = [opts.subject];
  const body = opts.body;
  if (body !== undefined && body.length > 0) {
    if (hasControlCharacter(body, { allowWhitespace: true }))
      throw new GitError(
        "commit body must not contain control characters",
        emptyResult(),
      );
    lines.push("", body.trimEnd());
  }
  if (opts.trailers?.length) {
    lines.push("");
    for (const trailer of opts.trailers) {
      if (
        !TRAILER_TOKEN_RE.test(trailer.token) ||
        trailer.token.includes("\n") ||
        trailer.token.includes("\r") ||
        hasControlCharacter(trailer.token)
      ) {
        throw new GitError(
          `invalid trailer token: ${trailer.token}`,
          emptyResult(),
        );
      }
      if (
        trailer.value.includes("\n") ||
        trailer.value.includes("\r") ||
        hasControlCharacter(trailer.value)
      ) {
        throw new GitError(
          `invalid trailer value for ${trailer.token}`,
          emptyResult(),
        );
      }
      lines.push(`${trailer.token}: ${trailer.value}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function commitChanges(
  cwd: string,
  opts: CommitChangesOptions,
  ctx?: CommitProgress,
): Promise<CommitChangesResult> {
  const repoRoot = await repositoryRoot(cwd);
  const commitMessage = formatCommitMessage(opts);
  const entries = await status(repoRoot);
  const merge = await mergeState(repoRoot);
  const mergeInProgress = merge.inProgress;
  const conflicts = entries.filter(
    (e) => e.index === "conflicted" || e.worktree === "conflicted",
  );
  // True when this commit is the one that concludes a merge / clears a
  // conflicted index, which changes what `paths: "all"` may stage and whether
  // an empty staged diff is a reason to refuse.
  const concludesMerge = mergeInProgress || conflicts.length > 0;
  if (concludesMerge) {
    // A conflicted tree is committable — that is how a merge left by
    // `onConflict: "keep"` is finished — but only as a whole. Git refuses to
    // commit anything at all while paths remain unmerged, and mid-merge the
    // index already holds every cleanly-merged path, so a path selection here
    // would quietly commit far more than it named.
    if (opts.paths !== "all") {
      throw new GitError(
        (conflicts.length > 0
          ? `this tree has ${conflicts.length} unmerged (conflicted) file(s): ${conflicts.map((e) => e.path).join(", ")}. Resolve them and `
          : "this tree has an in-progress merge; ") +
          'commit with paths: "all" (a commit that concludes a merge cannot be partial)',
        emptyResult(),
      );
    }
    if (opts.allowConflictMarkers !== true) {
      const unresolved = conflicts.filter((entry) =>
        fileHasConflictMarkers(repoRoot, entry.path),
      );
      if (unresolved.length > 0) {
        throw new GitError(
          `cannot commit unresolved conflict markers in: ${unresolved.map((e) => e.path).join(", ")}. ` +
            "Edit each file to keep the intended content and delete the <<<<<<< / ======= / >>>>>>> lines, " +
            "or pass allowConflictMarkers: true if the markers are genuinely part of the file.",
          emptyResult(),
        );
      }
    }
  }

  const selectedPaths =
    opts.paths === "all" ? null : validateCommitPaths(repoRoot, opts.paths);
  const selectedEntries =
    selectedPaths === null
      ? entries
      : entries.filter((entry) => statusEntryMatches(entry, selectedPaths));
  // Mid-merge there may be nothing in `status` at all (every conflict already
  // resolved and staged, or a clean `--no-commit` merge) and the commit is
  // still required to conclude the merge. Bailing there would strand the tree
  // in the unfinishable state this path exists to leave.
  if (selectedEntries.length === 0 && !concludesMerge) {
    throw new GitError("no selected changes to commit", emptyResult());
  }

  if (selectedPaths !== null) {
    const unrelatedStaged = entries.filter(
      (entry) =>
        hasIndexChange(entry) && !statusEntryMatches(entry, selectedPaths),
    );
    if (unrelatedStaged.length > 0) {
      throw new GitError(
        `cannot commit selected paths while unrelated changes are staged: ${unrelatedStaged.map((e) => e.path).join(", ")}`,
        emptyResult(),
      );
    }
  }

  const snapshot = await snapshotIndex(repoRoot);
  const headBefore = (
    await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })
  ).stdout.trim();
  let messageDir: string | null = null;

  try {
    messageDir = await mkdtemp(join(tmpdir(), "portal-git-commit-"));
    const messagePath = join(messageDir, "message.txt");
    writeFileSync(messagePath, commitMessage, "utf8");
    ctx?.progress?.("staging changes…");
    if (selectedPaths !== null) {
      await runGitOk(
        ["--literal-pathspecs", "add", "-A", "--", ...selectedPaths],
        {
          cwd: repoRoot,
        },
      );
    } else if (concludesMerge) {
      // Mid-merge, `paths: "all"` means "stage my resolutions", NOT "sweep
      // the tree": the index already holds the merge result, and a merge
      // commit that also absorbed unrelated edits an agent happened to make
      // while resolving would be a worse trap than the one this path fixes.
      // Anything else stays dirty and is reported in `remainingDirtyFiles`.
      if (conflicts.length > 0) {
        await runGitOk(
          [
            "--literal-pathspecs",
            "add",
            "-A",
            "--",
            ...conflicts.map((entry) => entry.path),
          ],
          { cwd: repoRoot },
        );
      }
    } else {
      await runGitOk(["add", "-A", "--", "."], { cwd: repoRoot });
    }
    const stagedFiles = await nameStatus(repoRoot, { kind: "index-vs-head" });
    // An empty staged diff normally means the caller selected nothing real.
    // Mid-merge it does not: a resolution that lands back on HEAD's content
    // still has to be committed to conclude the merge.
    if (stagedFiles.length === 0 && !concludesMerge) {
      throw new GitError("no selected changes to commit", emptyResult());
    }
    // `git add` above is what resolves an unmerged entry. A backstop for the
    // paths git could not stage (skip-worktree / sparse entries): git would
    // otherwise fail the commit with a bare "cannot commit with unmerged
    // files" that names nothing.
    const stillUnmerged = await unmergedPaths(repoRoot);
    if (stillUnmerged.length > 0) {
      throw new GitError(
        `cannot commit while paths remain unmerged: ${stillUnmerged.join(", ")}`,
        emptyResult(),
      );
    }
    ctx?.progress?.("running git commit (pre-commit / commit-msg hooks)…");
    await runGitOk(["commit", "-F", messagePath], {
      cwd: repoRoot,
      // Pre-commit hooks can run a full verify suite; keep the budget well
      // above a plain git op.
      timeoutMs: 180_000,
      onData: ctx?.partial ? (snap) => ctx.partial?.(snap) : undefined,
      signal: ctx?.signal,
    });
    ctx?.progress?.("finalizing commit…");
  } catch (err) {
    // Restoring the pre-commit index is right only while the commit did NOT
    // land. An abort (or a hook timing out after the ref moved) can leave HEAD
    // advanced — restoring a stale, possibly unmerged index over a landed
    // commit would manufacture phantom changes and, after a merge, resurrect
    // conflicts git has already recorded as resolved.
    const headAfterRun = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
    const headAfter =
      headAfterRun.code === 0 ? headAfterRun.stdout.trim() : null;
    if (headAfter !== null && headAfter !== headBefore) {
      logger.warn("git.commit.head_advanced_on_failure", {
        headBefore,
        headAfter,
        originalErr: String(err),
      });
      // Surfaced, not swallowed: the caller must not retry blindly and create
      // a second commit of the same work.
      throw new GitError(
        `${err instanceof Error ? err.message : String(err)} — but HEAD advanced from ${headBefore || "(none)"} to ${headAfter}, so the commit may have landed. ` +
          "Inspect the history before retrying; the index was left as git wrote it.",
        err instanceof GitError ? err.result : emptyResult(),
      );
    }
    try {
      restoreIndex(snapshot);
    } catch (restoreErr) {
      logger.warn("git.commit.index_restore_failed", {
        err: String(restoreErr),
        originalErr: String(err),
      });
    }
    throw err;
  } finally {
    if (messageDir) rmSync(messageDir, { recursive: true, force: true });
  }

  const sha = (await runGitOk(["rev-parse", "HEAD"], { cwd: repoRoot })).trim();
  const parents = (
    await runGitOk(["rev-list", "-1", "--parents", sha], { cwd: repoRoot })
  )
    .trim()
    .split(/\s+/)
    .slice(1);
  const mergeCommit = parents.length > 1;
  // `<sha>^!` expands to the commit plus every parent negated, which `git diff`
  // cannot take for a merge. Diff a merge against its FIRST parent instead —
  // "what this commit brought into the branch it landed on".
  const fileTarget: DiffTarget = mergeCommit
    ? { kind: "commit-vs-parent", sha }
    : { kind: "commit", sha };
  const [files, fileStats, remaining] = await Promise.all([
    nameStatus(repoRoot, fileTarget),
    numstat(repoRoot, fileTarget),
    status(repoRoot),
  ]);
  const diffStatTotal = fileStats.reduce(
    (acc, file) => {
      acc.filesChanged += 1;
      acc.added += file.added ?? 0;
      acc.removed += file.removed ?? 0;
      return acc;
    },
    { filesChanged: 0, added: 0, removed: 0 },
  );

  return {
    sha,
    shortSha: sha.slice(0, 8),
    subject: opts.subject,
    body: opts.body?.trimEnd() ?? "",
    trailers: opts.trailers ?? [],
    files,
    fileStats,
    diffStat: diffStatTotal,
    remainingDirtyFiles: remaining.map((entry) => ({
      ...entry,
      status: aggregateStatus(entry),
    })),
    mergeCommit,
    resolvedConflicts: conflicts.map((entry) => entry.path),
  };
}

function validateCommitPaths(repoRoot: string, paths: string[]): string[] {
  if (paths.length === 0)
    throw new GitError(
      'paths must be "all" or a non-empty array',
      emptyResult(),
    );
  const validated: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (path.length === 0)
      throw new GitError("commit paths must not be empty", emptyResult());
    if (hasControlCharacter(path)) {
      throw new GitError(
        `invalid path: control characters are not allowed: ${path}`,
        emptyResult(),
      );
    }
    const r = safeResolve(repoRoot, path);
    if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
    if (!r.rel)
      throw new GitError(
        'use paths: "all" to commit the entire repository',
        emptyResult(),
      );
    if (!seen.has(r.rel)) {
      seen.add(r.rel);
      validated.push(r.rel);
    }
  }
  return validated;
}

function statusEntryMatches(
  entry: StatusEntry,
  selectedPaths: string[],
): boolean {
  return selectedPaths.some(
    (path) => entry.path === path || entry.origPath === path,
  );
}

/**
 * Read a repo-relative working-tree file and look for conflict markers.
 *
 * Missing/unreadable (a delete/modify conflict resolved by deleting) and binary
 * content both count as marker-free: the point is to catch a text file the agent
 * forgot to edit, not to second-guess a deliberate deletion.
 */
function fileHasConflictMarkers(repoRoot: string, relPath: string): boolean {
  const resolved = safeResolve(repoRoot, relPath);
  if (!resolved.ok) return false;
  try {
    const buf = readFileSync(resolved.abs);
    if (buf.includes(0)) return false;
    return hasConflictMarkers(buf.toString("utf-8"));
  } catch {
    return false;
  }
}

function hasIndexChange(entry: StatusEntry): boolean {
  return (
    entry.index !== "unmodified" &&
    entry.index !== "untracked" &&
    entry.index !== "ignored"
  );
}

interface IndexSnapshot {
  path: string;
  existed: boolean;
  data: Buffer | null;
}

async function snapshotIndex(repoRoot: string): Promise<IndexSnapshot> {
  const gitIndexPath = (
    await runGitOk(["rev-parse", "--git-path", "index"], { cwd: repoRoot })
  ).trim();
  const indexPath = isAbsolute(gitIndexPath)
    ? gitIndexPath
    : resolve(repoRoot, gitIndexPath);
  return {
    path: indexPath,
    existed: existsSync(indexPath),
    data: existsSync(indexPath) ? readFileSync(indexPath) : null,
  };
}

function restoreIndex(snapshot: IndexSnapshot): void {
  if (snapshot.existed && snapshot.data) {
    mkdirSync(dirname(snapshot.path), { recursive: true });
    writeFileSync(snapshot.path, snapshot.data);
    return;
  }
  rmSync(snapshot.path, { force: true });
}

function hasControlCharacter(
  value: string,
  opts: { allowWhitespace?: boolean } = {},
): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      opts.allowWhitespace &&
      (code === 0x09 || code === 0x0a || code === 0x0d)
    )
      continue;
    // C0 controls and DEL (U+0000–U+001F, U+007F) plus C1 controls
    // (U+0080–U+009F). C1 includes NEL (U+0085), which can forge extra
    // commit lines, and the bytes used by ANSI escape sequences.
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f))
      return true;
  }
  return false;
}
