import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { loadConfig } from "./config";
import {
  slotPath,
  type ManagedWorktreeMetadata,
  type WorktreeSlot,
} from "./worktrees";
import {
  resolveConversationWorkspace,
  WorkspaceUnavailableError,
} from "./workdir";
import * as leaseRepo from "./db/repos/leases";
import type { LeaseRow } from "./db/repos/leases";
import * as convs from "./db/repos/conversations";
import { conversationId as convCodec, leaseId as leaseCodec } from "$lib/ids";
import type { Conversation } from "$lib/types";

/** The metadata shape the shared worktree helpers operate on. */
export function toMetadata(lease: LeaseRow): ManagedWorktreeMetadata {
  return {
    sourceWorkdir: lease.sourceWorkdir,
    path: lease.path,
    gitCommonDir: lease.gitCommonDir,
    branch: lease.branch,
    baseSha: lease.baseSha,
  };
}

export function leaseSlot(
  lease: Pick<LeaseRow, "userId" | "id">,
): WorktreeSlot {
  return {
    kind: "lease",
    userId: String(lease.userId),
    leaseId: String(leaseCodec.parse(lease.id)),
  };
}

/**
 * The tree a conversation's leases are cut from and merge back into.
 *
 * This is the conversation's OWN workspace, including when that is a managed
 * worktree. Sub-agents working in parallel leases are working on sub-tasks of
 * whatever the conversation is doing, so they must start from its current state
 * and their results must gather back into its branch — to be reviewed and
 * tested together before any of it reaches the shared checkout.
 *
 * (An earlier version cut leases from the source repository instead, on the
 * theory that branching from a disposable checkout would tie the lease's
 * lifetime to it. That was wrong on the mechanism: git worktrees are flat
 * siblings sharing one common dir, so removing one does not affect another.
 * Registering in the same repository does not require branching from the same
 * commit — and branching from main meant sub-agents could not see the
 * orchestrator's in-progress work.)
 */
export function leaseCounterpartWorkspace(conversation: Conversation): string {
  return resolveConversationWorkspace(conversation);
}

/**
 * Resolve a lease's checkout to a path safe to hand to tools and file reads.
 *
 * Deliberately parallel to `resolveConversationWorkspace`: the stored path must
 * equal the path re-derived from ids, must exist, must be a real directory, and
 * must resolve strictly inside WORKTREE_ROOT. Any deviation throws rather than
 * degrading to a fallback root.
 */
export function resolveLeaseWorkspace(lease: LeaseRow): string {
  const expected = resolve(slotPath(leaseSlot(lease)));
  const stored = resolve(lease.path);
  if (stored !== expected || !existsSync(stored)) {
    throw new WorkspaceUnavailableError("lease worktree path is unavailable");
  }
  try {
    const rootReal = realpathSync(resolve(loadConfig().WORKTREE_ROOT));
    const storedReal = realpathSync(stored);
    const expectedReal = resolve(
      rootReal,
      String(lease.userId),
      "leases",
      String(leaseCodec.parse(lease.id)),
    );
    if (
      !statSync(stored).isDirectory() ||
      storedReal !== expectedReal ||
      storedReal === rootReal ||
      !storedReal.startsWith(rootReal + sep)
    ) {
      throw new WorkspaceUnavailableError("lease worktree path is invalid");
    }
    return storedReal;
  } catch (error) {
    if (error instanceof WorkspaceUnavailableError) throw error;
    throw new WorkspaceUnavailableError(
      "lease worktree path is not accessible",
    );
  }
}

/**
 * The set of filesystem roots a conversation's agent may write inside without
 * prompting: its own workspace plus every lease it holds.
 *
 * A lease that fails to resolve is SKIPPED rather than fatal — one broken
 * checkout must not lock the user out of their primary workspace. The primary
 * is always first so callers can treat `[0]` as the main workspace.
 */
export function conversationWorkspaceRoots(
  conversation: Conversation,
): string[] {
  const roots: string[] = [];
  try {
    roots.push(resolveConversationWorkspace(conversation));
  } catch {
    // A conversation whose own workspace is unavailable still fails closed at
    // the point of use; here we simply contribute no root for it.
  }
  for (const lease of leaseRepo.listByConversation(
    convCodec.parse(conversation.id),
    conversation.userId,
  )) {
    if (lease.state !== "active") continue;
    try {
      roots.push(resolveLeaseWorkspace(lease));
    } catch {
      continue;
    }
  }
  return [...new Set(roots)];
}

/**
 * Live containment roots for a conversation id, for the provider permission
 * adapters. Falls back to `fallback` (the session's working directory) when the
 * conversation row can't be read or contributes no roots, so permission
 * behavior is never *narrower* than it was before leases existed.
 *
 * Called per permission request rather than cached: a lease created mid-turn
 * must be writable within that same turn.
 */
export function workspaceRootsFor(
  conversationId: string | number,
  userId: number,
  fallback: string,
): string[] {
  try {
    const intConv =
      typeof conversationId === "number"
        ? conversationId
        : convCodec.parse(conversationId);
    const conversation = convs.get(intConv, userId);
    if (!conversation) return [fallback];
    const roots = conversationWorkspaceRoots(conversation);
    return roots.length > 0 ? roots : [fallback];
  } catch {
    return [fallback];
  }
}
