import { describe, expect, it, vi } from "vitest";
import { ok, type PortalTool } from "../../../src/lib/server/tools/types";
import {
  attachProgramMetadata,
  normalizeProgramToolArgs,
  programCapabilities,
  programCatalog,
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
      "grep - search file contents",
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
    ).toThrow(/Ambiguous arguments/);
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

  it("exposes git commit and worktree merge as bounded mutating facades", async () => {
    const commitHandler = vi.fn(async () =>
      ok({
        sha: "abc123def456",
        shortSha: "abc123de",
        subject: "primary subject",
        body: "primary body",
        mergeCommit: false,
        resolvedConflicts: [] as string[],
      }),
    );
    const commit = attachProgramMetadata({
      ...tool("git_commit"),
      permissionBehavior: "always-prompt",
      handler: commitHandler,
    });
    const mergeHandler = vi.fn(async () =>
      ok({
        merged: true,
        into: "main",
        from: "fix/unit",
        fastForward: false,
        squashedCommits: 3,
        headSha: "def456",
      }),
    );
    const merge = attachProgramMetadata({
      ...tool("git_worktree_merge"),
      permissionBehavior: "always-prompt",
      handler: mergeHandler,
    });
    const capabilities = programCapabilities(
      new Map([
        [commit.name, commit],
        [merge.name, merge],
      ]),
    );
    const commitTool = capabilities.get("git_commit")!;
    const mergeTool = capabilities.get("git_worktree_merge")!;
    expect(commitTool.program!.operationCategory).toBe("mutation");
    expect(mergeTool.program!.operationCategory).toBe("mutation");
    expect(commitTool.permissionBehavior).toBe("always-prompt");
    expect(mergeTool.permissionBehavior).toBe("always-prompt");

    await expect(
      commitTool.handler({
        paths: "all",
        subject: "primary subject",
        trailers: [{ token: "Ticket", value: "T1" }],
      }),
    ).resolves.toEqual({
      ok: true,
      result: {
        sha: "abc123def456",
        shortSha: "abc123de",
        subject: "primary subject",
        mergeCommit: false,
        resolvedConflicts: [],
      },
    });
    // The primary-agent message reaches the underlying tool runtime
    // verbatim (D2) — the projection never authors or rewrites it.
    expect(commitHandler).toHaveBeenCalledWith({
      paths: "all",
      subject: "primary subject",
      trailers: [{ token: "Ticket", value: "T1" }],
    });

    await expect(
      mergeTool.handler({
        direction: "to-source",
        squash: { subject: "Unit" },
      }),
    ).resolves.toEqual({
      ok: true,
      result: {
        merged: true,
        into: "main",
        from: "fix/unit",
        fastForward: false,
        squashedCommits: 3,
        headSha: "def456",
      },
    });
    expect(mergeHandler).toHaveBeenCalledWith({
      direction: "to-source",
      squash: { subject: "Unit" },
      allowMergeCommit: false,
      onConflict: "abort",
    });
  });

  it("projects commit and merge facade results to the minimal bounded contract", async () => {
    const commit = attachProgramMetadata({
      ...tool("git_commit"),
      async handler() {
        return ok({
          sha: "abc",
          shortSha: "abc",
          subject: "s",
          body: "b",
          trailers: [],
          files: [], // verbose — must not leak into the projection
          mergeCommit: false,
          resolvedConflicts: [],
        });
      },
    });
    const merge = attachProgramMetadata({
      ...tool("git_worktree_merge"),
      async handler() {
        return ok({
          merged: true,
          into: "main",
          from: "fix",
          fastForward: true,
          headSha: "def",
          status: {/* verbose — must not leak */},
        });
      },
    });
    const caps = programCapabilities(
      new Map([
        [commit.name, commit],
        [merge.name, merge],
      ]),
    );
    await expect(
      caps.get("git_commit")!.handler({ paths: "all", subject: "s" }),
    ).resolves.toEqual({
      ok: true,
      result: {
        sha: "abc",
        shortSha: "abc",
        subject: "s",
        mergeCommit: false,
        resolvedConflicts: [],
      },
    });
    await expect(
      caps.get("git_worktree_merge")!.handler({ direction: "to-source" }),
    ).resolves.toEqual({
      ok: true,
      result: {
        merged: true,
        into: "main",
        from: "fix",
        fastForward: true,
        squashedCommits: null,
        headSha: "def",
      },
    });
  });

  it("propagates a from-source conflict as a structured error", async () => {
    const merge = attachProgramMetadata({
      ...tool("git_worktree_merge"),
      async handler() {
        return {
          ok: false as const,
          error: {
            code: "merge_conflict",
            message: "merge_conflict: conflicted",
          },
        };
      },
    });
    const caps = programCapabilities(new Map([[merge.name, merge]]));
    await expect(
      caps
        .get("git_worktree_merge")!
        .handler({ direction: "from-source", onConflict: "keep" }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "merge_conflict", message: "merge_conflict: conflicted" },
    });
  });
});
