import { LeaseQuotaError, type Lease } from "../../leases";
import { WorktreeError } from "../../worktrees";
import { WorktreeIntegrationError } from "../../worktree-integration";
import { mergeInProgressFollowUpHint } from "../follow-up-hints";

// Model-relevant lease fields. Ids/timestamps stay recoverable via `fields`.
// `ahead` is in the compact view because it is the orchestrator's cue that a
// worktree has finished work waiting to be merged back, and `unavailable`
// because an absent count must not be mistaken for a zero one.
export const LEASE_KEEP = [
  "leaseId",
  "label",
  "path",
  "branch",
  "dirtyCount",
  "ahead",
  "unavailable",
] as const;

/**
 * Shape a lease + its live counts into the model-facing record.
 *
 * `unavailable: true` is set when the checkout could not be inspected. It
 * exists because counts are reported by ABSENCE rather than as zero: a bare row
 * with no `ahead` would otherwise read as "nothing to merge", and an agent
 * would move on having silently abandoned whatever was committed there. Present
 * only when something is wrong, so its mere presence is the signal.
 */
export function leaseView(
  lease: Lease,
  dirtyCount: number | null,
  counts?: { ahead: number; behind: number },
) {
  const unavailable = dirtyCount === null || counts === undefined;
  return {
    leaseId: String(lease.id),
    label: lease.label,
    path: lease.path,
    branch: lease.branch,
    baseSha: lease.baseSha,
    ...(dirtyCount === null ? {} : { dirtyCount }),
    ...(counts ? { ahead: counts.ahead, behind: counts.behind } : {}),
    ...(unavailable ? { unavailable: true } : {}),
    createdAt: lease.createdAt,
    lastUsedAt: lease.lastUsedAt,
  };
}

export function describeWorktreeError(
  cause: unknown,
): { message: string; code?: string; dirtyCount?: number } | null {
  if (cause instanceof LeaseQuotaError)
    return { message: cause.message, code: cause.code };
  if (cause instanceof WorktreeError)
    return { message: cause.message, code: cause.code };
  if (cause instanceof WorktreeIntegrationError) {
    return {
      message: cause.message,
      code: cause.code,
      ...(cause.detail?.dirtyCount === undefined
        ? {}
        : { dirtyCount: cause.detail.dirtyCount }),
    };
  }
  return null;
}

/**
 * Rewrite an integration failure into something the orchestrator can act on
 * without another round trip.
 *
 * `worktree_dirty` is the load-bearing one: uncommitted work in a lease is
 * unmergeable, and the whole point of the fan-out is that it gets collected. The
 * message therefore names the count AND the exact call that fixes it — a
 * sub-agent that never committed is the common cause, and `git_commit` with this
 * lease's id is the only sanctioned way to fix it (shell git is not granted).
 */
export function mergeErrorMessage(
  described: { message: string; code?: string; dirtyCount?: number },
  leaseId: string,
  kept: boolean,
): string {
  if (described.code === "not_fast_forwardable") {
    return `${described.message}. When collecting several worktrees, either sync this one with direction: "from-source" and retry with squash, or retry with allowMergeCommit: true.`;
  }
  if (described.code === "squash_behind_source") {
    return `${described.message}: worktree_merge { leaseId: "${leaseId}", direction: "from-source" } first, then retry this call unchanged.`;
  }
  if (described.code === "merge_conflict" && kept) {
    // Only a KEPT from-source conflict leaves state behind; every other
    // conflict has already been rolled back, and telling the agent to resolve
    // a tree that is no longer mid-merge would send it chasing nothing. The
    // calls that finish or discard the kept merge each need this lease's id,
    // so name them with it.
    return `${described.message}. ${mergeInProgressFollowUpHint(leaseId)}`;
  }
  if (described.code === "worktree_dirty") {
    const count = described.dirtyCount;
    return (
      `worktree ${leaseId} has ${count === undefined ? "" : `${count} `}uncommitted file(s); ` +
      `commit them before merging with git_commit { worktree: "${leaseId}", paths: "all", subject: "<message>" }, or discard them. ` +
      "Merging now would silently leave that work behind."
    );
  }
  return described.message;
}
