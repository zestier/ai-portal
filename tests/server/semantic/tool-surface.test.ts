import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setupLocalEnv } from "../../helpers/env";
import { assemblePortalTools } from "../../../src/lib/server/tools/assemble";
import { buildSemanticTools } from "../../../src/lib/server/semantic/tools";
import { portalToolToPiTool } from "../../../src/lib/server/pi/tools";
import { SEMANTIC_FRONTIER_GUIDANCE } from "../../../src/lib/server/runtime/system-guidance";

describe("semantic frontier tool surface", () => {
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
      "describe_capabilities",
      "read_evidence",
      "read_changeset",
      "read_trace",
      "read_output",
      "ask_user",
    ]);
    expect(definitionBytes(exposed)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(SEMANTIC_FRONTIER_GUIDANCE)).toBeLessThanOrEqual(
      6 * 1024,
    );
    expect(exposed.some((tool) => tool.name === "bash")).toBe(false);
    expect(exposed.some((tool) => tool.name === "edit")).toBe(false);
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
