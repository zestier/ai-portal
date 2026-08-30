import { z } from "zod";
import {
  CommitBody,
  CommitSubject,
  CommitTrailers,
  SquashArg,
} from "../tools/commit-message-args.ts";
import {
  err,
  ok,
  type PortalTool,
  type ProgramToolMetadata,
  type ToolResult,
} from "../tools/types.ts";

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

// Bounded projections of the mutating git facades, so the primary agent sees a
// stable, byte-cheap result instead of the verbose raw tool output (AC6/D3).
const GIT_COMMIT_RESULT = {
  type: "object",
  properties: {
    sha: { type: "string" },
    shortSha: { type: "string" },
    subject: { type: "string" },
    mergeCommit: { type: "boolean" },
    resolvedConflicts: { type: "array", items: { type: "string" } },
  },
  required: ["sha", "shortSha", "subject", "mergeCommit", "resolvedConflicts"],
  additionalProperties: false,
} as const;

const GIT_MERGE_RESULT = {
  type: "object",
  properties: {
    merged: { type: "boolean" },
    into: { type: "string" },
    from: { type: "string" },
    fastForward: { type: "boolean" },
    squashedCommits: { type: ["integer", "null"] },
    headSha: { type: "string" },
  },
  required: [
    "merged",
    "into",
    "from",
    "fastForward",
    "squashedCommits",
    "headSha",
  ],
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
    includeIgnored: z.boolean().optional(),
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
const GitLogProgramArgs = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    skip: z.number().int().min(0).max(1000).optional(),
    ref: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(4096).optional(),
  })
  .strict();
const GitShowCommitProgramArgs = z
  .object({
    sha: z.string().min(4).max(64),
    includePatch: z.boolean().optional(),
  })
  .strict();
const GitShowFileProgramArgs = z
  .object({
    ref: z.string().min(1).max(200),
    path: z.string().min(1).max(4096),
  })
  .strict();
// Mutating git facades reuse the shared commit-message validators so a subject
// accepted through the proc path is accepted identically by the root tool
// (AC5): the primary agent authors the message; the worker only realizes it.
// The `worktree` lease selector of the root git_commit stays out of the proc
// surface (D2/scope): a worker commits to its own workspace only.
const GitCommitProgramArgs = z
  .object({
    paths: z.union([
      z.literal("all"),
      z.array(z.string().min(1).max(4096)).min(1),
    ]),
    subject: CommitSubject,
    body: CommitBody,
    trailers: CommitTrailers,
    allowConflictMarkers: z.boolean().optional(),
  })
  .strict();
const GitWorktreeMergeProgramArgs = z
  .object({
    direction: z.enum(["from-source", "to-source"]),
    allowMergeCommit: z.boolean().optional().default(false),
    squash: SquashArg,
    onConflict: z.enum(["abort", "keep"]).optional().default("abort"),
  })
  .strict();

export const PROGRAM_FACADE_TOOL_NAMES = new Set([
  "find",
  "grep",
  "git_status",
  "git_diff",
  "git_log",
  "git_show_commit",
  "git_show_file",
  "git_commit",
  "git_worktree_merge",
]);

