import { z } from "zod";
import {
  err,
  ok,
  type PortalTool,
  type ProgramToolMetadata,
  type ToolResult,
} from "$lib/server/tools/types";

const FIND_RESULT = {
  type: "object",
  properties: {
    paths: { type: "array", items: { type: "string" } },
    truncated: { type: "boolean" },
  },
  required: ["paths", "truncated"],
  additionalProperties: false,
} as const;

const GREP_RESULT = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          column: { type: ["integer", "null"] },
          text: { type: "string" },
        },
        required: ["path", "line", "column", "text"],
        additionalProperties: false,
      },
    },
    truncated: { type: "boolean" },
  },
  required: ["matches", "truncated"],
  additionalProperties: false,
} as const;

const GIT_STATUS_RESULT = {
  type: "object",
  properties: {
    head: {
      type: "object",
      properties: {
        branch: { type: ["string", "null"] },
        sha: { type: ["string", "null"] },
        detached: { type: "boolean" },
        upstream: { type: ["string", "null"] },
        ahead: { type: "integer" },
        behind: { type: "integer" },
      },
      required: ["branch", "sha", "detached", "upstream", "ahead", "behind"],
      additionalProperties: false,
    },
    merge: {
      type: "object",
      properties: {
        inProgress: { type: "boolean" },
        conflicts: { type: "array", items: { type: "string" } },
        operation: {
          type: ["string", "null"],
          enum: ["rebase", "cherry-pick", "revert", null],
        },
      },
      required: ["inProgress", "conflicts", "operation"],
      additionalProperties: false,
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          previousPath: { type: ["string", "null"] },
          index: { type: "string" },
          worktree: { type: "string" },
        },
        required: ["path", "previousPath", "index", "worktree"],
        additionalProperties: false,
      },
    },
  },
  required: ["head", "merge", "changes"],
  additionalProperties: false,
} as const;

const GIT_DIFF_RESULT = {
  type: "object",
  properties: {
    patch: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          previousPath: { type: ["string", "null"] },
          status: { type: "string" },
          added: { type: ["integer", "null"] },
          removed: { type: ["integer", "null"] },
          binary: { type: "boolean" },
        },
        required: [
          "path",
          "previousPath",
          "status",
          "added",
          "removed",
          "binary",
        ],
        additionalProperties: false,
      },
    },
    truncated: { type: "boolean" },
  },
  required: ["patch", "files", "truncated"],
  additionalProperties: false,
} as const;

const FindProgramArgs = z
  .object({
    pattern: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096).optional(),
  })
  .strict();

const GrepProgramArgs = z
  .object({
    pattern: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096).optional(),
    glob: z.string().max(512).optional(),
    caseInsensitive: z.boolean().optional(),
  })
  .strict();

const GitStatusProgramArgs = z.object({}).strict();
const GitDiffProgramArgs = z
  .object({
    target: z
      .enum([
        "worktree-vs-head",
        "worktree-vs-index",
        "index-vs-head",
        "commit",
        "commit-vs-parent",
      ])
      .optional(),
    sha: z.string().min(4).max(64).optional(),
    path: z.string().min(1).max(4096).optional(),
  })
  .strict();

const PROGRAM_METADATA: Readonly<Record<string, ProgramToolMetadata>> = {
  find: metadata(
    "find workspace paths by glob",
    FIND_RESULT,
    'tools.find({ pattern: "**/*.test.ts", path: "tests" })',
    normalizeAliases({ pattern: ["query"], path: ["cwd"] }),
    {
      parameters: objectParameters(
        {
          pattern: { type: "string" },
          path: { type: "string" },
        },
        ["pattern"],
      ),
      argsSchema: FindProgramArgs,
      permissionArgs: findDirectArgs,
      invoke: invokeFind,
    },
  ),
  grep: metadata(
    "search workspace file contents",
    GREP_RESULT,
    'tools.grep({ pattern: "ProgramArgs", path: "src", glob: "*.ts" })',
    normalizeAliases({
      pattern: ["query", "regex"],
      path: ["cwd"],
      glob: ["include"],
    }),
    {
      parameters: objectParameters(
        {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          caseInsensitive: { type: "boolean" },
        },
        ["pattern"],
      ),
      argsSchema: GrepProgramArgs,
      permissionArgs: grepDirectArgs,
      invoke: invokeGrep,
    },
  ),
  git_status: metadata(
    "inspect repository working-tree status",
    GIT_STATUS_RESULT,
    "tools.git_status({})",
    undefined,
    {
      parameters: objectParameters({}, []),
      argsSchema: GitStatusProgramArgs,
      invoke: invokeGitStatus,
    },
  ),
  git_diff: metadata(
    "inspect repository changes",
    GIT_DIFF_RESULT,
    'tools.git_diff({ target: "worktree-vs-head" })',
    undefined,
    {
      parameters: objectParameters(
        {
          target: { type: "string" },
          sha: { type: "string" },
          path: { type: "string" },
        },
        [],
      ),
      argsSchema: GitDiffProgramArgs,
      invoke: invokeGitDiff,
    },
  ),
};

