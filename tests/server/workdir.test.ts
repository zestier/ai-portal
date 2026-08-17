import { describe, it, expect, beforeEach } from "vitest";
import { resolve, join, sep } from "node:path";
import { writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { setupLocalEnv, resetServerSingletons } from "../helpers/env";
import { makeTmpDir } from "../helpers/tmp";

async function freshImport() {
  return await import("../../src/lib/server/workdir");
}

describe("workdir resolution", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await setupLocalEnv("portal-workdir-test-");
  });

  async function withProjectRoot(root: string, allowed?: string[]) {
    process.env.PROJECT_ROOT = root;
    if (allowed) process.env.ALLOWED_WORKDIRS = allowed.join(",");
    else delete process.env.ALLOWED_WORKDIRS;
    await resetServerSingletons();
    return freshImport();
  }

  describe("projectRoot", () => {
    it("returns the configured PROJECT_ROOT as an absolute path", async () => {
      const root = makeTmpDir("portal-proot-");
      const { projectRoot } = await withProjectRoot(root);
      expect(projectRoot()).toBe(resolve(root));
    });

    it("resolves a relative PROJECT_ROOT against cwd", async () => {
      const { projectRoot } = await withProjectRoot("some/rel/dir");
      expect(projectRoot()).toBe(resolve("some/rel/dir"));
    });
  });

  describe("effectiveWorkdir", () => {
    it("falls back to PROJECT_ROOT for empty/null/undefined stored values", async () => {
      const root = makeTmpDir("portal-proot-");
      const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
      expect(effectiveWorkdir(null)).toBe(projectRoot());
      expect(effectiveWorkdir(undefined)).toBe(projectRoot());
      expect(effectiveWorkdir("")).toBe(projectRoot());
    });

    it("returns a normalized absolute path for an allowlisted stored workdir", async () => {
      const root = makeTmpDir("portal-proot-");
      // effectiveWorkdir now also enforces the allowlist; widen it so the
      // stored value is honored rather than folded back to PROJECT_ROOT.
      const { effectiveWorkdir } = await withProjectRoot(root, [
        "/srv/projects",
      ]);
      const stored = "/srv/projects/app/.";
      expect(effectiveWorkdir(stored)).toBe(resolve(stored));
    });

    it("resolves a relative stored workdir against cwd when allowlisted", async () => {
      const root = makeTmpDir("portal-proot-");
      const { effectiveWorkdir } = await withProjectRoot(root, [process.cwd()]);
      expect(effectiveWorkdir("rel/work")).toBe(resolve("rel/work"));
    });

    it("folds a stored workdir outside the allowlist back to PROJECT_ROOT", async () => {
      const root = makeTmpDir("portal-proot-");
      // Simulates a value persisted before the allowlist existed (e.g. "/").
      // It must not become a live containment root for the file/git routes.
      const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
      expect(effectiveWorkdir("/")).toBe(projectRoot());
      expect(effectiveWorkdir("/etc")).toBe(projectRoot());
    });

    it("routes the legacy workspaces dir itself back to PROJECT_ROOT", async () => {
      const root = makeTmpDir("portal-proot-");
      const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
      const legacy = resolve(dataDir, "workspaces");
      expect(effectiveWorkdir(legacy)).toBe(projectRoot());
    });

    it("routes legacy per-conversation subdirs back to PROJECT_ROOT", async () => {
      const root = makeTmpDir("portal-proot-");
      const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
      const legacyChild = join(resolve(dataDir, "workspaces"), "conv-123");
      expect(effectiveWorkdir(legacyChild)).toBe(projectRoot());
    });

    it("does not treat a sibling that merely shares the legacy prefix as legacy", async () => {
      const root = makeTmpDir("portal-proot-");
      // `<dataDir>/workspaces-other` shares the string prefix but is not
      // inside `<dataDir>/workspaces/`, so it must be preserved — allowlist
      // it via dataDir so the legacy-prefix check is what we're exercising.
      const { effectiveWorkdir } = await withProjectRoot(root, [dataDir]);
      const sibling = resolve(dataDir, "workspaces-other");
      expect(effectiveWorkdir(sibling)).toBe(sibling);
      expect(effectiveWorkdir(sibling)).not.toBe(resolve(root));
    });
  });

  describe("resolveAndValidate", () => {
    // resolveAndValidate now enforces an allowlist (default: PROJECT_ROOT).
    // Point the allowlist at a fresh root for each case so we exercise the
    // existence / directory checks independently of containment.
    async function withAllowed(roots: string[]) {
      process.env.ALLOWED_WORKDIRS = roots.join(",");
      delete process.env.PROJECT_ROOT;
      await resetServerSingletons();
      return freshImport();
    }

    it("accepts an existing directory inside an allowed root", async () => {
      const dir = makeTmpDir("portal-valid-wd-");
      const { resolveAndValidate } = await withAllowed([dir]);
      const res = resolveAndValidate(dir);
      expect(res).toEqual({ ok: true, path: resolve(dir) });
    });

    it("accepts a subdirectory of an allowed root", async () => {
      const root = makeTmpDir("portal-valid-wd-");
      const sub = join(root, "project");
      mkdirSync(sub);
      const { resolveAndValidate } = await withAllowed([root]);
      const res = resolveAndValidate(sub);
      expect(res).toEqual({ ok: true, path: resolve(sub) });
    });

    it("normalizes traversal segments before validating", async () => {
      const dir = makeTmpDir("portal-valid-wd-");
      const { resolveAndValidate } = await withAllowed([dir]);
      const messy = join(dir, "sub", "..");
      const res = resolveAndValidate(messy);
      expect(res).toEqual({ ok: true, path: resolve(dir) });
    });

    it("rejects a path that does not exist", async () => {
      const root = makeTmpDir("portal-valid-wd-");
      const { resolveAndValidate } = await withAllowed([root]);
      const missing = join(root, "nope");
      const res = resolveAndValidate(missing);
      expect(res).toEqual({ ok: false, reason: "workdir does not exist" });
    });

    it("rejects a path that exists but is a file, not a directory", async () => {
      const dir = makeTmpDir("portal-valid-wd-");
      const { resolveAndValidate } = await withAllowed([dir]);
      const file = join(dir, "a.txt");
      writeFileSync(file, "hi\n");
      const res = resolveAndValidate(file);
      expect(res).toEqual({ ok: false, reason: "workdir is not a directory" });
    });

    it("rejects an existing directory outside every allowed root", async () => {
      const allowed = makeTmpDir("portal-allowed-wd-");
      const outside = makeTmpDir("portal-outside-wd-");
      const { resolveAndValidate } = await withAllowed([allowed]);
      const res = resolveAndValidate(outside);
      expect(res).toEqual({
        ok: false,
        reason: "workdir is not within an allowed root",
      });
    });

    it("rejects host roots like / and /etc by default", async () => {
      const root = makeTmpDir("portal-proot-");
      // Default allowlist is just PROJECT_ROOT (the temp root here).
      process.env.PROJECT_ROOT = root;
      delete process.env.ALLOWED_WORKDIRS;
      await resetServerSingletons();
      const { resolveAndValidate } = await freshImport();
      expect(resolveAndValidate("/")).toEqual({
        ok: false,
        reason: "workdir is not within an allowed root",
      });
      expect(resolveAndValidate("/etc")).toEqual({
        ok: false,
        reason: "workdir is not within an allowed root",
      });
    });

    it("honors multiple comma-separated allowed roots", async () => {
      const a = makeTmpDir("portal-allowed-a-");
      const b = makeTmpDir("portal-allowed-b-");
      const { resolveAndValidate } = await withAllowed([a, b]);
      expect(resolveAndValidate(a)).toEqual({ ok: true, path: resolve(a) });
      expect(resolveAndValidate(b)).toEqual({ ok: true, path: resolve(b) });
    });

    it("rejects a symlink inside an allowed root that escapes it", async () => {
      const allowed = makeTmpDir("portal-allowed-wd-");
      const outside = makeTmpDir("portal-outside-wd-");
      const link = join(allowed, "escape");
      symlinkSync(outside, link);
      const { resolveAndValidate } = await withAllowed([allowed]);
      // Lexically `allowed/escape` is inside the root, but its realpath is
      // the outside dir — the allowlist must reject it.
      const res = resolveAndValidate(link);
      expect(res).toEqual({
        ok: false,
        reason: "workdir is not within an allowed root",
      });
    });
  });

  describe("allowedWorkdirRoots", () => {
    it("defaults to PROJECT_ROOT when ALLOWED_WORKDIRS is unset", async () => {
      const root = makeTmpDir("portal-proot-");
      process.env.PROJECT_ROOT = root;
      delete process.env.ALLOWED_WORKDIRS;
      await resetServerSingletons();
      const { allowedWorkdirRoots } = await freshImport();
      expect(allowedWorkdirRoots()).toEqual([realpathSync(root)]);
    });
  });

  it("legacy containment is anchored at a path separator", async () => {
    // Guards the `startsWith(legacy + sep)` check: the trailing separator
    // is what prevents `workspaces-other` from being swallowed.
    const root = makeTmpDir("portal-proot-");
    const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
    const legacy = resolve(dataDir, "workspaces");
    expect(effectiveWorkdir(legacy + sep + "deep" + sep + "nested")).toBe(
      projectRoot(),
    );
  });

  it("rejects a managed worktree path redirected to a sibling checkout", async () => {
    const root = join(dataDir, "managed-worktrees");
    const sibling = join(root, "other-user", "other-conversation");
    const expected = join(root, "user-1", "conversation-1");
    mkdirSync(sibling, { recursive: true });
    mkdirSync(join(root, "user-1"), { recursive: true });
    symlinkSync(sibling, expected, "dir");
    process.env.WORKTREE_ROOT = root;
    await resetServerSingletons();
    const { resolveConversationWorkspace, WorkspaceUnavailableError } =
      await freshImport();

    expect(() =>
      resolveConversationWorkspace({
        id: "conversation-1",
        userId: "user-1",
        workdir: expected,
        workspaceKind: "managed-worktree",
      } as never),
    ).toThrow(WorkspaceUnavailableError);
  });
});
