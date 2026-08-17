import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setupLocalEnv } from "../helpers/env";
import { makeTmpDir } from "../helpers/tmp";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(
  cwd: string,
  file: string,
  contents: string,
  message: string,
): void {
  writeFileSync(join(cwd, file), contents);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
}

function committedRepository(): string {
  const source = makeTmpDir("portal-integration-source-");
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.name", "Portal Test"]);
  git(source, ["config", "user.email", "portal-test@localhost"]);
  commit(source, "README.md", "base\n", "initial");
  return source;
}

async function service() {
  return import("../../src/lib/server/worktree-integration");
}

describe("worktree integration", () => {
  let dataDir: string;
  let source: string;

  beforeEach(async () => {
    dataDir = await setupLocalEnv("portal-worktree-integration-");
    process.env.WORKTREE_ROOT = join(dataDir, "managed-worktrees");
    const { resetConfigForTests } = await import("../../src/lib/server/config");
    resetConfigForTests();
    source = committedRepository();
  });

  async function worktree(conversationId = "01CONV"): Promise<string> {
    const { createManagedWorktree } =
      await import("../../src/lib/server/worktrees");
    const metadata = await createManagedWorktree({
      sourceWorkdir: source,
      userId: "user-1",
      conversationId,
    });
    return metadata.path;
  }

  describe("worktreeIntegrationStatus", () => {
    it("reports the main checkout as not a linked worktree and never unmerged", async () => {
      const { worktreeIntegrationStatus } = await service();
      const status = await worktreeIntegrationStatus(source);
      expect(status.isLinkedWorktree).toBe(false);
      expect(status.branch).toBe("main");
      expect(status.upstreamBranch).toBe("main");
      expect(status.unmerged).toBe(false);
    });

    it("reports a fresh worktree as clean, level with upstream, and merged", async () => {
      const path = await worktree();
      const { worktreeIntegrationStatus } = await service();
      const status = await worktreeIntegrationStatus(path);
      expect(status.isLinkedWorktree).toBe(true);
      expect(status.branch).toBe("portal/01CONV");
      expect(status.upstreamPath).toBe(source);
      expect(status.upstreamBranch).toBe("main");
      expect(status).toMatchObject({
        ahead: 0,
        behind: 0,
        dirtyCount: 0,
        unmerged: false,
      });
    });

    it("counts ahead/behind independently and flags unmerged commits", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { worktreeIntegrationStatus } = await service();
      const status = await worktreeIntegrationStatus(path);
      expect(status).toMatchObject({ ahead: 1, behind: 1, unmerged: true });
    });

    // Uncommitted work is "unmerged" too: it is work the source branch does
    // not have, and deleting the worktree would be the point it is lost.
    it("flags uncommitted changes as unmerged even with no commits", async () => {
      const path = await worktree();
      writeFileSync(join(path, "scratch.txt"), "wip\n");
      const { worktreeIntegrationStatus } = await service();
      const status = await worktreeIntegrationStatus(path);
      expect(status).toMatchObject({ ahead: 0, dirtyCount: 1, unmerged: true });
    });

    it("rejects a non-repository", async () => {
      const { worktreeIntegrationStatus } = await service();
      await expect(
        worktreeIntegrationStatus(makeTmpDir("portal-plain-")),
      ).rejects.toMatchObject({
        code: "not_git_repository",
      });
    });
  });

  describe("listWorktrees", () => {
    it("reports a plain repository as a single main worktree", async () => {
      const { listWorktrees } = await service();
      const result = await listWorktrees(source);
      expect(result.mainPath).toBe(source);
      expect(result.currentPath).toBe(source);
      expect(result.worktrees).toHaveLength(1);
      expect(result.worktrees[0]).toMatchObject({
        path: source,
        isMain: true,
        isCurrent: true,
        branch: "main",
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        dirtyCount: null,
      });
      expect(result.worktrees[0].head).toMatch(/^[0-9a-f]{40}$/);
    });

    // Discovery is the point of this function: asked from inside a linked
    // worktree it must still see the whole repository, not just itself.
    it("sees every worktree from any of them, and marks main and current", async () => {
      const path = await worktree();
      const { listWorktrees } = await service();
      const result = await listWorktrees(path);
      expect(result.mainPath).toBe(source);
      expect(result.currentPath).toBe(path);
      expect(result.worktrees.map((w) => w.path).sort()).toEqual(
        [source, path].sort(),
      );
      expect(result.worktrees.find((w) => w.isMain)?.path).toBe(source);
      expect(result.worktrees.find((w) => w.isCurrent)?.path).toBe(path);
      expect(result.worktrees.find((w) => w.path === path)?.branch).toBe(
        "portal/01CONV",
      );
    });

    it("counts uncommitted changes only when asked", async () => {
      const path = await worktree();
      writeFileSync(join(path, "scratch.txt"), "wip\n");
      const { listWorktrees } = await service();
      const without = await listWorktrees(source);
      expect(without.worktrees.every((w) => w.dirtyCount === null)).toBe(true);
      const withDirty = await listWorktrees(source, { includeDirty: true });
      expect(withDirty.worktrees.find((w) => w.path === path)?.dirtyCount).toBe(
        1,
      );
      expect(withDirty.worktrees.find((w) => w.isMain)?.dirtyCount).toBe(0);
    });

    it("reports detached, locked, and prunable worktrees", async () => {
      const detached = join(makeTmpDir("portal-detached-"), "wt");
      git(source, ["worktree", "add", "--detach", "-q", detached, "HEAD"]);
      const locked = join(makeTmpDir("portal-locked-"), "wt");
      git(source, ["worktree", "add", "-q", "-b", "locked-branch", locked]);
      git(source, ["worktree", "lock", "--reason", "held for review", locked]);
      const detachedPath = realpathSync(detached);
      const lockedPath = realpathSync(locked);

      const { listWorktrees } = await service();
      const result = await listWorktrees(source);
      const detachedEntry = result.worktrees.find(
        (w) => w.path === detachedPath,
      );
      expect(detachedEntry).toMatchObject({
        detached: true,
        branch: null,
        locked: false,
      });
      const lockedEntry = result.worktrees.find((w) => w.path === lockedPath);
      expect(lockedEntry).toMatchObject({
        locked: true,
        lockedReason: "held for review",
        branch: "locked-branch",
      });

      // A worktree whose directory is gone is still a record git knows about;
      // it must be listed (and flagged) rather than crashing the read.
      rmSync(detached, { recursive: true, force: true });
      const afterRemoval = await listWorktrees(source, { includeDirty: true });
      const gone = afterRemoval.worktrees.find((w) => w.path === detachedPath);
      expect(gone?.prunable).toBe(true);
      expect(gone?.dirtyCount).toBe(null);
    });

    it("rejects a non-repository", async () => {
      const { listWorktrees } = await service();
      await expect(
        listWorktrees(makeTmpDir("portal-plain-")),
      ).rejects.toMatchObject({
        code: "not_git_repository",
      });
    });
  });

  describe("mergeWorktree to-source", () => {
    it("fast-forwards the source checkout and clears the unmerged flag", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, { direction: "to-source" });

      expect(result).toMatchObject({
        merged: true,
        fastForward: true,
        into: "main",
      });
      expect(readFileSync(join(source, "feature.txt"), "utf8")).toBe("work\n");
      expect(result.status.unmerged).toBe(false);
      expect(result.status.ahead).toBe(0);
    });

    it("is a no-op when there is nothing to integrate", async () => {
      const path = await worktree();
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, { direction: "to-source" });
      expect(result.merged).toBe(false);
    });

    it("refuses when the worktree has uncommitted changes", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      writeFileSync(join(path, "scratch.txt"), "wip\n");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, { direction: "to-source" }),
      ).rejects.toMatchObject({
        code: "worktree_dirty",
      });
    });

    it("refuses when the source checkout has uncommitted changes", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      writeFileSync(join(source, "README.md"), "edited in place\n");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, { direction: "to-source" }),
      ).rejects.toMatchObject({
        code: "upstream_dirty",
      });
      expect(readFileSync(join(source, "README.md"), "utf8")).toBe(
        "edited in place\n",
      );
    });

    it("refuses a non-fast-forward integration and points at the sync direction", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, { direction: "to-source" }),
      ).rejects.toMatchObject({
        code: "not_fast_forwardable",
        detail: { ahead: 1, behind: 1 },
      });
    });

    it("creates a merge commit when explicitly allowed", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, {
        direction: "to-source",
        allowMergeCommit: true,
      });
      expect(result).toMatchObject({ merged: true, fastForward: false });
      expect(readFileSync(join(source, "feature.txt"), "utf8")).toBe("work\n");
      expect(readFileSync(join(source, "upstream.txt"), "utf8")).toBe(
        "moved on\n",
      );
    });

    // The shared checkout must never be left mid-merge, whatever onConflict says.
    it("rolls the source checkout back on conflict", async () => {
      const path = await worktree();
      commit(path, "README.md", "from worktree\n", "worktree edit");
      commit(source, "README.md", "from source\n", "source edit");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, {
          direction: "to-source",
          allowMergeCommit: true,
          onConflict: "keep",
        }),
      ).rejects.toMatchObject({
        code: "merge_conflict",
        detail: { conflicts: ["README.md"] },
      });
      expect(readFileSync(join(source, "README.md"), "utf8")).toBe(
        "from source\n",
      );
      expect(git(source, ["status", "--porcelain=v1"])).toBe("");
    });

    it("refuses when run against the main checkout", async () => {
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(source, { direction: "to-source" }),
      ).rejects.toMatchObject({
        code: "not_a_worktree",
      });
    });
  });

  describe("mergeWorktree to-source with squash", () => {
    /** Subjects of `branch`'s commits, newest first. */
    function subjects(cwd: string, ref = "HEAD"): string[] {
      return git(cwd, ["log", "--format=%s", ref]).split("\n").filter(Boolean);
    }

    it("collapses the branch into one commit and fast-forwards the source", async () => {
      const path = await worktree();
      commit(path, "a.txt", "one\n", "wip 1");
      commit(path, "b.txt", "two\n", "wip 2");
      commit(path, "c.txt", "three\n", "wip 3");
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, {
        direction: "to-source",
        squash: { subject: "Land the feature" },
      });

      expect(result).toMatchObject({
        merged: true,
        fastForward: true,
        squashedCommits: 3,
      });
      expect(subjects(source)).toEqual(["Land the feature", "initial"]);
      for (const [file, contents] of [
        ["a.txt", "one\n"],
        ["b.txt", "two\n"],
        ["c.txt", "three\n"],
      ]) {
        expect(readFileSync(join(source, file!), "utf8")).toBe(contents);
      }
      // The branch ref moved WITH the squash (rather than being left behind by
      // a `merge --squash`), so the worktree reads as fully merged afterwards.
      expect(result.status).toMatchObject({
        ahead: 0,
        behind: 0,
        unmerged: false,
      });
    });

    it("writes the caller’s body and trailers into the squashed commit", async () => {
      const path = await worktree();
      commit(path, "a.txt", "one\n", "wip 1");
      const { mergeWorktree } = await service();
      await mergeWorktree(path, {
        direction: "to-source",
        squash: {
          subject: "Land the feature",
          body: "Why it was done.",
          trailers: [
            { token: "Co-authored-by", value: "Someone <someone@localhost>" },
          ],
        },
      });
      expect(git(source, ["log", "-1", "--format=%B"])).toBe(
        "Land the feature\n\nWhy it was done.\n\nCo-authored-by: Someone <someone@localhost>",
      );
    });

    // The whole point: a sync leaves a merge commit inside the worktree, and
    // squashing onto the source's TIP (not the merge base) is what keeps it
    // from surfacing in the source's history.
    it("absorbs a from-source merge commit, leaving the source linear", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { mergeWorktree } = await service();
      await mergeWorktree(path, { direction: "from-source" });
      const result = await mergeWorktree(path, {
        direction: "to-source",
        squash: { subject: "Land the feature" },
      });

      expect(result).toMatchObject({
        merged: true,
        fastForward: true,
        squashedCommits: 2,
      });
      expect(git(source, ["rev-list", "--merges", "HEAD"])).toBe("");
      expect(subjects(source)).toEqual([
        "Land the feature",
        "upstream commit",
        "initial",
      ]);
      expect(readFileSync(join(source, "feature.txt"), "utf8")).toBe("work\n");
      expect(readFileSync(join(source, "upstream.txt"), "utf8")).toBe(
        "moved on\n",
      );
    });

    // Squashing onto a tip this branch has not seen would commit a tree that
    // silently reverts the source's own commits.
    it("refuses to squash while behind the source, leaving the branch untouched", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const head = git(path, ["rev-parse", "HEAD"]);
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, {
          direction: "to-source",
          squash: { subject: "Land it" },
        }),
      ).rejects.toMatchObject({
        code: "squash_behind_source",
        detail: { ahead: 1, behind: 1 },
      });
      expect(git(path, ["rev-parse", "HEAD"])).toBe(head);
    });

    // Even with allowMergeCommit, which would otherwise permit the merge.
    it("refuses to squash while behind even when a merge commit is allowed", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, {
          direction: "to-source",
          allowMergeCommit: true,
          squash: { subject: "Land it" },
        }),
      ).rejects.toMatchObject({ code: "squash_behind_source" });
    });

    it("fast-forwards rather than making a merge commit when both options are set", async () => {
      const path = await worktree();
      commit(path, "a.txt", "one\n", "wip 1");
      commit(path, "b.txt", "two\n", "wip 2");
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, {
        direction: "to-source",
        allowMergeCommit: true,
        squash: { subject: "Land the feature" },
      });
      expect(result).toMatchObject({
        merged: true,
        fastForward: true,
        squashedCommits: 2,
      });
      expect(subjects(source)).toEqual(["Land the feature", "initial"]);
    });

    it("refuses a dirty worktree before rewriting anything", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      writeFileSync(join(path, "scratch.txt"), "wip\n");
      const head = git(path, ["rev-parse", "HEAD"]);
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, {
          direction: "to-source",
          squash: { subject: "Land it" },
        }),
      ).rejects.toMatchObject({ code: "worktree_dirty" });
      expect(git(path, ["rev-parse", "HEAD"])).toBe(head);
      expect(subjects(path)).toEqual(["worktree commit", "initial"]);
    });

    it("is a no-op with nothing to integrate, and creates no empty commit", async () => {
      const path = await worktree();
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, {
        direction: "to-source",
        squash: { subject: "Land nothing" },
      });
      expect(result.merged).toBe(false);
      expect(result.squashedCommits).toBeUndefined();
      expect(subjects(path)).toEqual(["initial"]);
    });

    // Commits that cancel out have nothing to collapse; squashing them would
    // mean an empty commit, so the plain fast-forward is left to it.
    it("skips the squash when the branch’s tree already matches the source", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      git(path, ["rm", "-q", "feature.txt"]);
      git(path, ["commit", "-q", "-m", "revert it"]);
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, {
        direction: "to-source",
        squash: { subject: "Land nothing" },
      });
      expect(result).toMatchObject({ merged: true, fastForward: true });
      expect(result.squashedCommits).toBeUndefined();
      expect(subjects(source)).toEqual([
        "revert it",
        "worktree commit",
        "initial",
      ]);
    });

    it("rejects an unusable commit message without touching the branch", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      const head = git(path, ["rev-parse", "HEAD"]);
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, {
          direction: "to-source",
          squash: { subject: "two\nlines" },
        }),
      ).rejects.toMatchObject({ code: "invalid_squash_message" });
      expect(git(path, ["rev-parse", "HEAD"])).toBe(head);
    });

    it("restores the branch when the squash commit itself fails", async () => {
      const path = await worktree();
      commit(path, "a.txt", "one\n", "wip 1");
      commit(path, "b.txt", "two\n", "wip 2");
      const head = git(path, ["rev-parse", "HEAD"]);
      // Force `git commit` to fail without touching anything else: signing is
      // requested, and the "gpg" it must call always exits non-zero.
      git(source, ["config", "commit.gpgsign", "true"]);
      git(source, ["config", "gpg.program", "/bin/false"]);
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, {
          direction: "to-source",
          squash: { subject: "Land it" },
        }),
      ).rejects.toMatchObject({ code: "git_failed" });
      git(source, ["config", "--unset", "commit.gpgsign"]);
      git(source, ["config", "--unset", "gpg.program"]);

      expect(git(path, ["rev-parse", "HEAD"])).toBe(head);
      expect(subjects(path)).toEqual(["wip 2", "wip 1", "initial"]);
      expect(git(path, ["status", "--porcelain=v1"])).toBe("");
      // The source never saw the failed attempt.
      expect(subjects(source)).toEqual(["initial"]);
    });

    // The squash commit's tree is already-committed content, but its message is
    // brand new — and after the squash it is the ONLY message on the branch, so
    // it must not be the one commit that skips the repository's message policy.
    it("runs the repository’s commit-msg hook on the squashed commit", async () => {
      const path = await worktree();
      commit(path, "a.txt", "one\n", "wip 1");
      commit(path, "b.txt", "two\n", "wip 2");
      const head = git(path, ["rev-parse", "HEAD"]);
      const hook = join(source, ".git", "hooks", "commit-msg");
      writeFileSync(hook, '#!/bin/sh\ngrep -q "^OK: " "$1"\n', { mode: 0o755 });
      const { mergeWorktree } = await service();

      await expect(
        mergeWorktree(path, {
          direction: "to-source",
          squash: { subject: "nope" },
        }),
      ).rejects.toMatchObject({ code: "git_failed" });
      expect(git(path, ["rev-parse", "HEAD"])).toBe(head);
      expect(git(path, ["status", "--porcelain=v1"])).toBe("");

      const result = await mergeWorktree(path, {
        direction: "to-source",
        squash: { subject: "OK: land the feature" },
      });
      expect(result).toMatchObject({ merged: true, squashedCommits: 2 });
      expect(subjects(source)).toEqual(["OK: land the feature", "initial"]);
    });

    it("refuses to squash a from-source sync", async () => {
      const path = await worktree();
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, {
          direction: "from-source",
          squash: { subject: "Land it" },
        }),
      ).rejects.toMatchObject({ code: "squash_not_applicable" });
      expect(subjects(path)).toEqual(["initial"]);
    });
  });

  describe("mergeWorktree from-source", () => {
    it("pulls upstream commits into the worktree", async () => {
      const path = await worktree();
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { mergeWorktree } = await service();
      const result = await mergeWorktree(path, { direction: "from-source" });
      expect(result).toMatchObject({
        merged: true,
        into: "portal/01CONV",
        from: "main",
      });
      expect(readFileSync(join(path, "upstream.txt"), "utf8")).toBe(
        "moved on\n",
      );
      expect(result.status.behind).toBe(0);
    });

    it("aborts a conflicting sync by default, leaving the worktree clean", async () => {
      const path = await worktree();
      commit(path, "README.md", "from worktree\n", "worktree edit");
      commit(source, "README.md", "from source\n", "source edit");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, { direction: "from-source" }),
      ).rejects.toMatchObject({
        code: "merge_conflict",
      });
      expect(readFileSync(join(path, "README.md"), "utf8")).toBe(
        "from worktree\n",
      );
      expect(git(path, ["status", "--porcelain=v1"])).toBe("");
    });

    // The isolated tree is exactly where an agent is supposed to resolve
    // conflicts, so it may opt into keeping the conflicted state.
    it("keeps a conflicted sync in the worktree when asked", async () => {
      const path = await worktree();
      commit(path, "README.md", "from worktree\n", "worktree edit");
      commit(source, "README.md", "from source\n", "source edit");
      const { mergeWorktree } = await service();
      await expect(
        mergeWorktree(path, { direction: "from-source", onConflict: "keep" }),
      ).rejects.toMatchObject({
        code: "merge_conflict",
        detail: { conflicts: ["README.md"] },
      });
      expect(readFileSync(join(path, "README.md"), "utf8")).toContain(
        "<<<<<<<",
      );
    });

    it("unblocks a previously non-fast-forwardable integration", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      commit(source, "upstream.txt", "moved on\n", "upstream commit");
      const { mergeWorktree } = await service();
      await mergeWorktree(path, { direction: "from-source" });
      const integrated = await mergeWorktree(path, { direction: "to-source" });
      expect(integrated).toMatchObject({ merged: true, fastForward: true });
      expect(readFileSync(join(source, "feature.txt"), "utf8")).toBe("work\n");
    });
  });

  describe("repository locking", () => {
    it("reports the git common dir so merges share the worktree lock key", async () => {
      const path = await worktree();
      const { worktreeIntegrationStatus } = await service();
      const status = await worktreeIntegrationStatus(path);
      // Must match what `worktrees.ts` locks on, or the two would take
      // different keys and provide no mutual exclusion at all.
      expect(status.gitCommonDir).toBe(realpathSync(join(source, ".git")));
    });

    // Two concurrent to-source merges from different worktrees: without the
    // lock both would read `behind: 0`, and the second would fail its
    // --ff-only merge after the first advanced main.
    it("serializes concurrent merges into the same source checkout", async () => {
      const first = await worktree("01FIRST");
      const second = await worktree("01SECOND");
      commit(first, "first.txt", "one\n", "first commit");
      commit(second, "second.txt", "two\n", "second commit");

      const { mergeWorktree } = await service();
      const results = await Promise.allSettled([
        mergeWorktree(first, {
          direction: "to-source",
          allowMergeCommit: true,
        }),
        mergeWorktree(second, {
          direction: "to-source",
          allowMergeCommit: true,
        }),
      ]);

      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(readFileSync(join(source, "first.txt"), "utf8")).toBe("one\n");
      expect(readFileSync(join(source, "second.txt"), "utf8")).toBe("two\n");
      expect(git(source, ["status", "--porcelain=v1"])).toBe("");
    });

    it("serializes a merge against a concurrent worktree removal", async () => {
      const keep = await worktree("01KEEP");
      const doomed = await worktree("01DOOMED");
      commit(keep, "kept.txt", "kept\n", "keep commit");

      const { mergeWorktree } = await service();
      const { removeManagedWorktree } =
        await import("../../src/lib/server/worktrees");
      const { worktreeIntegrationStatus } = await service();
      const doomedStatus = await worktreeIntegrationStatus(doomed);

      const outcomes = await Promise.allSettled([
        mergeWorktree(keep, { direction: "to-source" }),
        removeManagedWorktree({
          sourceWorkdir: source,
          path: doomed,
          gitCommonDir: doomedStatus.gitCommonDir,
          branch: "portal/01DOOMED",
          baseSha: git(source, ["rev-parse", "HEAD"]),
        }),
      ]);

      expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(readFileSync(join(source, "kept.txt"), "utf8")).toBe("kept\n");
      expect(existsSync(doomed)).toBe(false);
    });
  });

  describe("git worktree tools", () => {
    async function tool(cwd: string, name: string) {
      const { buildGitTools } = await import("../../src/lib/server/tools/git");
      const found = buildGitTools(cwd).find((t) => t.name === name);
      if (!found) throw new Error(`missing tool ${name}`);
      return found;
    }

    it("git_worktree_status reports the worktree position", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      const result = await (
        await tool(path, "git_worktree_status")
      ).handler({});
      expect(result.ok).toBe(true);
      expect(result.ok && result.result).toMatchObject({
        isLinkedWorktree: true,
        ahead: 1,
        unmerged: true,
      });
    });

    it("git_worktree_merge integrates and returns a summary", async () => {
      const path = await worktree();
      commit(path, "feature.txt", "work\n", "worktree commit");
      const result = await (
        await tool(path, "git_worktree_merge")
      ).handler({ direction: "to-source" });
      expect(result.ok).toBe(true);
      expect(result.summary).toContain("fast-forward");
      expect(readFileSync(join(source, "feature.txt"), "utf8")).toBe("work\n");
    });

    it("git_worktree_merge squashes when asked and says so", async () => {
      const path = await worktree();
      commit(path, "a.txt", "one\n", "wip 1");
      commit(path, "b.txt", "two\n", "wip 2");
      const result = await (
        await tool(path, "git_worktree_merge")
      ).handler({
        direction: "to-source",
        squash: { subject: "Land the feature" },
      });
      expect(result.ok).toBe(true);
      expect(result.summary).toContain("squashed from 2 commit(s)");
      expect(git(source, ["log", "--format=%s"])).toBe(
        "Land the feature\ninitial",
      );
    });

    it("git_worktree_merge surfaces refusals as coded tool errors, not throws", async () => {
      const result = await (
        await tool(source, "git_worktree_merge")
      ).handler({ direction: "to-source" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "not_a_worktree" },
      });
    });

    it("git_worktree_list enumerates the repository from inside a worktree", async () => {
      const path = await worktree();
      const result = await (await tool(path, "git_worktree_list")).handler({});
      expect(result.ok).toBe(true);
      const listing =
        result.ok && (result.result as { worktrees: { path: string }[] });
      expect(listing && listing.worktrees.map((w) => w.path).sort()).toEqual(
        [source, path].sort(),
      );
    });

    it("git_worktree_list surfaces a non-repository as a coded tool error", async () => {
      const result = await (
        await tool(makeTmpDir("portal-plain-"), "git_worktree_list")
      ).handler({});
      expect(result).toMatchObject({
        ok: false,
        error: { code: "not_git_repository" },
      });
    });

    it("git_worktree_merge is always-prompt while status is not", async () => {
      const path = await worktree();
      expect((await tool(path, "git_worktree_merge")).permissionBehavior).toBe(
        "always-prompt",
      );
      expect(
        (await tool(path, "git_worktree_status")).permissionBehavior,
      ).toBeUndefined();
      expect(
        (await tool(path, "git_worktree_list")).permissionBehavior,
      ).toBeUndefined();
    });

    it("git_commit nudges toward integration only inside a worktree", async () => {
      const path = await worktree();
      writeFileSync(join(path, "feature.txt"), "work\n");
      const inWorktree = await (
        await tool(path, "git_commit")
      ).handler({ paths: "all", subject: "add feature" });
      expect(inWorktree.ok && inWorktree.followUpHint).toContain(
        "git_worktree_merge",
      );

      writeFileSync(join(source, "other.txt"), "direct\n");
      const inSource = await (
        await tool(source, "git_commit")
      ).handler({ paths: "all", subject: "direct commit" });
      expect(inSource.ok && inSource.followUpHint).not.toContain(
        "git_worktree_merge",
      );
    });
  });
});
