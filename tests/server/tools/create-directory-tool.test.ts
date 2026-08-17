import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../../helpers/tmp";
import { buildCreateDirectoryTools } from "../../../src/lib/server/tools/filesystem";
import type {
  PortalTool,
  ToolResult,
} from "../../../src/lib/server/tools/types";

function createDirectoryTool(root: string): PortalTool {
  const tool = buildCreateDirectoryTools(root)[0];
  if (!tool) throw new Error("create_directory tool not registered");
  return tool;
}

function expectOk(result: ToolResult): { path: string; outcome: string } {
  if (!result.ok)
    throw new Error(`expected ok, got error: ${result.error.message}`);
  return result.result as { path: string; outcome: string };
}

describe("create_directory tool", () => {
  let root: string;
  let tool: PortalTool;

  beforeEach(() => {
    root = makeTmpDir("create-dir-");
    tool = createDirectoryTool(root);
  });

  it("creates nested directories recursively and returns a workspace-relative path", async () => {
    const res = await tool.handler({ path: "a/b/c" });
    const payload = expectOk(res);
    expect(payload).toEqual({ path: "a/b/c", outcome: "created" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.summary).toBe("Created directory: a/b/c");
    expect(statSync(join(root, "a/b/c")).isDirectory()).toBe(true);
  });

  it('is idempotent: re-creating an existing directory succeeds with outcome "already-present"', async () => {
    await tool.handler({ path: "data" });
    const res = await tool.handler({ path: "data" });
    expect(res.ok).toBe(true);
    expect(expectOk(res)).toEqual({ path: "data", outcome: "already-present" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.summary).toBe("Directory already present: data");
  });

  it('reports outcome "already-present" for a pre-existing directory created out of band', async () => {
    mkdirSync(join(root, "preexisting"));
    const res = await tool.handler({ path: "preexisting" });
    expect(expectOk(res)).toEqual({
      path: "preexisting",
      outcome: "already-present",
    });
  });

  it("errors when a path component is an existing file", async () => {
    writeFileSync(join(root, "afile"), "x");
    const res = await tool.handler({ path: "afile/child" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.message).toBeTruthy();
    expect(existsSync(join(root, "afile/child"))).toBe(false);
  });

  it("errors when the target itself is an existing file", async () => {
    writeFileSync(join(root, "notadir"), "x");
    const res = await tool.handler({ path: "notadir" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.message).toMatch(/not a directory/i);
  });

  it("rejects absolute paths without creating anything", async () => {
    const outside = makeTmpDir("create-dir-outside-");
    const res = await tool.handler({ path: join(outside, "evil") });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.message).toMatch(/absolute/i);
    expect(existsSync(join(outside, "evil"))).toBe(false);
  });

  it("rejects `..` escapes that resolve outside the workspace", async () => {
    const res = await tool.handler({ path: "../escape" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.message).toMatch(/escapes the workspace/i);
  });

  it("rejects an escape via a symlinked parent that points outside the workspace", async () => {
    const outside = makeTmpDir("create-dir-symlink-outside-");
    symlinkSync(outside, join(root, "link"));
    const res = await tool.handler({ path: "link/evil" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.message).toMatch(/escapes the workspace/i);
    expect(existsSync(join(outside, "evil"))).toBe(false);
  });

  it('treats "." as the workspace root and is a no-op', async () => {
    const res = await tool.handler({ path: "." });
    expect(expectOk(res)).toEqual({ path: ".", outcome: "already-present" });
  });

  describe("derivePermissionRequest", () => {
    it("derives a write request on the resolved in-workspace absolute path", () => {
      const req = tool.derivePermissionRequest?.({ path: "a/b" });
      expect(req?.permissionKind).toBe("write");
      expect(req?.path).toBe(join(root, "a/b"));
    });

    it("derives a write request on the (out-of-workspace) absolute target so it does not auto-approve", () => {
      const outside = makeTmpDir("create-dir-derive-outside-");
      const req = tool.derivePermissionRequest?.({ path: join(outside, "x") });
      expect(req?.permissionKind).toBe("write");
      // Resolved to the literal out-of-workspace path -> won't match the
      // in-workspace fs-write seed, so the permission layer prompts.
      expect(req?.path).toBe(join(outside, "x"));
    });

    it("returns null for invalid args so the gateway falls back to its default request", () => {
      expect(tool.derivePermissionRequest?.({})).toBeNull();
    });
  });
});
