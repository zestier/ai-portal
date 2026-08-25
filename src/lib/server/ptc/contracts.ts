import type { PortalTool, ProgramToolMetadata } from "$lib/server/tools/types";

const OBJECT_RESULT = {
  type: "object",
  description: "The successful structured result returned by the portal tool.",
} as const;

const STRING_RESULT = { type: "string" } as const;

const PROGRAM_METADATA: Readonly<Record<string, ProgramToolMetadata>> = {
  read: metadata(
    "read a text file or selected line range",
    {
      oneOf: [
        {
          type: "object",
          properties: {
            type: { const: "text" },
            file: {
              type: "object",
              properties: {
                filePath: STRING_RESULT,
                content: STRING_RESULT,
                numLines: { type: "integer" },
                startLine: { type: "integer" },
                totalLines: { type: "integer" },
                size: { type: "integer" },
              },
              required: [
                "filePath",
                "content",
                "numLines",
                "startLine",
                "totalLines",
                "size",
              ],
            },
          },
          required: ["type", "file"],
        },
        {
          type: "object",
          description: "Image result; native-like fs.readFile rejects it.",
          properties: { type: { const: "image" }, file: OBJECT_RESULT },
          required: ["type", "file"],
        },
      ],
    },
    'await tools.read({ file_path: "src/index.ts", mode: "content" })',
    normalizeAliases({ file_path: ["path"] }),
  ),
  ls: metadata(
    "list a workspace directory",
    OBJECT_RESULT,
    'await tools.ls({ path: "src" })',
    normalizeAliases({ path: ["cwd"] }),
  ),
  find: metadata(
    "find workspace paths by glob",
    OBJECT_RESULT,
    'await tools.find({ pattern: "**/*.test.ts", path: "tests" })',
    normalizeAliases({ pattern: ["query"], path: ["cwd"] }),
  ),
  grep: metadata(
    "search workspace file contents",
    OBJECT_RESULT,
    'await tools.grep({ pattern: "ProgramArgs", path: "src", output_mode: "content" })',
    normalizeAliases({
      pattern: ["query", "regex"],
      path: ["cwd"],
      glob: ["include"],
    }),
  ),
  create_directory: metadata(
    "create a workspace directory",
    OBJECT_RESULT,
    'await tools.create_directory({ path: "src/new" })',
    normalizeAliases({ path: ["directory", "dir"] }),
  ),
  write: metadata(
    "create or replace a text file",
    OBJECT_RESULT,
    'await tools.write({ file_path: "src/new.ts", content: "export {};\n" })',
    normalizeAliases({ file_path: ["path"], content: ["data", "text"] }),
  ),
  edit: metadata(
    "replace anchored text in one file",
    OBJECT_RESULT,
    'await tools.edit({ file_path: "src/a.ts", anchor: "old", new_string: "new" })',
    normalizeAliases({
      file_path: ["path"],
      anchor: ["old_string", "oldString"],
      new_string: ["newString", "replacement"],
    }),
  ),
  multi_edit: metadata(
    "apply several anchored file edits atomically",
    OBJECT_RESULT,
    'await tools.multi_edit({ edits: [{ file_path: "src/a.ts", old_string: "old", new_string: "new" }] })',
    normalizeMultiEdit,
  ),
  move: metadata(
    "move or rename a workspace path",
    OBJECT_RESULT,
    'await tools.move({ source: "old.ts", destination: "new.ts" })',
    normalizeAliases({ source: ["from"], destination: ["to"] }),
  ),
  git_status: metadata(
    "inspect repository working-tree status",
    OBJECT_RESULT,
    "await tools.git_status({})",
  ),
  git_diff: metadata(
    "inspect repository changes",
    {},
    'await tools.git_diff({ target: "worktree-vs-head", output: "patch" })',
  ),
  bash: metadata(
    "run a bounded validation or command",
    OBJECT_RESULT,
    'await tools.bash({ command: "pnpm test tests/example.test.ts" })',
    normalizeAliases({ command: ["cmd"] }),
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
    if (tool.program) selected.set(name, tool);
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
      parameters: tool.parameters,
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
): ProgramToolMetadata {
  return {
    catalogDescription,
    resultSchema,
    example,
    contractVersion: "1",
    ...(normalizeArgs ? { normalizeArgs } : {}),
  };
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

function normalizeMultiEdit(args: unknown): unknown {
  if (!isRecord(args) || !Array.isArray(args.edits)) return args;
  const normalizeEdit = normalizeAliases({
    file_path: ["path"],
    old_string: ["oldString", "anchor"],
    new_string: ["newString", "replacement"],
  });
  return { ...args, edits: args.edits.map(normalizeEdit) };
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
