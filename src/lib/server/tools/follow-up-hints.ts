// Single source of truth for the reserved `followUpHint` strings that tools set
// on a successful `ToolResult` envelope. Keeping them here (rather than inline in
// a tool handler) avoids coupling an unrelated tool's module to the domain it is
// nudging toward — e.g. the git wrapper does not author ticket-subsystem prose,
// it just opts into a named, shared hint.

// Set by `git_commit` on every successful commit: a nudge to actively
// reconcile workspace tickets (review open ones, update any this commit
// advanced). The text is intentionally tool-agnostic about *which* commit it
// followed.
export const COMMIT_TICKET_FOLLOW_UP_HINT =
  "Now reconcile workspace tickets: review the open ones with ticket_list and, for any that this commit completes or advances, update them with ticket_update.";

// Appended to `COMMIT_TICKET_FOLLOW_UP_HINT` when the commit landed in a linked
// worktree. Commits made there are invisible to the source checkout until they
// are merged back, which is the single easiest thing for an agent to forget at
// the end of a worktree session.
export const WORKTREE_INTEGRATE_FOLLOW_UP_HINT =
  'This commit landed on a linked worktree branch, so it is not yet in the source checkout. When the work is complete, integrate it with git_worktree_merge (direction "to-source"), passing `squash` with a subject if the branch\'s intermediate commits should land as one; use git_worktree_status first if you need the ahead/behind counts.';

// Set by `git_commit` when the commit was made INTO a lease this conversation
// holds (`worktree: <leaseId>`). The collecting call there is `worktree_merge`
// with that id — `git_worktree_merge` acts on the session's own workspace and
// would not touch the lease — so the hint names it explicitly.
export function leaseIntegrateFollowUpHint(leaseId: string): string {
  return (
    `This commit landed on worktree ${leaseId}'s branch, not in this conversation's workspace. ` +
    `Collect it with worktree_merge (leaseId: "${leaseId}"), adding \`squash\` with a subject to land the worktree's commits as one, then worktree_remove the worktree once you no longer need it.`
  );
}

/**
 * The recovery path out of a tree left mid-merge (by `onConflict: "keep"`, or by
 * a merge an agent started itself). Spelled out because the state is otherwise a
 * dead end: such a tree cannot be merged (it is dirty) and, until every conflict
 * is resolved, cannot be committed either — and shell `git` is not granted, so
 * `git add` / `git merge --continue` are not available to escape it by hand.
 *
 * `selector` is the `worktree: "<leaseId>"` fragment to repeat in the follow-up
 * calls, so a hint read inside a lease names the same tree it described.
 */
export function mergeInProgressFollowUpHint(
  leaseId?: string | undefined,
): string {
  const selector = leaseId ? `worktree: "${leaseId}", ` : "";
  return (
    "A merge is in progress in this tree. Resolve each conflicted file by editing it — keep the intended content and " +
    "delete the <<<<<<< / ======= / >>>>>>> lines — then conclude the merge with " +
    `git_commit { ${selector}paths: "all", subject: "<message>" }, which stages those resolutions (only the conflicted files) and creates the merge commit. ` +
    `To give up on the merge instead and return the tree to its pre-merge state, use git_merge_abort { ${leaseId ? `worktree: "${leaseId}"` : ""} }.`
  );
}

/**
 * Unmerged paths with no merge to abort — a conflicted `git stash pop`,
 * cherry-pick, or rebase. Committing the resolution is the only structured way
 * forward, and saying so is better than a hint that names `git_merge_abort`,
 * which would fail here.
 */
export function unmergedPathsFollowUpHint(
  leaseId?: string | undefined,
): string {
  const selector = leaseId ? `worktree: "${leaseId}", ` : "";
  return (
    "This tree has unmerged (conflicted) paths but no merge in progress, so git will refuse every commit until they are resolved. " +
    "Edit each conflicted file to keep the intended content and delete the <<<<<<< / ======= / >>>>>>> lines, then commit with " +
    `git_commit { ${selector}paths: "all", subject: "<message>" }. git_merge_abort does not apply here — there is no merge to roll back.`
  );
}

/**
 * A rebase / multi-step cherry-pick / revert is in flight. Committing clears the
 * CURRENT conflict but does not advance the sequencer, and the portal exposes no
 * `--continue` or `--abort` for one — so the hint says exactly that instead of
 * implying `git_commit` finishes the job. The portal never starts these
 * operations itself; a tree in one got there from outside.
 */
export function sequencerFollowUpHint(
  sequencer: "rebase" | "cherry-pick" | "revert",
  leaseId?: string | undefined,
): string {
  const selector = leaseId ? `worktree: "${leaseId}", ` : "";
  return (
    `This tree is in the middle of a ${sequencer}, which the portal did not start and has no structured tool to continue or abort. ` +
    `git_commit { ${selector}paths: "all", subject: "<message>" } commits the current conflict resolution, but it does NOT advance the ${sequencer}: ` +
    `any remaining steps still need \`git ${sequencer} --continue\` or \`--abort\`, which this portal does not expose. ` +
    "Report that rather than treating the operation as finished — a human has to drive the rest."
  );
}
