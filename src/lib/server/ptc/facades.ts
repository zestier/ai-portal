import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { ripgrep } from "ripgrep";
import { z } from "zod";
import { isolatedChildEnv } from "$lib/server/child-env";
import { runGitRaw } from "$lib/server/git/run";
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
import { trashInto } from "$lib/server/tools/filesystem/trash";

const PathArgs = z.object({ path: z.string().min(1).max(4096) }).strict();
const PermissionPathArgs = z.object({
  path: z.string().min(1).max(4096).optional(),
});
const ReaddirArgs = z
  .object({
    path: z.string().min(1).max(4096),
    withFileTypes: z.boolean().optional(),
  })
  .strict();
const RemoveArgs = z
  .object({
    path: z.string().min(1).max(4096),
    recursive: z.boolean().optional(),
    force: z.boolean().optional(),
    unlink: z.boolean().optional(),
  })
  .strict();
const GlobArgs = z
  .object({
    pattern: z.union([
      z.string().min(1).max(4096),
      z.array(z.string().min(1).max(4096)).min(1).max(100),
    ]),
    path: z.string().min(1).max(4096).optional(),
    maxDepth: z.number().int().min(0).max(100).optional(),
    includeIgnored: z.boolean().optional(),
  })
  .strict();
const GrepArgs = z
  .object({
    pattern: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096).optional(),
    glob: z
      .union([
        z.string().max(512),
        z.array(z.string().max(512)).min(1).max(100),
      ])
      .optional(),
    caseInsensitive: z.boolean().optional(),
    includeIgnored: z.boolean().optional(),
  })
  .strict();
