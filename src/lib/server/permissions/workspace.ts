// Workspace-containment check for permission scope keys.
//
// Under the default 'prompt' policy we auto-allow file-system permission
// kinds (`read`, `write`, `edit`) whose target path resolves *inside* the
// conversation's working directory. The check resolves symlinks via
// realpath on both the workspace root and the target so a symlink that
// escapes the workspace (e.g. `./escape -> /etc`) does not get silently
// approved.
//
// For paths that don't exist yet (the common `write` case — "create new
// file `src/foo.ts`") we walk up the path until we find an existing
// ancestor, realpath that, then re-append the unresolved tail and
// renormalize. This way a non-existent target inside a real-but-symlinked
// directory is judged against the link's true location.

import {
  isAbsolute,
  resolve,
  sep,
  relative,
  dirname,
  basename,
  normalize,
} from "node:path";
import { realpathSync } from "node:fs";

/**
 * Returns true if `target` resolves to a path equal to or inside
 * `workspaceRoot`, with symlinks resolved on both sides. Relative
 * `target` paths are resolved against `workspaceRoot`. Returns false on
 * empty inputs, paths containing a NUL byte, or any unexpected error
 * from realpath — callers fall back to prompting.
 */
export function isPathInWorkspace(
  target: string,
  workspaceRoot: string,
): boolean {
  if (!target || !workspaceRoot) return false;
  if (target.includes("\0") || workspaceRoot.includes("\0")) return false;

  const root = safeRealpath(resolve(workspaceRoot));
  if (root === null) return false;

  const absTarget = isAbsolute(target)
    ? resolve(target)
    : resolve(root, target);
  const resolvedTarget = resolveWithParentFallback(absTarget);
  if (resolvedTarget === null) return false;

  if (resolvedTarget === root) return true;
  const rel = relative(root, resolvedTarget);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false; // different drive on Windows
  // Defense in depth: `relative` returns a non-".."-prefixed string for
  // contained paths, but verify with an explicit prefix check to guard
  // against sibling-root false positives like `/work/repo-evil` vs
  // `/work/repo`.
  return resolvedTarget.startsWith(root + sep);
}

/**
 * True when `target` resolves inside ANY of `roots`.
 *
 * A conversation's writable area is a SET of roots — its own workspace plus
 * every worktree lease it holds — because an orchestrator hands leases to
 * parallel sub-agents. Containment is evaluated per-root with the same
 * symlink-safe check as the single-root case, so widening the set never
 * loosens the test applied to any individual root.
 *
 * An empty/missing set fails CLOSED (returns false → the caller prompts).
 * That matters: a conversation whose roots could not be resolved must not
 * silently gain blanket write access.
 */
export function isPathInAnyWorkspace(
  target: string,
  roots: readonly string[] | null | undefined,
): boolean {
  if (!roots || roots.length === 0) return false;
  return roots.some((root) => isPathInWorkspace(target, root));
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve `absPath` via realpath, walking up to the nearest existing
 * ancestor when the path itself doesn't exist. The unresolved tail is
 * re-appended and renormalized so callers see a fully-resolved absolute
 * path. Returns null if no ancestor up to the filesystem root exists
 * (shouldn't happen in practice) or on unexpected errors.
 *
 * Exported so predicates that mirror the workspace check (e.g. the fs
 * `prefix` rule) can resolve arbitrary paths the same way.
 */
export function resolveWithParentFallback(absPath: string): string | null {
  const direct = safeRealpath(absPath);
  if (direct !== null) return direct;

  const unresolved: string[] = [];
  let current = absPath;
  // Cap iterations to avoid pathological loops (`relative` paths or
  // symlink cycles in dirname() shouldn't lead here, but be safe).
  for (let i = 0; i < 4096; i++) {
    const parent = dirname(current);
    if (parent === current) return null; // hit the root without finding anything
    unresolved.unshift(basename(current));
    const resolvedParent = safeRealpath(parent);
    if (resolvedParent !== null) {
      return normalize(resolve(resolvedParent, ...unresolved));
    }
    current = parent;
  }
  return null;
}