const PROGRAM_METADATA: Readonly<Record<string, ProgramToolMetadata>> = {
  find: metadata(
    "find paths by glob",
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
    "search file contents",
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
          includeIgnored: { type: "boolean" },
        },
        ["pattern"],
      ),
      argsSchema: GrepProgramArgs,
      permissionArgs: grepDirectArgs,
      invoke: invokeGrep,
    },
  ),
  git_status: metadata(
    "inspect worktree status",
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
    "inspect changes",
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
  git_log: metadata(
    "inspect history",
    { type: "object" },
    "git.log({ limit: 20, path: 'src' })",
    undefined,
    {
      parameters: objectParameters(
        {
          limit: { type: "integer" },
          skip: { type: "integer" },
          ref: { type: "string" },
          path: { type: "string" },
        },
        [],
      ),
      argsSchema: GitLogProgramArgs,
    },
  ),
  git_show_commit: metadata(
    "inspect one commit",
    { type: "object" },
    "git.show('abc123', { includePatch: false })",
    undefined,
    {
      parameters: objectParameters(
        {
          sha: { type: "string" },
          includePatch: { type: "boolean" },
        },
        ["sha"],
      ),
      argsSchema: GitShowCommitProgramArgs,
    },
  ),
  git_show_file: metadata(
    "read file at Git ref",
    { type: "string" },
    "git.show('HEAD', 'src/index.ts')",
    undefined,
    {
      parameters: objectParameters(
        { ref: { type: "string" }, path: { type: "string" } },
        ["ref", "path"],
      ),
      argsSchema: GitShowFileProgramArgs,
    },
  ),
  git_commit: metadata(
    "create commit for selected paths",
    GIT_COMMIT_RESULT,
    "git.commit({ paths: 'all', subject: 'Primary-agent subject' })",
    undefined,
    {
      operationCategory: "mutation",
      parameters: objectParameters(
        {
          paths: {
            oneOf: [
              { type: "string", enum: ["all"] },
              { type: "array", items: { type: "string" }, minItems: 1 },
            ],
          },
          subject: { type: "string" },
          body: { type: "string" },
          trailers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                token: { type: "string" },
                value: { type: "string" },
              },
              required: ["token", "value"],
              additionalProperties: false,
            },
          },
          allowConflictMarkers: { type: "boolean" },
        },
        ["paths", "subject"],
      ),
      argsSchema: GitCommitProgramArgs,
      invoke: invokeGitCommit,
    },
  ),
  git_worktree_merge: metadata(
    "merge worktree with source branch",
    GIT_MERGE_RESULT,
    "git.worktreeMerge({ direction: 'to-source', squash: { subject: 'Unit' } })",
    undefined,
    {
      operationCategory: "mutation",
      parameters: objectParameters(
        {
          direction: {
            type: "string",
            enum: ["from-source", "to-source"],
            description:
              "Commit flow. to-source: move worktree commits to source (finish unit). from-source: pull source commits into worktree (catch up).",
          },
          allowMergeCommit: {
            type: "boolean",
            description:
              "to-source only. Allow merge commit instead of fast-forward. Default false.",
          },
          onConflict: {
            type: "string",
            enum: ["abort", "keep"],
            description:
              "from-source only. abort: roll back conflict; keep: leave conflict in worktree. to-source always rolls back. Default abort.",
          },
          squash: {
            type: "object",
            properties: {
              subject: { type: "string" },
              body: { type: "string" },
              trailers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    value: { type: "string" },
                  },
                  required: ["token", "value"],
                  additionalProperties: false,
                },
              },
            },
            required: ["subject"],
            additionalProperties: false,
          },
        },
        ["direction"],
      ),
      argsSchema: GitWorktreeMergeProgramArgs,
      invoke: invokeGitMerge,
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

export function programToolManifest(
  capabilities: ReadonlyMap<string, PortalTool>,
): Array<Record<string, unknown>> {
  const available = programCapabilities(capabilities);
  return programToolContracts(available, [...available.keys()].sort());
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
      description: tool.program.catalogDescription,
      parameters: tool.program.parameters ?? tool.parameters,
      result: tool.program.resultSchema,
      example: tool.program.example,
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
  extra: Partial<
    Pick<
      ProgramToolMetadata,
      | "parameters"
      | "argsSchema"
      | "permissionArgs"
      | "invoke"
      | "operationCategory"
    >
  > = {},
): ProgramToolMetadata {
  const { operationCategory, ...rest } = extra;
  return {
    catalogDescription,
    operationCategory: operationCategory ?? "read",
    resultSchema,
    example,
    contractVersion: "1",
    ...(normalizeArgs ? { normalizeArgs } : {}),
    ...rest,
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
      if (!match) throw new Error(`Invalid grep result line: ${line}`);
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
    include_ignored: parsed.includeIgnored ?? false,
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

async function invokeGitCommit(
  tool: PortalTool,
  args: unknown,
): Promise<ToolResult> {
  const parsed = GitCommitProgramArgs.parse(args);
  const result = await tool.handler(parsed);
  if (!result.ok) return result;
  const value = asRecord(result.result);
  return ok({
    sha: typeof value.sha === "string" ? value.sha : "",
    shortSha: typeof value.shortSha === "string" ? value.shortSha : "",
    subject: typeof value.subject === "string" ? value.subject : "",
    mergeCommit: value.mergeCommit === true,
    resolvedConflicts: Array.isArray(value.resolvedConflicts)
      ? value.resolvedConflicts.map(String)
      : [],
  });
}

async function invokeGitMerge(
  tool: PortalTool,
  args: unknown,
): Promise<ToolResult> {
  const parsed = GitWorktreeMergeProgramArgs.parse(args);
  const result = await tool.handler(parsed);
  if (!result.ok) return result;
  const value = asRecord(result.result);
  return ok({
    merged: value.merged === true,
    into: typeof value.into === "string" ? value.into : "",
    from: typeof value.from === "string" ? value.from : "",
    fastForward: value.fastForward === true,
    squashedCommits:
      typeof value.squashedCommits === "number" ? value.squashedCommits : null,
    headSha: typeof value.headSha === "string" ? value.headSha : "",
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
          `Ambiguous arguments: use only canonical key "${canonical}".`,
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