export function attachProgramMetadata(tool: PortalTool): PortalTool {
  const program = PROGRAM_METADATA[tool.name];
  return program ? { ...tool, program } : tool;
}

export function programCapabilities(
  capabilities: ReadonlyMap<string, PortalTool>,
): Map<string, PortalTool> {
  const selected = new Map<string, PortalTool>();
  for (const [name, tool] of capabilities) {
    if (!tool.program) continue;
    const program = tool.program;
    const normalize = program.normalizeArgs;
    selected.set(name, {
      ...tool,
      parameters: program.parameters ?? tool.parameters,
      ...(program.argsSchema
        ? { argsSchema: program.argsSchema }
        : tool.argsSchema
          ? { argsSchema: tool.argsSchema }
          : {}),
      ...(tool.derivePermissionRequest
        ? {
            derivePermissionRequest: (args: unknown) =>
              tool.derivePermissionRequest!(
                program.permissionArgs
                  ? program.permissionArgs(args)
                  : normalize
                    ? normalize(args)
                    : args,
              ),
          }
        : {}),
      handler: (args, ctx) =>
        program.invoke
          ? program.invoke(tool, args, ctx)
          : tool.handler(normalize ? normalize(args) : args, ctx),
    });
  }
  return selected;
}

export function programCatalog(
  capabilities: ReadonlyMap<string, PortalTool>,
): string {
  return [...programCapabilities(capabilities).values()]
    .map((tool) => `${tool.name} - ${tool.program!.catalogDescription}`)
    .join("; ");
}

export function programToolContracts(
  capabilities: ReadonlyMap<string, PortalTool>,
  names: readonly string[],
): Array<Record<string, unknown>> {
  const available = programCapabilities(capabilities);
  const unique = [...new Set(names)];
  return unique.map((name) => {
    const tool = available.get(name);
    if (!tool?.program) {
      return {
        name,
        error: "unknown program tool",
        suggestions: suggestionsFor(name, [...available.keys()]),
      };
    }
    return {
      name,
      description: tool.description,
      parameters: tool.program.parameters ?? tool.parameters,
      result: tool.program.resultSchema,
      example: tool.program.example,
      contractVersion: tool.program.contractVersion,
    };
  });
}

export function normalizeProgramToolArgs(
  tool: PortalTool,
  args: unknown,
): unknown {
  return tool.program?.normalizeArgs ? tool.program.normalizeArgs(args) : args;
}

export function suggestionsFor(
  name: string,
  available: readonly string[],
): string[] {
  return available
    .map((candidate) => ({
      candidate,
      score: editDistance(name, candidate),
    }))
    .filter(({ score }) => score <= Math.max(3, Math.floor(name.length / 2)))
    .sort((left, right) =>
      left.score === right.score
        ? left.candidate.localeCompare(right.candidate)
        : left.score - right.score,
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function metadata(
  catalogDescription: string,
  resultSchema: Record<string, unknown>,
  example: string,
  normalizeArgs?: (args: unknown) => unknown,
  extra: Pick<
    ProgramToolMetadata,
    "parameters" | "argsSchema" | "permissionArgs" | "invoke"
  > = {},
): ProgramToolMetadata {
  return {
    catalogDescription,
    operationCategory: "read",
    resultSchema,
    example,
    contractVersion: "1",
    ...(normalizeArgs ? { normalizeArgs } : {}),
    ...extra,
  };
}

async function invokeFind(
  tool: PortalTool,
  args: unknown,
): Promise<ToolResult> {
  const parsed = FindProgramArgs.parse(args);
  const result = await tool.handler(findDirectArgs(parsed));
  if (!result.ok) return result;
  const value = asRecord(result.result);
  const text = typeof value.text === "string" ? value.text : "";
  const lines = text.split(/\r?\n/).filter(Boolean);
  const truncated = lines.some((line) =>
    line.includes("results limit reached"),
  );
  const paths = lines.filter(
    (line) =>
      line !== "No files found matching pattern" &&
      !line.includes("results limit reached"),
  );
  return ok({ paths, truncated });
}

async function invokeGrep(
  tool: PortalTool,
  args: unknown,
): Promise<ToolResult> {
  const parsed = GrepProgramArgs.parse(args);
  const result = await tool.handler(grepDirectArgs(parsed));
  if (!result.ok) return result;
  const value = asRecord(result.result);
  const content = typeof value.content === "string" ? value.content : "";
  const matches = content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(.*):(\d+):(.*)$/.exec(line);
      if (!match) throw new Error(`Unexpected grep result line: ${line}`);
      return {
        path: match[1],
        line: Number.parseInt(match[2], 10),
        column: null,
        text: match[3],
      };
    });
  return ok({ matches, truncated: value.truncated === true });
}

