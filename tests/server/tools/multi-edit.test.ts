import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMultiEditTools } from "../../../src/lib/server/tools/multi-edit";
import { validatePortalToolArgs } from "../../../src/lib/server/tools/schema-error";

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "portal-multi-edit-test-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function multiEditTool(workspace: string) {
  return buildMultiEditTools(workspace).find(
    (candidate) => candidate.name === "multi_edit",
  )!;
}

function initGitRepo(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Portal Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "portal-test@localhost"], {
    cwd: dir,
  });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
}

describe("multi_edit", () => {
  it("applies edits across multiple files, reporting per-edit FileEditOutput entries", async () => {
    await withWorkspace(async (workspace) => {
      const a = join(workspace, "a.txt");
      const b = join(workspace, "b.txt");
      await writeFile(a, "one\ntwo\n");
      await writeFile(b, "three\nfour\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          { file_path: "a.txt", old_string: "one", new_string: "ONE" },
          { file_path: "b.txt", old_string: "three", new_string: "THREE" },
        ],
        worktree: ".",
      });

      expect(result).toMatchObject({
        ok: true,
        summary: "Applied 2 edit(s) across 2 file(s).",
      });
      expect(await readFile(a, "utf8")).toBe("ONE\ntwo\n");
      expect(await readFile(b, "utf8")).toBe("THREE\nfour\n");
      if (result.ok) {
        const output = result.result as {
          edits: Array<{
            filePath: string;
            oldString: string;
            newString: string;
            originalFile: string;
            replaceAll: boolean;
            userModified: boolean;
            structuredPatch: unknown[];
          }>;
        };
        expect(output.edits).toHaveLength(2);
        expect(output.edits[0]).toMatchObject({
          filePath: a,
          oldString: "one",
          newString: "ONE",
          originalFile: "one\ntwo\n",
          replaceAll: false,
          userModified: false,
        });
        expect(output.edits[1]).toMatchObject({
          filePath: b,
          oldString: "three",
          newString: "THREE",
          originalFile: "three\nfour\n",
        });
        expect(Array.isArray(output.edits[0]?.structuredPatch)).toBe(true);
      }
    });
  });

  it("applies edits sequentially within a file, matching later edits against prior results", async () => {
    await withWorkspace(async (workspace) => {
      const path = join(workspace, "sample.txt");
      await writeFile(path, "gamma three\nbeta two\ngamma three\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "sample.txt",
            old_string: "gamma three",
            new_string: "gamma THREE",
          },
          {
            file_path: "sample.txt",
            old_string: "beta two",
            new_string: "beta TWO",
          },
        ],
      });

      expect(result).toMatchObject({ ok: true });
      expect(await readFile(path, "utf8")).toBe(
        "gamma THREE\nbeta TWO\ngamma three\n",
      );
      if (result.ok) {
        const output = result.result as {
          edits: Array<{ originalFile: string }>;
        };
        // The second edit matched against the content AFTER the first edit.
        expect(output.edits[1]?.originalFile).toBe(
          "gamma THREE\nbeta two\ngamma three\n",
        );
      }
    });
  });

  it("replace_all replaces every occurrence", async () => {
    await withWorkspace(async (workspace) => {
      const path = join(workspace, "sample.txt");
      await writeFile(path, "twenty\nphi twenty one\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "sample.txt",
            old_string: "twenty",
            new_string: "TWENTY",
            replace_all: true,
          },
        ],
      });

      expect(result).toMatchObject({ ok: true });
      expect(await readFile(path, "utf8")).toBe("TWENTY\nphi TWENTY one\n");
      if (result.ok) {
        const output = result.result as {
          edits: Array<{ replaceAll: boolean }>;
        };
        expect(output.edits[0]?.replaceAll).toBe(true);
      }
    });
  });

  it("aborts the whole batch with nothing written when a middle edit fails", async () => {
    await withWorkspace(async (workspace) => {
      const a = join(workspace, "a.txt");
      const b = join(workspace, "b.txt");
      await writeFile(a, "original-a\n");
      await writeFile(b, "original-b\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "a.txt",
            old_string: "original-a",
            new_string: "edited-a",
          },
          {
            file_path: "b.txt",
            old_string: "does not exist",
            new_string: "edited-b",
          },
        ],
      });

      expect(result).toMatchObject({ ok: false });
      // Atomicity: the first (valid) edit must not have landed either.
      expect(await readFile(a, "utf8")).toBe("original-a\n");
      expect(await readFile(b, "utf8")).toBe("original-b\n");
    });
  });

  it("names the failing edit index, path, and unmatched string", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "sample.txt"), "hello\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "sample.txt",
            old_string: "hello",
            new_string: "goodbye",
          },
          { file_path: "sample.txt", old_string: "nope", new_string: "x" },
        ],
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "edit_failed",
          message:
            "edits[1] (sample.txt): string to replace not found.\nString: nope",
        },
      });
      // Low-similarity not-found stays exactly today's envelope (no hint).
      if (!result.ok) {
        expect(result.error.details).toBeUndefined();
        expect(result.error.message).not.toContain("Did you mean:");
      }
    });
  });

  it("includes the closest-match hint for the failing edit only, keeping the batch atomic (ACB-4)", async () => {
    await withWorkspace(async (workspace) => {
      const a = join(workspace, "a.txt");
      const b = join(workspace, "b.txt");
      await writeFile(a, "original-a\n");
      await writeFile(b, "gamma three\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "a.txt",
            old_string: "original-a",
            new_string: "edited-a",
          },
          {
            file_path: "b.txt",
            old_string: "gamma tree",
            new_string: "gamma FOUR",
          },
        ],
      });

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.error.message).toContain("edits[1] (b.txt)");
        expect(result.error.message).toContain("Did you mean:");
        expect(result.error.message).toContain('"old_string": "gamma three"');
        expect(result.error.details).toMatchObject({
          suggestion: { snippet: '"gamma three"', lineStart: 1, lineEnd: 1 },
        });
      }
      // Atomic: the first (valid) edit must not have landed either.
      expect(await readFile(a, "utf8")).toBe("original-a\n");
      expect(await readFile(b, "utf8")).toBe("gamma three\n");
    });
  });

  it("reports a missing file with the failing edit index", async () => {
    await withWorkspace(async (workspace) => {
      const result = await multiEditTool(workspace).handler({
        edits: [{ file_path: "missing.txt", old_string: "x", new_string: "y" }],
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "edit_failed",
          message: "edits[0] (missing.txt): file not found",
        },
      });
    });
  });

  it("rejects a path outside the workspace", async () => {
    await withWorkspace(async (workspace) => {
      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: join(tmpdir(), "portal-multi-edit-escape", "escape.txt"),
            old_string: "x",
            new_string: "y",
          },
        ],
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_path" },
      });
    });
  });

  it("dryRun validates without writing anything", async () => {
    await withWorkspace(async (workspace) => {
      const path = join(workspace, "sample.txt");
      await writeFile(path, "before\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "sample.txt",
            old_string: "before",
            new_string: "after",
          },
        ],
        dryRun: true,
      });

      expect(result).toMatchObject({
        ok: true,
        summary: "Validated 1 edit(s) across 1 file(s).",
      });
      if (result.ok) {
        expect((result.result as { dryRun: boolean }).dryRun).toBe(true);
      }
      expect(await readFile(path, "utf8")).toBe("before\n");
    });
  });

  it("reports a gitDiff per edit when the targets are in a git repo", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "app.ts"), "return value;\n");
      initGitRepo(workspace);

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "app.ts",
            old_string: "return value;",
            new_string: "return value.toUpperCase();",
          },
        ],
      });

      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        const output = result.result as {
          edits: Array<{ gitDiff?: { filename: string; status: string } }>;
        };
        expect(output.edits[0]?.gitDiff).toMatchObject({
          filename: "app.ts",
          status: "modified",
        });
      }
    });
  });

  it("derives an edit-kind permission request covering every target", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "a.txt"), "a\n");
      await writeFile(join(workspace, "b.txt"), "b\n");
      const derive = multiEditTool(workspace).derivePermissionRequest;
      expect(derive).toBeDefined();
      expect(
        derive?.({
          edits: [
            { file_path: "a.txt", old_string: "a", new_string: "A" },
            { file_path: "b.txt", old_string: "b", new_string: "B" },
          ],
        }),
      ).toEqual({
        permissionKind: "edit",
        path: join(workspace, "a.txt"),
        additionalPaths: [join(workspace, "b.txt")],
      });
      // Unresolvable paths fall back to the custom-tool request (null).
      expect(
        derive?.({
          edits: [{ file_path: "bad\0path", old_string: "a", new_string: "b" }],
        }),
      ).toBeNull();
    });
  });

  it("rejects more than 100 edits per call", async () => {
    await withWorkspace(async (workspace) => {
      const tool = multiEditTool(workspace);
      const edits = Array.from({ length: 101 }, (_, i) => ({
        file_path: "f.txt",
        old_string: `k${i}`,
        new_string: `v${i}`,
      }));

      const validation = validatePortalToolArgs(tool, { edits });
      expect(validation.ok).toBe(false);
      if (!validation.ok)
        expect(validation.feedback).toMatch(/to have <=100 items/);
    });
  });

  it("rejects a batch whose serialized edits payload exceeds 1MB", async () => {
    await withWorkspace(async (workspace) => {
      const tool = multiEditTool(workspace);
      const big = "x".repeat(1_100_000);

      const validation = validatePortalToolArgs(tool, {
        edits: [{ file_path: "f.txt", old_string: "x", new_string: big }],
      });
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.feedback).toMatch(/exceeds the 1000000 byte limit/);
      }
    });
  });

  it("eats a stray numbered-read tab and mirrors it onto new_string (Option 3)", async () => {
    await withWorkspace(async (workspace) => {
      const path = join(workspace, "sample.ts");
      await writeFile(path, "if (x) {\n\treturn;\n}\n");

      const result = await multiEditTool(workspace).handler({
        edits: [
          {
            file_path: "sample.ts",
            old_string: "\t\treturn;",
            new_string: "\t\treturn value;",
          },
        ],
      });

      expect(result).toMatchObject({ ok: true });
      expect(await readFile(path, "utf8")).toBe(
        "if (x) {\n\treturn value;\n}\n",
      );
      if (result.ok) {
        const output = result.result as {
          edits: Array<{ lenientTabEating?: { ateLines: number[] } }>;
        };
        expect(output.edits[0]?.lenientTabEating).toEqual({ ateLines: [1] });
      }
    });
  });
});
