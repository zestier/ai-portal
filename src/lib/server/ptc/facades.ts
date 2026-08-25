import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  err,
  ok,
  type PortalTool,
  type ToolPermissionRequest,
} from "$lib/server/tools/types";
import {
  resolveAbsoluteTarget,
  resolveWorkspaceTarget,
} from "$lib/server/tools/filesystem/targets";

const PathArgs = z.object({ path: z.string().min(1).max(4096) }).strict();

export function buildProgramFacadeTools(
  workspaceRoot: string,
): Map<string, PortalTool> {
  const tools = [buildReaddirTool(workspaceRoot), buildStatTool(workspaceRoot)];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function buildReaddirTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_fs_readdir",
    description: "Internal audited adapter for fs.readdir.",
    parameters: pathParameters(),
    argsSchema: PathArgs,
    derivePermissionRequest: (raw) => readPermission(workspaceRoot, raw),
    async handler(raw) {
      const { path } = PathArgs.parse(raw);
      const target = resolveWorkspaceTarget(workspaceRoot, path);
      if (!target.ok) return err(target.message);
      try {
        const entries = (await readdir(target.abs)).sort((left, right) =>
          left.localeCompare(right),
        );
        return ok(entries);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function buildStatTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_fs_stat",
    description: "Internal audited adapter for fs.stat.",
    parameters: pathParameters(),
    argsSchema: PathArgs,
    derivePermissionRequest: (raw) => readPermission(workspaceRoot, raw),
    async handler(raw) {
      const { path } = PathArgs.parse(raw);
      const target = resolveWorkspaceTarget(workspaceRoot, path);
      if (!target.ok) return err(target.message);
      try {
        // Validate the real target for containment, then lstat the lexical path
        // so the compatibility facade can preserve isSymbolicLink().
        const value = await lstat(resolve(workspaceRoot, path));
        return ok({
          size: value.size,
          mtimeMs: value.mtimeMs,
          file: value.isFile(),
          directory: value.isDirectory(),
          symbolicLink: value.isSymbolicLink(),
        });
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function pathParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };
}

function readPermission(
  workspaceRoot: string,
  raw: unknown,
): ToolPermissionRequest | null {
  const parsed = PathArgs.safeParse(raw);
  if (!parsed.success) return null;
  const path = resolveAbsoluteTarget(workspaceRoot, parsed.data.path);
  return path ? { permissionKind: "read", path } : null;
}
