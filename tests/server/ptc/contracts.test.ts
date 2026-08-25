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
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          caseInsensitive: { type: "boolean" },
        },
      },
      result: {
        type: "object",
        required: ["matches", "truncated"],
      },
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

  it("omits bash from program capabilities", () => {
    const bash = attachProgramMetadata(tool("bash"));
    expect(programCapabilities(new Map([[bash.name, bash]]))).toEqual(
      new Map(),
    );
  });

  it("adapts canonical find and grep values", async () => {
    const find = attachProgramMetadata({
      ...tool("find"),
      async handler() {
        return ok({
          text: "src/a.ts\nsrc/b.ts\n[10000 results limit reached]",
        });
      },
    });
    const grep = attachProgramMetadata({
      ...tool("grep"),
      async handler() {
        return ok({
          content: "src/a.ts:4:first\nsrc/b.ts:9:second",
          truncated: false,
        });
      },
    });
    const capabilities = programCapabilities(
      new Map([
        [find.name, find],
        [grep.name, grep],
      ]),
    );
    await expect(
      capabilities.get("find")!.handler({ pattern: "*.ts" }),
    ).resolves.toMatchObject({
      ok: true,
      result: { paths: ["src/a.ts", "src/b.ts"], truncated: true },
    });
    await expect(
      capabilities.get("grep")!.handler({ pattern: "needle" }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        matches: [
          { path: "src/a.ts", line: 4, column: null, text: "first" },
          { path: "src/b.ts", line: 9, column: null, text: "second" },
        ],
        truncated: false,
      },
    });
  });

  it("turns an uninitialized Git status into a program error", async () => {
    const status = attachProgramMetadata({
      ...tool("git_status"),
      async handler() {
        return ok({ initialized: false, changes: [] });
      },
    });
    await expect(
      programCapabilities(new Map([[status.name, status]]))
        .get("git_status")!
        .handler({}),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "Not a Git repository." },
    });
  });
});
