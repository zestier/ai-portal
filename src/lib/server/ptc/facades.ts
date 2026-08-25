import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { isolatedChildEnv } from "$lib/server/child-env";
import { parseShellCommand } from "$lib/server/permissions/shell-parser";
import {
  err,
  ok,
  type PortalTool,
  type ToolPermissionRequest,
} from "$lib/server/tools/types";
import {
  resolveAbsoluteTarget,
  resolveContainedTarget,
  resolveGrantedTarget,
} from "$lib/server/tools/filesystem/targets";

const PathArgs = z.object({ path: z.string().min(1).max(4096) }).strict();
const CommandOptions = {
  cwd: z.string().min(1).max(4096).optional(),
  stdin: z
    .string()
    .max(64 * 1024)
    .optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional().default(120_000),
};
const CommandArgs = z.union([
  z
    .object({
      executable: z.string().trim().min(1).max(4096),
      args: z.array(z.string().max(20_000)).max(256).optional().default([]),
      ...CommandOptions,
    })
    .strict(),
  z
    .object({
      command: z.string().trim().min(1).max(20_000),
      ...CommandOptions,
    })
    .strict(),
]);
interface NormalizedCommand {
  executable: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
}
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export function buildProgramFacadeTools(
  workspaceRoot: string,
): Map<string, PortalTool> {
  const tools = [
    buildReaddirTool(workspaceRoot),
    buildStatTool(workspaceRoot),
    buildCommandRunTool(workspaceRoot),
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function buildCommandRunTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_command_run",
    description: "Internal audited adapter for command.run.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        executable: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        stdin: { type: "string" },
        timeoutMs: { type: "number" },
      },
      oneOf: [{ required: ["command"] }, { required: ["executable"] }],
      additionalProperties: false,
    },
    argsSchema: CommandArgs,
    async handler(raw, ctx) {
      const parsed = CommandArgs.parse(raw);
      const normalized = normalizeCommand(parsed);
      const target = parsed.cwd
        ? resolveContainedTarget(workspaceRoot, parsed.cwd)
        : { ok: true as const, abs: workspaceRoot };
      if (!target.ok) return err(target.message);
      if (!normalized.ok) return err(normalized.message);
      return await runCommand(normalized.command, target.abs, ctx?.signal);
    },
  };
}

function runCommand(
  command: NormalizedCommand,
  cwd: string,
  signal?: AbortSignal,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  return new Promise((resolveResult) => {
    const child = spawn(command.executable, command.args, {
      cwd,
      env: isolatedChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (result: ReturnType<typeof ok> | ReturnType<typeof err>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(err("Command output exceeded the 64KB limit."));
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(err(error.message)));
    child.on("close", (code, childSignal) => {
      if (settled) return;
      if (timedOut)
        return finish(err(`Command timed out after ${command.timeoutMs}ms.`));
      if (aborted) return finish(err("Command aborted."));
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return finish(
          err(
            `Command exited with code ${code ?? "null"}${childSignal ? ` (${childSignal})` : ""}${detail ? `: ${detail}` : ""}`,
          ),
        );
      }
      finish(ok({ stdout, stderr }));
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    if (command.stdin !== undefined) child.stdin.end(command.stdin);
    else child.stdin.end();
  });
}

function normalizeCommand(
  command: z.infer<typeof CommandArgs>,
): { ok: true; command: NormalizedCommand } | { ok: false; message: string } {
  if ("executable" in command) {
    return {
      ok: true,
      command: {
        executable: command.executable,
        args: command.args,
        ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
        ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
        timeoutMs: command.timeoutMs,
      },
    };
  }
  const parsed = parseShellCommand(command.command);
  if (
    parsed.kind !== "parsed" ||
    parsed.segments.length !== 1 ||
    parsed.segments[0]?.followingOp !== null
  ) {
    return {
      ok: false,
      message:
        "command.run accepts one command line without shell operators; use argv and JavaScript composition for pipelines.",
    };
  }
  const [executable, ...args] = parsed.segments[0].argv;
  if (!executable)
    return { ok: false, message: "command.run command is empty." };
  return {
    ok: true,
    command: {
      executable,
      args,
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
      timeoutMs: command.timeoutMs,
    },
  };
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
      const target = resolveGrantedTarget(workspaceRoot, path);
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
      const target = resolveGrantedTarget(workspaceRoot, path);
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
