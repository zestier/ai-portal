// The filesystem tools must be able to act inside a worktree lease.
//
// They are workspace-relative by design (absolute paths and `..` escapes are
// rejected), so before the `worktree` selector existed a sub-agent handed a
// lease path — the pattern PORTAL_SYSTEM_GUIDANCE prescribes — could not
// mkdir, move, or delete there at all, and shell `mkdir`/`mv`/`rm` are not a
// fallback under `best-effort`. These tests pin the selector: it resolves to the
// lease's checkout, it refuses a lease this conversation does not hold, and the
// permission request it derives names the path in the LEASE rather than a
// same-named path in the conversation's own workspace.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerSingletons, setupLocalEnv } from "../../helpers/env";
import { makeTmpDir } from "../../helpers/tmp";
import { conversationId as convCodec } from "../../../src/lib/ids";
import { scratchSubdir } from "../../../src/lib/server/tools/zap-dir";
import type {
  PortalTool,
  ToolResult,
} from "../../../src/lib/server/tools/types";

const TRASH_DIR = scratchSubdir("trash");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function committedRepository(): string {
  const source = makeTmpDir("portal-fs-worktree-");
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.name", "Portal Test"]);
  git(source, ["config", "user.email", "portal-test@localhost"]);
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "initial"]);
  return source;
}

function expectOk<T = unknown>(result: ToolResult): T {
  if (!result.ok)
    throw new Error(`expected ok, got error: ${result.error.message}`);
  return result.result as T;
}

function expectErr(result: ToolResult): { message: string; code?: string } {
  if (result.ok) throw new Error("expected error, got ok");
  return result.error;
}

