import { isAbsolute, relative, resolve } from "node:path";
import {
  isPathInWorkspace,
  resolveWithParentFallback,
} from "../../permissions/workspace";
import { scratchSubdir } from "../zap-dir";
import {
  createTreeResolver,
  resolveWorktreeDir,
  type TreeSelection,
  type WorktreeToolContext,
} from "../worktree-selector";

// Workspace-relative directory the `trash` tool moves deleted entries into.
// Keeping it inside the workspace is deliberate: the move that performs the
// "delete" is itself an in-workspace write, so it is covered by the standard
// fs-write seed (delete ⊆ write on the same path) and stays reversible. It
// lives under the portal's `.zap/scratch` area (see ./zap-dir) so a project
// ignores one nested rule rather than a dot-dir per tool.
//
// Resolved lazily (per call, via `scratchSubdir`) rather than captured at
// import time so a `ZAP_DIR` override stays consistent with
// `ensureZapGitignore`, which also reads the env when invoked.
export function trashDir(): string {
  return scratchSubdir("trash");
}

type ResolvedTarget =
  { ok: true; abs: string; rel: string } | { ok: false; message: string };

// Resolve a workspace-relative directory request into an absolute, symlink-
// resolved path that is provably inside the workspace. Rejects absolute inputs
// and any `..` escape that resolves outside the root (resolving the real path of
// existing ancestors first, so a symlinked parent can't be used to escape).
export function resolveWorkspaceTarget(
  workspaceRoot: string,
  rawPath: string,
): ResolvedTarget {
  if (rawPath.includes("\0")) {
    return { ok: false, message: "path must not contain NUL characters" };
  }
  if (isAbsolute(rawPath)) {
    return {
      ok: false,
      message: `path must be workspace-relative, not absolute: ${rawPath}`,
    };
  }
  const root = resolveWithParentFallback(resolve(workspaceRoot));
  if (root === null) {
    return { ok: false, message: "could not resolve the workspace root" };
  }
  const abs = resolveWithParentFallback(resolve(root, rawPath));
  if (abs === null) {
    return { ok: false, message: `could not resolve path: ${rawPath}` };
  }
  if (!isPathInWorkspace(abs, root)) {
    return { ok: false, message: `path escapes the workspace: ${rawPath}` };
  }
  const rel = abs === root ? "." : relative(root, abs);
  return { ok: true, abs, rel };
}

// Best-effort absolute target for the permission request. Unlike
// `resolveWorkspaceTarget` it does NOT enforce containment: an out-of-workspace
// path is resolved and returned so the permission layer sees the real target
// and prompts (it won't match the in-workspace fs-write seed) instead of
// silently auto-approving.
export function resolveAbsoluteTarget(
  workspaceRoot: string,
  rawPath: string,
): string | null {
  if (!rawPath || rawPath.includes("\0")) return null;
  const root = resolveWithParentFallback(resolve(workspaceRoot));
  if (root === null) return null;
  const base = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
  return resolveWithParentFallback(base);
}

// A `move` is a two-path operation, so it must be gated on BOTH the source and
// the destination. Resolve each to an absolute, symlink-aware path (without
// enforcing containment — the handler does that) so the permission layer can
// evaluate BOTH against the user's real grants + policy and combine
// most-restrictively. Returns null when either path can't be resolved so the
// gateway falls back to its default custom-tool request.
export function resolveMoveTargets(
  workspaceRoot: string,
  source: string,
  destination: string,
): { source: string; destination: string } | null {
  const src = resolveAbsoluteTarget(workspaceRoot, source);
  const dst = resolveAbsoluteTarget(workspaceRoot, destination);
  if (src === null || dst === null) return null;
  return { source: src, destination: dst };
}

// Classifies how `rel` relates to the trash store so the trash tool can refuse
// to bury or resurface its own state. Two distinct protections:
//   - 'inside': `rel` is the store itself or nested within it. Trashing it would
//     let an agent recursively bury, or resurface, previously deleted entries.
//   - 'ancestor': `rel` is a parent of the store (e.g. `.zap`, `.zap/scratch`).
//     Trashing it would drag the whole store along — and `rename` would anyway
//     fail trying to move a directory into its own descendant.
export function trashRelation(
  rel: string,
  dir: string,
): "inside" | "ancestor" | null {
  if (rel === dir || rel.startsWith(`${dir}/`)) return "inside";
  if (dir.startsWith(`${rel}/`)) return "ancestor";
  return null;
}

// Shared per-build context for the three directory-scoped filesystem tools.
// Each builder resolves a `worktree` selector to the root every path in the call
// is relative to — no selector means this conversation's own workspace. Without
// it these tools could only ever act in the conversation's workspace, which
// left a sub-agent working in a lease unable to mkdir, move, or delete at all:
// paths here are workspace-relative by design, and shell
// `mkdir`/`mv`/`rm` are not a fallback (this portal does not seed them).
export interface FilesystemToolCtx {
  treeFor: (leaseId: string | undefined) => TreeSelection;
  permissionRoot: (leaseId: string | undefined) => string | null;
}

export function buildFilesystemCtx(
  workspaceRoot: string,
  ctx?: WorktreeToolContext,
): FilesystemToolCtx {
  const treeFor = createTreeResolver(workspaceRoot, ctx);

  // The permission-side twin of `treeFor`. `derivePermissionRequest` must not
  // mutate anything (no `touchLease`) and cannot return an error envelope, so
  // an unresolvable selector yields null — the gateway then falls back to its
  // default custom-tool request and PROMPTS. That is the fail-closed direction:
  // deriving against `workspaceRoot` instead would describe a path the handler
  // will never touch, and could be auto-approved by the workspace fs-write seed
  // while the real write lands elsewhere.
  //
  // A resolved lease root needs no special seed: `workspaceRootsFor` already
  // includes every lease a conversation holds, so the standard fs-write seed
  // covers it exactly as it covers the primary workspace.
  function permissionRoot(leaseId: string | undefined): string | null {
    if (!leaseId) return workspaceRoot;
    return resolveWorktreeDir(leaseId, ctx);
  }

  return { treeFor, permissionRoot };
}
