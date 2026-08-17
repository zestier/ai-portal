import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLsTools } from "../../../src/lib/server/tools/ls";
import type { PortalTool } from "../../../src/lib/server/tools/types";

function tool(root: string): PortalTool {
  const found = buildLsTools(root)[0];
  if (!found) throw new Error("ls tool not registered");
  return found;
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "portal-ls-test-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function lsText(result: {
  ok: boolean;
  views?: { type: string; text?: string }[];
}): string {
  if (!result.ok) throw new Error("expected ok result");
  return result.views?.[0]?.text ?? "";
}

describe("ls", () => {
  it("lists a directory sorted alphabetically with `/` suffixes for subdirectories", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "src"));
      await writeFile(join(workspace, "app.ts"), "");
      await writeFile(join(workspace, "README.md"), "");

      const result = await tool(workspace).handler({});
      expect(result).toMatchObject({ ok: true });
      const view = lsText(result);
      // Case-insensitive alphabetical sort (app < README), src gets the dir suffix.
      expect(view.split("\n")).toEqual(["app.ts", "README.md", "src/"]);
    });
  });

  it("includes dotfiles", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
      await writeFile(join(workspace, "a.ts"), "");

      const view = lsText(await tool(workspace).handler({}));
      expect(view.split("\n")).toEqual([".gitignore", "a.ts"]);
    });
  });

  it("lists a scoped workspace-relative path", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "pkg"));
      await writeFile(join(workspace, "pkg", "index.ts"), "");

      const result = await tool(workspace).handler({ path: "pkg" });
      expect(lsText(result)).toBe("index.ts");
      expect(result).toMatchObject({ ok: true, result: { path: "pkg" } });
    });
  });

  it("caps entries at the requested limit", async () => {
    await withWorkspace(async (workspace) => {
      for (const name of ["a.ts", "b.ts", "c.ts"])
        await writeFile(join(workspace, name), "");

      const result = await tool(workspace).handler({ limit: 2 });
      // pi appends a `[2 entries limit reached. Use limit=4 for more]` notice;
      // the listing itself is capped at two entries.
      const view = lsText(result);
      expect(view.split("\n").filter(Boolean).slice(0, 2)).toEqual([
        "a.ts",
        "b.ts",
      ]);
      expect(view).toContain("entries limit reached");
    });
  });

  it("errors when the path is not a directory", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, "file.txt"), "x");
      const result = await tool(workspace).handler({ path: "file.txt" });
      expect(result).toMatchObject({ ok: false, error: { code: "ls_failed" } });
    });
  });

  it("rejects a path outside the workspace", async () => {
    await withWorkspace(async (workspace) => {
      const result = await tool(workspace).handler({ path: ".." });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_path" },
      });
    });
  });

  it("derives a read permission request on the resolved path", async () => {
    await withWorkspace(async (workspace) => {
      const derive = tool(workspace).derivePermissionRequest;
      expect(derive).toBeDefined();
      expect(derive?.({ path: "src" })).toEqual({
        permissionKind: "read",
        path: join(workspace, "src"),
      });
      expect(derive?.({ path: ".." })).toBeNull();
    });
  });
});
