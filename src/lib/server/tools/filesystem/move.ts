import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  WORKTREE_WRITE_PARAM,
  WorktreeSelector,
  type WorktreeToolContext,
} from "../worktree-selector";
import { err, ok, type PortalTool, type ToolPermissionRequest } from "../types";
import {
  buildFilesystemCtx,
  resolveMoveTargets,
  resolveWorkspaceTarget,
} from "./targets";

export const MoveArgs = z
  .object({
    source: z.string().min(1).max(4096),
    destination: z.string().min(1).max(4096),
    overwrite: z.boolean().optional(),
    worktree: WorktreeSelector,
  })
  .strict();

export function buildMoveTools(
  workspaceRoot: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const { treeFor, permissionRoot } = buildFilesystemCtx(workspaceRoot, ctx);
  return [
    {
      name: "move",
      description: "Move (rename) a file or directory within the workspace.",
      promptGuidelines: [
        "Refuses to overwrite an existing destination unless `overwrite`; never overwrites a directory.",
        "A move touching anything outside the workspace is gated on BOTH source and destination paths and prompts.",
      ],
      argsSchema: MoveArgs,
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source path.",
          },
          destination: {
            type: "string",
            description: "Destination path.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Replace an existing destination file when true. Default false.",
          },
          worktree: WORKTREE_WRITE_PARAM,
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
      derivePermissionRequest(args): ToolPermissionRequest | null {
        const parsed = MoveArgs.safeParse(args);
        if (!parsed.success) return null;
        const root = permissionRoot(parsed.data.worktree);
        if (root === null) return null;
        const targets = resolveMoveTargets(
          root,
          parsed.data.source,
          parsed.data.destination,
        );
        if (targets === null) return null;
        // Gate on BOTH paths: the gateway evaluates source + destination
        // against the real grants and combines most-restrictively.
        return {
          permissionKind: "write",
          path: targets.source,
          additionalPaths: [targets.destination],
        };
      },
      async handler(args) {
        const { source, destination, overwrite, worktree } =
          MoveArgs.parse(args);
        const tree = treeFor(worktree);
        if (tree.error) return tree.error;
        const src = resolveWorkspaceTarget(tree.cwd, source);
        if (!src.ok) return err(`source: ${src.message}`);
        const dst = resolveWorkspaceTarget(tree.cwd, destination);
        if (!dst.ok) return err(`destination: ${dst.message}`);
        if (src.abs === dst.abs) {
          return err("source and destination resolve to the same path");
        }
        try {
          const srcStat = await stat(src.abs).catch(() => null);
          if (!srcStat) return err(`source does not exist: ${src.rel}`);
          const dstStat = await stat(dst.abs).catch(() => null);
          if (dstStat) {
            if (dstStat.isDirectory()) {
              return err(`destination is an existing directory: ${dst.rel}`);
            }
            if (!overwrite) {
              return err(
                `destination already exists (pass overwrite to replace): ${dst.rel}`,
              );
            }
          }
          await mkdir(dirname(dst.abs), { recursive: true });
          await rename(src.abs, dst.abs);
          return ok(
            {
              source: src.rel,
              destination: dst.rel,
              overwritten: Boolean(dstStat),
            },
            `Moved ${src.rel} -> ${dst.rel}`,
          );
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