const GitBlameArgs = z
  .object({
    path: z.string().min(1).max(4096),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(
    (args) =>
      args.endLine === undefined ||
      (args.startLine !== undefined && args.endLine >= args.startLine),
    { message: "endLine requires startLine; endLine >= startLine" },
  );
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
const MAX_GIT_BLAME_OUTPUT_BYTES = 64 * 1024;
const MAX_READDIR_ENTRIES = 1_000;

export function buildProgramFacadeTools(
  workspaceRoot: string,
  disabledToolGroups: readonly string[] = [],
): Map<string, PortalTool> {
  const disabled = new Set(disabledToolGroups);
  const tools = [
    ...(!disabled.has("filesystem")
      ? [
          buildGlobTool(workspaceRoot),
          buildGrepTool(workspaceRoot),
          buildReaddirTool(workspaceRoot),
          buildStatTool(workspaceRoot),
          buildRemoveTool(workspaceRoot),
        ]
      : []),
    ...(!disabled.has("git") ? [buildGitBlameTool(workspaceRoot)] : []),
    ...(!disabled.has("shell") ? [buildCommandRunTool(workspaceRoot)] : []),
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function buildGlobTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_fs_glob",
    description:
      "ripgrep-backed search.glob; preferred for repository path discovery.",
    parameters: jsonSchema(GlobArgs),
    argsSchema: GlobArgs,
    derivePermissionRequest: (raw) => readPermission(workspaceRoot, raw, "."),
    async handler(raw) {
      const parsed = GlobArgs.parse(raw);
      const target = resolveGrantedTarget(workspaceRoot, parsed.path ?? ".");
      if (!target.ok) return err(target.message);
      const commonArgs = ["--files", "--no-require-git"];
      if (parsed.maxDepth !== undefined) {
        commonArgs.push("--max-depth", String(parsed.maxDepth));
      }
      const eligibleArgs = [...commonArgs, "--hidden"];
      if (parsed.includeIgnored) eligibleArgs.push("--no-ignore");
      eligibleArgs.push(target.abs);

      const matchingArgs = [...commonArgs, "--no-ignore"];
      const patterns = Array.isArray(parsed.pattern)
        ? parsed.pattern
        : [parsed.pattern];
      for (const pattern of patterns) matchingArgs.push("--glob", pattern);
      matchingArgs.push(target.abs);
      try {
        const options = {
          buffer: true as const,
          nodeWasi: false,
          preopens: { ".": target.abs },
        };
        const [eligibleResult, matchingResult] = await Promise.all([
          ripgrep(eligibleArgs, options),
          ripgrep(matchingArgs, options),
        ]);
        for (const result of [eligibleResult, matchingResult]) {
          if (result.code !== 0 && result.code !== 1) {
            return err(result.stderr || result.stdout || "glob failed");
          }
        }
        const eligiblePaths = new Set(
          eligibleResult.stdout.split(/\r?\n/).filter(Boolean),
        );
        const paths = matchingResult.stdout
          .split(/\r?\n/)
          .filter((path) => path && eligiblePaths.has(path))
          .map((path) => relative(workspaceRoot, path).replaceAll("\\", "/"))
          .sort();
        return ok(paths);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function buildGrepTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_fs_grep",
    description:
      "ripgrep-backed search.grep; preferred for repository content discovery.",
    parameters: jsonSchema(GrepArgs),
    argsSchema: GrepArgs,
    derivePermissionRequest: (raw) => readPermission(workspaceRoot, raw, "."),
    async handler(raw) {
      const parsed = GrepArgs.parse(raw);
      const target = resolveGrantedTarget(workspaceRoot, parsed.path ?? ".");
      if (!target.ok) return err(target.message);
      const args = ["--json", "--no-require-git"];
      if (parsed.caseInsensitive) args.push("--ignore-case");
      if (parsed.includeIgnored) args.push("--no-ignore");
      const globs = Array.isArray(parsed.glob)
        ? parsed.glob
        : parsed.glob !== undefined
          ? [parsed.glob]
          : [];
      for (const glob of globs) args.push("--glob", glob);
      args.push("--glob", "!.git", "--glob", "!.git/**");
      args.push(parsed.pattern, target.abs);
      try {
        const result = await ripgrep(args, {
          buffer: true,
          nodeWasi: false,
          preopens: { ".": target.abs },
        });
        if (result.code !== 0 && result.code !== 1) {
          return err(result.stderr || result.stdout || "grep failed");
        }
        return ok(parseGrepMatches(workspaceRoot, result.stdout));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function parseGrepMatches(
  workspaceRoot: string,
  output: string,
): Array<{ path: string; line: number; column: number; text: string }> {
  const matches: Array<{
    path: string;
    line: number;
    column: number;
    text: string;
  }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const event = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start?: number }>;
      };
    };
    if (event.type !== "match" || !event.data) continue;
    const path = event.data.path?.text;
    const lineNumber = event.data.line_number;
    if (path === undefined || lineNumber === undefined) continue;
    matches.push({
      path: relative(workspaceRoot, path).replaceAll("\\", "/"),
      line: lineNumber,
      column: (event.data.submatches?.[0]?.start ?? 0) + 1,
      text: (event.data.lines?.text ?? "").replace(/\r?\n$/, ""),
    });
  }
  return matches;
}

function buildGitBlameTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_git_blame",
    description: "Audited bounded git.blame.",
    parameters: jsonSchema(GitBlameArgs),
    argsSchema: GitBlameArgs,
    derivePermissionRequest: (raw) => readPermission(workspaceRoot, raw),
    async handler(raw) {
      const { path, startLine, endLine } = GitBlameArgs.parse(raw);
      const target = resolveGrantedTarget(workspaceRoot, path);
      if (!target.ok) return err(target.message);
      const args = ["blame", "--line-porcelain"];
      if (startLine !== undefined) {
        args.push("-L", `${startLine},${endLine ?? startLine}`);
      }
      args.push("--", target.rel);
      const result = await runGitRaw(args, {
        cwd: workspaceRoot,
        maxBytes: MAX_GIT_BLAME_OUTPUT_BYTES,
      });
      if (result.code !== 0) return err(result.stderr || "git blame failed");
      if (result.truncated) {
        return err("git.blame: 64KB limit; request fewer lines.");
      }
      return ok(parseGitBlame(result.stdout));
    },
  };
}

function parseGitBlame(output: string): Array<Record<string, unknown>> {
  const lines = output.split("\n");
  const blamed: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  for (const line of lines) {
    const header = /^([0-9a-f^]{40})\s+\d+\s+(\d+)/.exec(line);
    if (header) {
      current = { sha: header[1]!.replace(/^\^/, ""), line: Number(header[2]) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("author ")) current.author = line.slice(7);
    else if (line.startsWith("author-mail ")) {
      current.email = line.slice(12).replace(/^<|>$/g, "");
    } else if (line.startsWith("author-time ")) {
      current.timestamp = Number(line.slice(12)) * 1000;
    } else if (line.startsWith("summary ")) current.summary = line.slice(8);
    else if (line.startsWith("\t")) {
      current.text = line.slice(1);
      blamed.push(current);
      current = null;
    }
  }
  return blamed;
}

function buildRemoveTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_fs_rm",
    description: "Audited reversible fs removal.",
    parameters: jsonSchema(RemoveArgs),
    argsSchema: RemoveArgs,
    derivePermissionRequest: (raw) => writePermission(workspaceRoot, raw),
    async handler(raw) {
      const { path, recursive, force, unlink } = RemoveArgs.parse(raw);
      const target = resolveGrantedTarget(workspaceRoot, path);
      if (!target.ok) return err(target.message);
      try {
        const value = await lstat(target.abs);
        if (value.isDirectory() && unlink) {
          return err("fs.unlink: directories unsupported.");
        }
        if (value.isDirectory() && !recursive) {
          return err("fs.rm directory: recursive: true required.");
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && force) return ok();
        return err(error instanceof Error ? error.message : String(error));
      }
      return trashInto(workspaceRoot, path);
    },
  };
}

function buildCommandRunTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_command_run",
    description: "Audited command.run.",
    parameters: jsonSchema(CommandArgs),
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
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(err(error.message)));
    child.on("close", (code) => {
      if (settled) return;
      if (timedOut)
        return finish(err(`Command timeout: ${command.timeoutMs}ms.`));
      if (aborted) return finish(err("Command aborted."));
      finish(ok({ status: code, stdout, stderr }));
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
        "command.run: one command, no shell operators. Use argv and JavaScript for pipelines.",
    };
  }
  const [executable, ...args] = parsed.segments[0].argv;
  if (!executable) return { ok: false, message: "command.run: empty command." };
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
    description: "Audited fs.readdir.",
    parameters: jsonSchema(ReaddirArgs),
    argsSchema: ReaddirArgs,
    derivePermissionRequest: (raw) => readPermission(workspaceRoot, raw),
    async handler(raw) {
      const { path, withFileTypes } = ReaddirArgs.parse(raw);
      const target = resolveGrantedTarget(workspaceRoot, path);
      if (!target.ok) return err(target.message);
      try {
        if (withFileTypes) {
          const entries = await readdir(target.abs, { withFileTypes: true });
          if (entries.length > MAX_READDIR_ENTRIES) {
            return err(
              `fs.readdir: ${entries.length} entries; limit ${MAX_READDIR_ENTRIES}. Use fs.glob with narrow pattern.`,
            );
          }
          return ok(
            entries
              .map((entry) => ({
                name: entry.name,
                file: entry.isFile(),
                directory: entry.isDirectory(),
                symbolicLink: entry.isSymbolicLink(),
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          );
        }
        const entries = await readdir(target.abs);
        if (entries.length > MAX_READDIR_ENTRIES) {
          return err(
            `fs.readdir: ${entries.length} entries; limit ${MAX_READDIR_ENTRIES}. Use fs.glob with narrow pattern.`,
          );
        }
        const names = entries.sort((left, right) => left.localeCompare(right));
        return ok(names);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function buildStatTool(workspaceRoot: string): PortalTool {
  return {
    name: "__ptc_fs_stat",
    description: "Audited fs.stat.",
    parameters: jsonSchema(PathArgs),
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

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const parameters = z.toJSONSchema(schema, { io: "input" });
  delete parameters.$schema;
  return parameters;
}

function readPermission(
  workspaceRoot: string,
  raw: unknown,
  defaultPath?: string,
): ToolPermissionRequest | null {
  const parsed = PermissionPathArgs.safeParse(raw);
  if (!parsed.success) return null;
  const rawPath = parsed.data.path ?? defaultPath;
  if (rawPath === undefined) return null;
  const path = resolveAbsoluteTarget(workspaceRoot, rawPath);
  return path ? { permissionKind: "read", path } : null;
}

function writePermission(
  workspaceRoot: string,
  raw: unknown,
): ToolPermissionRequest | null {
  const parsed = RemoveArgs.safeParse(raw);
  if (!parsed.success) return null;
  const path = resolveAbsoluteTarget(workspaceRoot, parsed.data.path);
  return path ? { permissionKind: "write", path } : null;
}