describe("filesystem tools inside a worktree lease", () => {
  let source: string;
  let userId: number;
  let conversationId: number;
  let leasePath: string;
  let leaseId: string;
  let tools: Map<string, PortalTool>;
  let newConversation: () => number;

  beforeEach(async () => {
    const dataDir = await setupLocalEnv("portal-fs-worktree-");
    source = committedRepository();
    process.env.PROJECT_ROOT = source;
    process.env.WORKTREE_ROOT = join(dataDir, "worktrees");
    await resetServerSingletons();
    vi.resetModules();

    const users = await import("../../../src/lib/server/db/repos/users");
    userId = users.ensureLocalUser().id;
    const convs =
      await import("../../../src/lib/server/db/repos/conversations");
    newConversation = () =>
      convCodec.parse(
        convs.create(userId, {
          title: "orchestrator",
          workdir: source,
          model: "test-model",
          workspaceKind: "shared",
          workspaceKey: source,
        }).id,
      );
    conversationId = newConversation();

    const { buildWorktreeTools } =
      await import("../../../src/lib/server/tools/worktree");
    const worktreeTools = new Map(
      buildWorktreeTools({ userId, conversationId }).map((t) => [t.name, t]),
    );
    const created = await worktreeTools
      .get("worktree_create")!
      .handler({ label: "api" });
    const lease = expectOk<{ leaseId: string; path: string }>(created);
    leaseId = lease.leaseId;
    leasePath = lease.path;

    const { buildCreateDirectoryTools } =
      await import("../../../src/lib/server/tools/filesystem");
    const { buildMoveTools } =
      await import("../../../src/lib/server/tools/filesystem");
    const { buildTrashTools } =
      await import("../../../src/lib/server/tools/filesystem");
    tools = new Map(
      [
        ...buildCreateDirectoryTools(source, { userId, conversationId }),
        ...buildMoveTools(source, { userId, conversationId }),
        ...buildTrashTools(source, { userId, conversationId }),
      ].map((t) => [t.name, t]),
    );
  });

  it("create_directory makes the directory in the lease, not the workspace", async () => {
    const res = await tools
      .get("create_directory")!
      .handler({ path: "pkg/sub", worktree: leaseId });

    expect(expectOk(res)).toEqual({ path: "pkg/sub", outcome: "created" });
    expect(existsSync(join(leasePath, "pkg/sub"))).toBe(true);
    expect(existsSync(join(source, "pkg/sub"))).toBe(false);
  });

  it("move renames inside the lease", async () => {
    writeFileSync(join(leasePath, "a.txt"), "hello");

    const res = await tools.get("move")!.handler({
      source: "a.txt",
      destination: "nested/b.txt",
      worktree: leaseId,
    });

    expect(expectOk(res)).toMatchObject({
      source: "a.txt",
      destination: "nested/b.txt",
    });
    expect(existsSync(join(leasePath, "a.txt"))).toBe(false);
    expect(readFileSync(join(leasePath, "nested/b.txt"), "utf-8")).toBe(
      "hello",
    );
  });

  // The entry lands in the LEASE's own trash store, so the deletion stays
  // reversible from inside the tree it belongs to instead of being scattered
  // into the orchestrator's workspace.
  it("trash buries the file in the lease’s own trash store", async () => {
    writeFileSync(join(leasePath, "doomed.txt"), "bye");

    const res = await tools
      .get("trash")!
      .handler({ path: "doomed.txt", worktree: leaseId });

    const payload = expectOk<{
      originalPath: string;
      entryId: string;
      trashPath: string;
    }>(res);
    expect(payload.originalPath).toBe("doomed.txt");
    expect(existsSync(join(leasePath, "doomed.txt"))).toBe(false);
    expect(readFileSync(join(leasePath, payload.trashPath), "utf-8")).toBe(
      "bye",
    );
    const meta = JSON.parse(
      readFileSync(
        join(leasePath, TRASH_DIR, payload.entryId, "meta.json"),
        "utf-8",
      ),
    );
    expect(meta).toMatchObject({
      originalPath: "doomed.txt",
      name: "doomed.txt",
      type: "file",
    });
    // Nothing was written into the conversation's own workspace.
    expect(existsSync(join(source, TRASH_DIR))).toBe(false);
  });

  it("trash still refuses to bury the lease’s trash store itself", async () => {
    mkdirSync(join(leasePath, TRASH_DIR), { recursive: true });

    const res = await tools
      .get("trash")!
      .handler({ path: TRASH_DIR, worktree: leaseId });

    expect(expectErr(res).message).toBe(
      "refusing to trash the trash store itself",
    );
  });

  it("still escapes are rejected relative to the lease root", async () => {
    const res = await tools
      .get("create_directory")!
      .handler({ path: "../escape", worktree: leaseId });

    expect(expectErr(res).message).toContain("escapes the workspace");
    expect(existsSync(join(leasePath, "..", "escape"))).toBe(false);
  });

  // The held-by-this-conversation check is what keeps the selector from being a
  // way to write into an arbitrary path.
  it("refuses a lease held by another conversation", async () => {
    const { buildTrashTools } =
      await import("../../../src/lib/server/tools/filesystem");
    const otherContext = { userId, conversationId: newConversation() };
    const otherTools = new Map(
      [...buildTrashTools(source, otherContext)].map((t) => [t.name, t]),
    );

    const res = await otherTools
      .get("trash")!
      .handler({ path: "README.md", worktree: leaseId });

    expect(expectErr(res).code).toBe("lease_not_found");
    expect(existsSync(join(leasePath, "README.md"))).toBe(true);
  });

  // Without session context the selector is rejected rather than silently
  // ignored — acting on the conversation's own workspace instead would delete
  // the wrong file.
  it("rejects the selector when the session has no context", async () => {
    const { buildTrashTools } =
      await import("../../../src/lib/server/tools/filesystem");
    const bare = new Map(buildTrashTools(source).map((t) => [t.name, t]));

    const res = await bare
      .get("trash")!
      .handler({ path: "README.md", worktree: leaseId });

    expect(expectErr(res).code).toBe("worktree_unavailable");
  });

  describe("derived permission request", () => {
    it("names the path inside the lease", () => {
      const req = tools.get("create_directory")!.derivePermissionRequest!({
        path: "pkg",
        worktree: leaseId,
      });

      expect(req).toEqual({
        permissionKind: "write",
        path: join(leasePath, "pkg"),
      });
    });

    it("gates both move endpoints inside the lease", () => {
      const req = tools.get("move")!.derivePermissionRequest!({
        source: "a.txt",
        destination: "b.txt",
        worktree: leaseId,
      });

      expect(req).toEqual({
        permissionKind: "write",
        path: join(leasePath, "a.txt"),
        additionalPaths: [join(leasePath, "b.txt")],
      });
    });

    // Fail closed: an unresolvable selector must NOT fall back to deriving a
    // path in the conversation's own workspace, which the fs-write seed would
    // auto-approve while describing a target the handler never touches.
    // Returning null makes the gateway raise its default custom-tool prompt.
    it("returns null for a lease this conversation does not hold", async () => {
      const { buildTrashTools } =
        await import("../../../src/lib/server/tools/filesystem");
      const otherTools = new Map(
        buildTrashTools(source, {
          userId,
          conversationId: newConversation(),
        }).map((t) => [t.name, t]),
      );

      const req = otherTools.get("trash")!.derivePermissionRequest!({
        path: "README.md",
        worktree: leaseId,
      });

      expect(req).toBeNull();
    });

    it("still derives against the workspace when no lease is selected", () => {
      const req = tools.get("trash")!.derivePermissionRequest!({
        path: "README.md",
      });

      expect(req).toEqual({
        permissionKind: "write",
        path: join(source, "README.md"),
      });
    });
  });
});
