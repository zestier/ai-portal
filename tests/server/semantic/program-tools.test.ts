import { beforeAll, describe, expect, it } from "vitest";
import { setupLocalEnv } from "../../helpers/env";
import { ok, type PortalTool } from "../../../src/lib/server/tools/types";
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
        source:
          'return await tools.grep({ query: "needle", cwd: "src", include: "*.ts" });',
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
