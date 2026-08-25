import { describe, expect, it } from "vitest";
import { ok, type PortalTool } from "../../../src/lib/server/tools/types";
import {
  attachProgramMetadata,
  normalizeProgramToolArgs,
  programCatalog,
  programCapabilities,
  programToolContracts,
} from "../../../src/lib/server/ptc/contracts";

function tool(name: string): PortalTool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object" },
    async handler(args) {
      return ok(args);
    },
  };
}

describe("program contracts", () => {
  it("only exposes explicitly supported capabilities", () => {
    const grep = attachProgramMetadata(tool("grep"));
    const askUser = attachProgramMetadata(tool("ask_user"));
    expect([
      ...programCapabilities(
        new Map([
          [grep.name, grep],
          [askUser.name, askUser],
        ]),
      ).keys(),
    ]).toEqual(["grep"]);
    expect(programCatalog(new Map([[grep.name, grep]]))).toBe(
      "grep - search workspace file contents",
    );
  });

  it("returns canonical contracts and per-name unknown errors", () => {
    const grep = attachProgramMetadata(tool("grep"));
    const contracts = programToolContracts(new Map([[grep.name, grep]]), [
      "grep",
      "grep",
      "gre",
    ]);
    expect(contracts).toHaveLength(2);
    expect(contracts[0]).toMatchObject({
      name: "grep",
      parameters: { type: "object" },
      contractVersion: "1",
    });
    expect(contracts[1]).toMatchObject({
      name: "gre",
      error: "unknown program tool",
      suggestions: ["grep"],
    });
  });

  it("normalizes likely grep aliases and rejects ambiguous forms", () => {
    const grep = attachProgramMetadata(tool("grep"));
    expect(
      normalizeProgramToolArgs(grep, {
        query: "needle",
        cwd: "src",
        include: "*.ts",
      }),
    ).toEqual({ pattern: "needle", path: "src", glob: "*.ts" });
    expect(() =>
      normalizeProgramToolArgs(grep, { pattern: "one", query: "two" }),
    ).toThrow(/Ambiguous program arguments/);
  });
});
