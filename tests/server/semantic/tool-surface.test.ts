import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setupLocalEnv } from "../../helpers/env";
import { assemblePortalTools } from "../../../src/lib/server/tools/assemble";
import { buildProcTools } from "../../../src/lib/server/proc/tools";
import { buildProgramFacadeTools } from "../../../src/lib/server/ptc/facades";
import { programToolManifest } from "../../../src/lib/server/ptc/contracts";
import { portalToolToPiTool } from "../../../src/lib/server/pi/tools";
import { SEMANTIC_SYSTEM_GUIDANCE } from "../../../src/lib/server/runtime/system-guidance";

describe("semantic tool surface", () => {
  beforeAll(async () => {
    await setupLocalEnv("semantic-surface-");
  });

  it("exposes only proc and direct human interaction", () => {
    const capabilities = assemblePortalTools({
      cwd: "/",
      userId: 1,
      conversationId: 1,
      policy: "prompt",
      getMode: () => "interactive",
      getApprovalMode: () => "ask",
      emit: () => {},
    });
    const proc = buildProcTools({
      conversationId: 1,
      frontierModel: "pi-stub/stub-model",
      capabilities: capabilities.byName,
      facadeCapabilities: buildProgramFacadeTools("/"),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
    });
    const askUser = capabilities.byName.get("ask_user");
    expect(askUser).toBeTruthy();
    expect(
      Buffer.byteLength(
        JSON.stringify({
          snippet: proc[0]?.promptSnippet,
          guidelines: proc[0]?.promptGuidelines,
        }),
      ),
    ).toBeLessThanOrEqual(1_500);
    const exposed = [...proc, askUser!].map((tool) => portalToolToPiTool(tool));
    expect(exposed.map((tool) => tool.name)).toEqual(["proc", "ask_user"]);
    expect(definitionBytes(exposed)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(SEMANTIC_SYSTEM_GUIDANCE)).toBeLessThanOrEqual(
      6 * 1024,
    );
    expect(SEMANTIC_SYSTEM_GUIDANCE).toContain(
      "does not investigate an open-ended goal",
    );
    expect(SEMANTIC_SYSTEM_GUIDANCE).toContain("retain diagnosis");
    expect(SEMANTIC_SYSTEM_GUIDANCE).toContain("consequential decisions");
    expect(exposed.some((tool) => tool.name === "bash")).toBe(false);
    expect(exposed.some((tool) => tool.name === "edit")).toBe(false);
    expect(exposed.some((tool) => tool.name === "program")).toBe(false);
    expect(exposed.some((tool) => tool.name === "resolve")).toBe(false);
  });

  it("discovers only explicitly enabled program contracts", () => {
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
    const manifest = programToolManifest(capabilities.byName);
    expect(manifest.map((entry) => entry.name)).toEqual([
      "git_diff",
      "git_status",
    ]);
    for (const contract of manifest) {
      expect(contract).toMatchObject({
        parameters: expect.any(Object),
        result: expect.any(Object),
        example: expect.any(String),
      });
    }
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