function findDirectArgs(args: unknown): Record<string, unknown> {
  const parsed = FindProgramArgs.parse(args);
  return { ...parsed, limit: 10_000 };
}

function grepDirectArgs(args: unknown): Record<string, unknown> {
  const parsed = GrepProgramArgs.parse(args);
  return {
    pattern: parsed.pattern,
    ...(parsed.path !== undefined ? { path: parsed.path } : {}),
    ...(parsed.glob !== undefined ? { glob: parsed.glob } : {}),
    output_mode: "content",
    head_limit: 0,
    "-n": true,
    "-i": parsed.caseInsensitive ?? false,
  };
}

async function invokeGitStatus(
  tool: PortalTool,
  args: unknown,
): Promise<ToolResult> {
  GitStatusProgramArgs.parse(args);
  const result = await tool.handler({});
  if (!result.ok) return result;
  const value = asRecord(result.result);
  if (value.initialized === false) return err("Not a Git repository.");
  const head = asRecord(value.head);
  const merge = asRecord(value.merge);
  return ok({
    head: {
      branch: head.branch ?? null,
      sha: head.sha ?? null,
      detached: head.detached === true,
      upstream: head.upstream ?? null,
      ahead: numberOrZero(head.ahead),
      behind: numberOrZero(head.behind),
    },
    merge: {
      inProgress: merge.inProgress === true,
      conflicts: Array.isArray(merge.conflictedPaths)
        ? merge.conflictedPaths
        : [],
      operation: merge.sequencer ?? null,
    },
    changes: Array.isArray(value.changes)
      ? value.changes.map((entry) => {
          const change = asRecord(entry);
          return {
            path: change.path,
            previousPath: change.origPath ?? null,
            index: change.index,
            worktree: change.worktree,
          };
        })
      : [],
  });
}

async function invokeGitDiff(
  tool: PortalTool,
  args: unknown,
): Promise<ToolResult> {
  const parsed = GitDiffProgramArgs.parse(args);
  const base = {
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
    ...(parsed.sha !== undefined ? { sha: parsed.sha } : {}),
    ...(parsed.path !== undefined ? { path: parsed.path } : {}),
  };
  const [patchResult, statsResult, namesResult] = await Promise.all([
    tool.handler({ ...base, output: "patch" }),
    tool.handler({ ...base, output: "numstat" }),
    tool.handler({ ...base, output: "name-status" }),
  ]);
  if (!patchResult.ok) return patchResult;
  if (!statsResult.ok) return statsResult;
  if (!namesResult.ok) return namesResult;
  const stats = asRecord(statsResult.result);
  const names = asRecord(namesResult.result);
  const statsByPath = new Map(
    (Array.isArray(stats.files) ? stats.files : []).map((entry) => {
      const file = asRecord(entry);
      return [String(file.path), file] as const;
    }),
  );
  const files = (Array.isArray(names.files) ? names.files : []).map((entry) => {
    const file = asRecord(entry);
    const stat = statsByPath.get(String(file.path)) ?? {};
    return {
      path: file.path,
      previousPath: file.origPath ?? null,
      status: file.status,
      added: stat.added ?? null,
      removed: stat.removed ?? null,
      binary: stat.added === null || stat.removed === null,
    };
  });
  return ok({
    patch: patchResult.result === "(no diff)" ? "" : patchResult.result,
    files,
    truncated: false,
  });
}

function objectParameters(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function normalizeAliases(
  aliases: Readonly<Record<string, readonly string[]>>,
): (args: unknown) => unknown {
  return (args) => {
    if (!isRecord(args)) return args;
    const normalized = { ...args };
    for (const [canonical, alternatives] of Object.entries(aliases)) {
      const supplied = [canonical, ...alternatives].filter(
        (name) => normalized[name] !== undefined,
      );
      if (supplied.length > 1) {
        throw new Error(
          `Ambiguous program arguments: use only "${canonical}". Call get_program_tool_schemas for the canonical contract.`,
        );
      }
      const alias = alternatives.find((name) => normalized[name] !== undefined);
      if (alias) {
        normalized[canonical] = normalized[alias];
        delete normalized[alias];
      }
    }
    return normalized;
  };
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
