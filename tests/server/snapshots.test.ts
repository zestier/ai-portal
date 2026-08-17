import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setupLocalEnv } from "../helpers/env";
import { makeTmpDir } from "../helpers/tmp";

async function freshImports() {
  const users = await import("../../src/lib/server/db/repos/users");
  const convs = await import("../../src/lib/server/db/repos/conversations");
  const messages = await import("../../src/lib/server/db/repos/messages");
  const snapshots = await import("../../src/lib/server/snapshots");
  return { users, convs, messages, snapshots };
}

function initGitRepo(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
}

function requireSnapshot<T>(row: T | null): T {
  if (row === null) throw new Error("expected snapshot row");
  return row;
}

describe("snapshots", () => {
  let workdir: string;

  beforeEach(async () => {
    await setupLocalEnv("portal-snap-test-");
    workdir = makeTmpDir("portal-snap-wd-");
  });

  it("skips snapshots outside a git repo without initialising one", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const c = convs.create(u.id, { title: "t", workdir, model: null });
    const m = messages.append(c.id, { role: "user", content: "hi" });

    writeFileSync(join(workdir, "a.txt"), "one\n");
    const row = await snapshots.snapshot(workdir, m.id, "pre");

    expect(row).toBeNull();
    expect(existsSync(join(workdir, ".git"))).toBe(false);
    expect(snapshots.getSnapshot(m.id, "pre")).toBeNull();
  });

  it("skips snapshots for subdirectories of a parent git repo", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const parent = makeTmpDir("portal-snap-parent-");
    const child = join(parent, "chat");
    initGitRepo(parent);
    mkdirSync(child);
    const c = convs.create(u.id, { title: "t", workdir: child, model: null });
    const m = messages.append(c.id, { role: "user", content: "hi" });

    writeFileSync(join(child, "a.txt"), "one\n");
    const row = await snapshots.snapshot(child, m.id, "pre");
    const refs = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/portal/turns"],
      {
        cwd: parent,
      },
    ).toString();

    expect(row).toBeNull();
    expect(refs.trim()).toBe("");
    expect(existsSync(join(child, ".git"))).toBe(false);
  });

  it("binds snapshots in an existing git repo to a private ref", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const c = convs.create(u.id, { title: "t", workdir, model: null });
    const m = messages.append(c.id, { role: "user", content: "hi" });

    initGitRepo(workdir);
    writeFileSync(join(workdir, "a.txt"), "one\n");
    const row = requireSnapshot(await snapshots.snapshot(workdir, m.id, "pre"));

    expect(row.messageId).toBe(m.id);
    expect(row.kind).toBe("pre");
    expect(row.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(row.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(row.gitRef).toBe(`refs/portal/turns/pre/${m.id}`);
    // The ref must actually exist in the repo.
    const refSha = execFileSync("git", ["rev-parse", row.gitRef], {
      cwd: workdir,
    })
      .toString()
      .trim();
    expect(refSha).toBe(row.commitSha);
  });

  it("returns the existing row when snapshotting the same (messageId, kind) twice", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const c = convs.create(u.id, { title: "t", workdir, model: null });
    const m = messages.append(c.id, { role: "user", content: "hi" });

    initGitRepo(workdir);
    writeFileSync(join(workdir, "a.txt"), "one\n");
    const r1 = requireSnapshot(await snapshots.snapshot(workdir, m.id, "pre"));
    writeFileSync(join(workdir, "a.txt"), "two\n");
    const r2 = requireSnapshot(await snapshots.snapshot(workdir, m.id, "pre"));
    // Same row returned; the second snapshot is a no-op even though
    // the worktree changed.
    expect(r2.commitSha).toBe(r1.commitSha);
    expect(r2.treeSha).toBe(r1.treeSha);
  });

  it("dedupes tree SHA when content is identical across messages", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const c = convs.create(u.id, { title: "t", workdir, model: null });
    const m1 = messages.append(c.id, { role: "user", content: "a" });
    const m2 = messages.append(c.id, { role: "user", content: "b" });

    initGitRepo(workdir);
    writeFileSync(join(workdir, "a.txt"), "same\n");
    const r1 = requireSnapshot(await snapshots.snapshot(workdir, m1.id, "pre"));
    const r2 = requireSnapshot(await snapshots.snapshot(workdir, m2.id, "pre"));
    expect(r1.treeSha).toBe(r2.treeSha);
    // Commits differ (different message in subject line).
    expect(r1.commitSha).not.toBe(r2.commitSha);
  });

  it("captures untracked files in the snapshot tree", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const c = convs.create(u.id, { title: "t", workdir, model: null });
    const m = messages.append(c.id, { role: "user", content: "hi" });

    initGitRepo(workdir);
    mkdirSync(join(workdir, "sub"));
    writeFileSync(join(workdir, "sub", "new.txt"), "untracked\n");
    const row = requireSnapshot(await snapshots.snapshot(workdir, m.id, "pre"));
    const out = execFileSync("git", ["ls-tree", "-r", row.commitSha], {
      cwd: workdir,
    }).toString();
    expect(out).toContain("sub/new.txt");
  });

  it("materializeFromCommit reproduces the exact worktree in a new dir", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const c = convs.create(u.id, { title: "t", workdir, model: null });
    const m = messages.append(c.id, { role: "user", content: "hi" });

    initGitRepo(workdir);
    writeFileSync(join(workdir, "a.txt"), "hello\n");
    mkdirSync(join(workdir, "d"));
    writeFileSync(join(workdir, "d", "b.txt"), "world\n");
    const row = requireSnapshot(await snapshots.snapshot(workdir, m.id, "pre"));

    // Mutate the source after the snapshot.
    writeFileSync(join(workdir, "a.txt"), "changed\n");
    rmSync(join(workdir, "d"), { recursive: true });
    writeFileSync(join(workdir, "late.txt"), "late\n");

    const dst = mkdtempSync(join(tmpdir(), "portal-snap-dst-"));
    rmSync(dst, { recursive: true });
    await snapshots.materializeFromCommit(workdir, row.commitSha, dst);
    expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(dst, "d", "b.txt"), "utf8")).toBe("world\n");
    expect(existsSync(join(dst, "late.txt"))).toBe(false);
  });

  it("rolls back the git ref when the metadata INSERT fails", async () => {
    const { users, convs, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    // Intentionally do NOT create a message row. The git ref name only
    // requires a syntactically valid id, but the turn_snapshots row has
    // a FK to messages(id) (foreign_keys = ON), so the INSERT will fail
    // after the ref has been created — exercising the cleanup path.
    convs.create(u.id, { title: "t", workdir, model: null });
    const orphanId = 999999;

    initGitRepo(workdir);
    writeFileSync(join(workdir, "a.txt"), "one\n");

    await expect(
      snapshots.snapshot(workdir, orphanId, "pre"),
    ).rejects.toThrow();

    // No DB row, and crucially no orphaned git ref left behind.
    expect(snapshots.getSnapshot(orphanId, "pre")).toBeNull();
    const refs = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/portal/turns"],
      {
        cwd: workdir,
      },
    ).toString();
    expect(refs.trim()).toBe("");
  });

  it("does not pollute the workdir staging area", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    const c = convs.create(u.id, { title: "t", workdir, model: null });
    const m = messages.append(c.id, { role: "user", content: "hi" });

    initGitRepo(workdir);
    writeFileSync(join(workdir, "a.txt"), "one\n");
    await snapshots.snapshot(workdir, m.id, "pre");
    // The user's normal index should still be empty (no `git add` ran
    // against it).
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: workdir,
    }).toString();
    expect(staged.trim()).toBe("");
  });

  it("snapshots a linked worktree without touching its normal index", async () => {
    const { users, convs, messages, snapshots } = await freshImports();
    const u = users.ensureLocalUser();
    initGitRepo(workdir);
    execFileSync("git", ["config", "user.name", "Portal Test"], {
      cwd: workdir,
    });
    execFileSync("git", ["config", "user.email", "portal-test@localhost"], {
      cwd: workdir,
    });
    writeFileSync(join(workdir, "a.txt"), "base\n");
    execFileSync("git", ["add", "a.txt"], { cwd: workdir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workdir });
    const linked = makeTmpDir("portal-snap-linked-");
    rmSync(linked, { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", "linked", linked, "HEAD"],
      {
        cwd: workdir,
      },
    );
    const c = convs.create(u.id, {
      title: "linked",
      workdir: linked,
      model: null,
    });
    const m = messages.append(c.id, { role: "user", content: "hi" });
    writeFileSync(join(linked, "a.txt"), "changed\n");

    const row = requireSnapshot(await snapshots.snapshot(linked, m.id, "pre"));

    expect(row.baseCommitSha).toBe(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: linked })
        .toString()
        .trim(),
    );
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: linked })
        .toString()
        .trim(),
    ).toBe("");
    expect(
      execFileSync("git", ["show", `${row.commitSha}:a.txt`], {
        cwd: linked,
      }).toString(),
    ).toBe("changed\n");
  });
});
