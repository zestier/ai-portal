/**
 * Where a `git_commit` will land, resolved server-side from the request's
 * `worktree` lease id.
 *
 * The dialog is a human's only chance to see the destination: a commit made
 * into a lease touches a different checkout and a different branch than the
 * conversation's own workspace, and the args alone carry nothing but an opaque
 * ULID. Resolved fields are optional because a stale/foreign id still deserves
 * to be shown (the tool call will fail, but the human should see what was
 * asked).
 */
export interface GitCommitTargetSnapshot {
  leaseId: string;
  label?: string | null;
  branch?: string | null;
  path?: string | null;
}

export interface GitCommitPreview {
  subject: string;
  paths: string[] | null;
  body: string | null;
  bodyLineCount: number;
  trailers: Array<{ token: string; value: string }>;
  targetSummary: string;
  /** The lease this commit lands in, or null for the conversation's workspace. */
  worktree: GitCommitTargetSnapshot | null;
  /** One-line description of the destination checkout, always present. */
  destinationSummary: string;
  /**
   * True when the request opts out of the conflict-marker guard. Surfaced
   * because it is the one argument that changes what "resolved" means: with it
   * set, a file that still contains `<<<<<<<` lines is committed as-is.
   */
  allowConflictMarkers: boolean;
}

export function gitCommitPreview(
  args: unknown,
  target?: GitCommitTargetSnapshot | null,
): GitCommitPreview | null {
  if (!isRecord(args)) return null;
  const subject =
    typeof args.subject === "string" && args.subject.length > 0
      ? args.subject
      : "(missing)";
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : null;
  const body =
    typeof args.body === "string" && args.body.length > 0 ? args.body : null;
  const trailers = gitCommitTrailers(args);
  // Only the canonical primitive string `'all'` means "every workspace change".
  // An array such as `['all']` is intentionally treated as an explicit path
  // list containing a single literal path named "all", not as the all-changes
  // sentinel. Exotic coercible objects (e.g. `{ toString() { return 'all' } }`)
  // are likewise NOT treated as the sentinel — the `===` comparison is strict.
  const isAllChanges = args.paths === "all";
  // Prefer the server-resolved snapshot, but never let a missing one hide the
  // fact that a worktree was requested: fall back to the raw arg, normalized
  // the same way the tool's schema normalizes it.
  const rawWorktree =
    typeof args.worktree === "string" ? args.worktree.trim() : "";
  const worktree =
    target ?? (rawWorktree.length > 0 ? { leaseId: rawWorktree } : null);
  return {
    subject,
    paths,
    body,
    bodyLineCount: body ? body.split(/\r\n|\r|\n/).length : 0,
    trailers,
    targetSummary: isAllChanges
      ? "All tracked, staged, unstaged, deleted, and untracked workspace changes" +
        // The tool narrows this while concluding a merge, and the dialog is
        // built from arguments alone (no repository read), so the caveat has
        // to be stated rather than detected.
        " (while concluding a merge: only the conflicted files’ resolutions)"
      : paths
        ? `${paths.length} selected ${paths.length === 1 ? "path" : "paths"}`
        : "Selected paths",
    worktree,
    destinationSummary: describeDestination(worktree),
    allowConflictMarkers: args.allowConflictMarkers === true,
  };
}

/**
 * One line naming the checkout a commit lands in.
 *
 * The path is deliberately NOT folded in: it is long enough to push the line
 * past the width of both the dialog and the audit list, and the dialog renders
 * it separately from the structured snapshot. Label + branch is what identifies
 * the destination.
 */
function describeDestination(target: GitCommitTargetSnapshot | null): string {
  if (!target) return "This conversation's workspace";
  const name = target.label
    ? `worktree ${target.label}`
    : `worktree ${target.leaseId}`;
  return target.branch ? `${name} on branch ${target.branch}` : name;
}

export function summarizeGitCommitPermission(
  args: unknown,
  target?: GitCommitTargetSnapshot | null,
): string | null {
  const preview = gitCommitPreview(args, target);
  if (!preview) return null;
  const lines = [
    "Create Git commit",
    `Subject: ${preview.subject === "(missing)" ? "commit" : preview.subject}`,
    `Destination: ${preview.destinationSummary}`,
  ];
  if (preview.paths) {
    lines.push(
      `Target: ${preview.paths.length} selected ${preview.paths.length === 1 ? "path" : "paths"}`,
    );
    for (const path of preview.paths.slice(0, 10)) lines.push(`- ${path}`);
    if (preview.paths.length > 10)
      lines.push(`- ...and ${preview.paths.length - 10} more`);
  } else {
    lines.push(`Target: ${preview.targetSummary}`);
  }
  if (preview.bodyLineCount > 0) {
    lines.push(
      `Body: ${preview.bodyLineCount} ${preview.bodyLineCount === 1 ? "line" : "lines"}`,
    );
  }
  if (preview.trailers.length > 0) {
    const tokens = preview.trailers
      .map((trailer) => trailer.token)
      .filter(Boolean);
    lines.push(
      `Trailers: ${preview.trailers.length}${tokens.length ? ` (${tokens.slice(0, 5).join(", ")}${tokens.length > 5 ? ", ..." : ""})` : ""}`,
    );
  }
  if (preview.allowConflictMarkers) {
    lines.push(
      "Conflict markers: allowed — files may still contain <<<<<<< / ======= / >>>>>>> lines.",
    );
  }
  lines.push(
    "Approval: one-time only; stored grants are disabled for git_commit.",
  );
  return lines.join("\n");
}

function gitCommitTrailers(
  args: Record<string, unknown>,
): Array<{ token: string; value: string }> {
  if (!Array.isArray(args.trailers)) return [];
  return args.trailers
    .filter(isRecord)
    .map((trailer) => ({
      token: String(trailer.token ?? ""),
      value: String(trailer.value ?? ""),
    }))
    .filter((trailer) => trailer.token.length > 0 && trailer.value.length > 0);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
