import { beforeAll, describe, expect, it } from "vitest";
import { setupLocalEnv } from "../../helpers/env";
import { ok, type PortalTool } from "../../../src/lib/server/tools/types";
import { deriveToolResultViews } from "../../../src/lib/tool-result-views";
import { attachProgramMetadata } from "../../../src/lib/server/ptc/contracts";
import { buildSemanticTools } from "../../../src/lib/server/semantic/tools";

describe("semantic program tools", () => {
  beforeAll(async () => {
    await setupLocalEnv("semantic-program-");
  });

  it("returns exact requested schemas without a list mode", async () => {
    const grep = attachProgramMetadata(fakeTool("grep"));
    const tools = buildSemanticTools(options(new Map([[grep.name, grep]])));
    const schemas = tools.find(
      (tool) => tool.name === "get_program_tool_schemas",
    )!;
    const result = await schemas.handler({ names: ["grep", "gre"] });
    expect(result).toMatchObject({
      ok: true,
      result: {
        tools: [
          { name: "grep", contractVersion: "1" },
          { name: "gre", error: "unknown program tool", suggestions: ["grep"] },
        ],
      },
    });
    await expect(schemas.handler({})).rejects.toThrow();
  });

  it("normalizes a guessed form before permission and dispatch", async () => {
    const seen: unknown[] = [];
    const grep = attachProgramMetadata({
      ...fakeTool("grep"),
      async handler(args) {
        seen.push({ handler: args });
        return ok(args);
      },
    });
    const tools = buildSemanticTools({
      ...options(new Map([[grep.name, grep]])),
      permissionResolver: async (_name, args) => {
        seen.push({ permission: args });
        return { allow: true };
      },
    });
    const program = tools.find((tool) => tool.name === "program")!;
    const result = await program.handler(
      {
        summary: "Find needle in TypeScript files",
        source:
          'return tools.grep({ query: "needle", cwd: "src", include: "*.ts" });',
      },
      {
        signal: new AbortController().signal,
        toolCallId: "X1",
        partial: () => {},
        progress: () => {},
      },
    );
    const canonical = { pattern: "needle", path: "src", glob: "*.ts" };
    expect(seen).toEqual([
      { permission: canonical },
      {
        handler: {
          ...canonical,
          output_mode: "content",
          head_limit: 0,
          "-n": true,
          "-i": false,
        },
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      result: {
        value: { matches: [], truncated: false },
        operations: 1,
      },
    });
    expect(deriveToolResultViews(result).modelText).toBe(
      `${JSON.stringify({ matches: [], truncated: false }, null, 2)}\n\nOperations: 1`,
    );
    expect(deriveToolResultViews(result).modelText).not.toContain("trace");
    expect(deriveToolResultViews(result).fullContent).toContain('"trace"');
  });

  it("suspends and resumes a synchronous program call for permission", async () => {
    let approve!: () => void;
    const permission = new Promise<void>((resolve) => {
      approve = resolve;
    });
    let handlerRan = false;
    const echo = attachProgramMetadata({
      ...fakeTool("grep"),
      async handler() {
        handlerRan = true;
        return ok({ content: "src/a.ts:1:needle", truncated: false });
      },
    });
    const tools = buildSemanticTools({
      ...options(new Map([[echo.name, echo]])),
      permissionResolver: async () => {
        await permission;
        return { allow: true };
      },
    });
    const program = tools.find((tool) => tool.name === "program")!;
    const pending = program.handler(
      {
        summary: "Find needle",
        source: 'return tools.grep({ pattern: "needle" });',
      },
      {
        signal: new AbortController().signal,
        toolCallId: "X2",
        partial: () => {},
        progress: () => {},
      },
    );

    await Promise.resolve();
    expect(handlerRan).toBe(false);
    approve();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: {
        value: {
          matches: [
            { path: "src/a.ts", line: 1, column: null, text: "needle" },
          ],
        },
      },
    });
    expect(handlerRan).toBe(true);
  });
});

function fakeTool(name: string): PortalTool {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    async handler(args) {
      return ok(args);
    },
  };
}

function options(capabilities: ReadonlyMap<string, PortalTool>) {
  return {
    conversationId: 1,
    frontierModel: "pi-stub/stub-model",
    capabilities,
    permissionResolver: async () => ({ allow: true }),
    emit: () => {},
  };
}
