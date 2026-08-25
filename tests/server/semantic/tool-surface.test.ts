import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setupLocalEnv } from "../../helpers/env";
import { assemblePortalTools } from "../../../src/lib/server/tools/assemble";
import { buildSemanticTools } from "../../../src/lib/server/semantic/tools";
import { portalToolToPiTool } from "../../../src/lib/server/pi/tools";
import { SEMANTIC_SYSTEM_GUIDANCE } from "../../../src/lib/server/runtime/system-guidance";

describe("semantic tool surface", () => {
  beforeAll(async () => {
    await setupLocalEnv("semantic-surface-");
  });

  it("stays compact while retaining semantic, PTC, artifact, and human tools", () => {
    const capabilities = assemblePortalTools({
      cwd: "/",
      userId: 1,
      conversationId: 1,
      policy: "prompt",
      getMode: () => "interactive",
      getApprovalMode: () => "ask",
      emit: () => {},
    });
    const semantic = buildSemanticTools({
      conversationId: 1,
      frontierModel: "pi-stub/stub-model",
      capabilities: capabilities.byName,
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
    });
    const askUser = capabilities.byName.get("ask_user");
    expect(askUser).toBeTruthy();
    const exposed = [...semantic, askUser!].map((tool) =>
      portalToolToPiTool(tool),
    );
    expect(exposed.map((tool) => tool.name)).toEqual([
      "resolve",
      "resume",
      "program",
      "get_program_tool_schemas",
      "read_evidence",
      "read_changeset",
      "read_trace",
      "read_output",
      "ask_user",
    ]);
    expect(definitionBytes(exposed)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(SEMANTIC_SYSTEM_GUIDANCE)).toBeLessThanOrEqual(
      6 * 1024,
    );
    expect(SEMANTIC_SYSTEM_GUIDANCE).toContain("not a general subagent");
    expect(SEMANTIC_SYSTEM_GUIDANCE).not.toContain("frontier");
    expect(exposed.some((tool) => tool.name === "bash")).toBe(false);
    expect(exposed.some((tool) => tool.name === "edit")).toBe(false);
    const program = semantic.find((tool) => tool.name === "program")!;
    const programGuidance = program.promptGuidelines?.join("\n") ?? "";
    expect(programGuidance).toContain("grep - search workspace file contents");
    expect(programGuidance).not.toMatch(
      /(?:^|; )(?:read|write|edit|multi_edit|move|ls|create_directory|bash) -/,
    );
    expect(programGuidance).not.toContain("ask_user -");
    expect(programGuidance).toContain(
      "Program rules: fs, path, command, and tools are predeclared synchronous APIs",
    );
    expect(programGuidance).toContain(
      "predeclared synchronous APIs; never import, require, or await them",
    );
    expect(programGuidance).toContain('fs.readFile(path, "utf8")');
    expect(programGuidance).toContain(
      "filesystem grants govern the resolved target, so outside paths may prompt",
    );
    expect(programGuidance).toContain("path.join");
    expect(programGuidance).toContain("fs.mkdir(path)");
    expect(programGuidance).toContain("fs.rename(from, to)");
    expect(programGuidance).toContain(
      'command.run("pnpm", ["check"], options)',
    );
    expect(programGuidance).not.toContain('command.run("git"');
    expect(programGuidance).toContain(
      "Calls return the successful value and throw on failure",
    );
    expect(programGuidance).toContain(
      "Return the final value directly; never use console output or JSON.stringify",
    );
  });

  it("removes disabled groups from the program catalog", () => {
    const capabilities = assemblePortalTools({
      cwd: "/",
      userId: 1,
      conversationId: 1,
      policy: "prompt",
      getMode: () => "interactive",
      getApprovalMode: () => "ask",
      emit: () => {},
      disabledToolGroups: ["filesystem"],
    });
    const semantic = buildSemanticTools({
      conversationId: 1,
      frontierModel: "pi-stub/stub-model",
      capabilities: capabilities.byName,
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
    });
    const guidance = semantic
      .find((tool) => tool.name === "program")!
      .promptGuidelines?.join("\n");
    expect(guidance).not.toContain("grep -");
    expect(guidance).not.toContain("bash -");
    expect(guidance).toContain('command.run("pnpm", ["check"], options)');
  });
});

function definitionBytes(tools: ToolDefinition[]): number {
  return tools.reduce(
    (total, tool) =>
      total +
      Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      ),
    0,
  );
}
