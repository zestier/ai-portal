// The "conflict left behind by `onConflict: "keep"`" path.
//
// A tree left mid-merge used to be a dead end for an agent: it could not be
// merged (dirty), could not be committed (`commitChanges` rejected any
// conflicted entry up front), and shell `git` is not granted, so `git add` /
// `git merge --continue` / `git merge --abort` were out of reach. These tests
// pin both ways out — resolve-then-commit, and abort — end to end.

import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as git from "../../src/lib/server/git";
import { buildGitTools } from "../../src/lib/server/tools/git";
import {
  mergeInProgressFollowUpHint,
  sequencerFollowUpHint,
  unmergedPathsFollowUpHint,
} from "../../src/lib/server/tools/follow-up-hints";

/** The named git tool, built against `cwd`. */
function gitTool(cwd: string, name: string) {
  const tool = buildGitTools(cwd).find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
}

function initRepo() {
  const tmp = mkdtempSync(join(tmpdir(), "gitmerge-"));
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: tmp, stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "T"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(tmp, "a.txt"), "one\n");
  writeFileSync(join(tmp, "b.txt"), "two\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return { tmp, run };
}

/**
 * Leave `tmp` exactly where `worktree_merge { onConflict: "keep" }` leaves a
 * lease: mid-merge, with `a.txt` conflicted and `c.txt` merged cleanly (so the
 * index also holds unrelated staged content, as it always does mid-merge).
 */
function conflictedRepo() {
  const { tmp, run } = initRepo();
  run(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(tmp, "a.txt"), "one\nfeature\n");
  writeFileSync(join(tmp, "c.txt"), "from feature\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "feature change"]);
  run(["checkout", "-q", "main"]);
  writeFileSync(join(tmp, "a.txt"), "one\nmain\n");
  run(["commit", "-q", "-am", "main change"]);
  const preMergeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp })
    .toString()
    .trim();
  let conflicted = false;
  try {
    run(["merge", "--no-edit", "feature"]);
  } catch {
    conflicted = true;
  }
  expect(conflicted).toBe(true);
  return { tmp, run, preMergeSha };
}

function resolve(tmp: string, content = "one\nresolved\n") {
  writeFileSync(join(tmp, "a.txt"), content);
}

function porcelain(tmp: string) {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: tmp,
  }).toString();
}

describe("mergeState", () => {
  it("reports an in-progress merge and its conflicted paths", async () => {
    const { tmp } = conflictedRepo();
    try {
      const state = await git.mergeState(tmp);
      expect(state.inProgress).toBe(true);
      expect(state.mergeHeadSha).toMatch(/^[0-9a-f]{40}$/);
      expect(state.conflictedPaths).toEqual(["a.txt"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports a clean tree as not merging", async () => {
    const { tmp } = initRepo();
    try {
      expect(await git.mergeState(tmp)).toEqual({
        inProgress: false,
        mergeHeadSha: null,
        conflictedPaths: [],
        sequencer: null,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("hasConflictMarkers", () => {
  it("catches a half-cleaned conflict, not prose or heading underlines", () => {
    expect(
      git.hasConflictMarkers(
        "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\n",
      ),
    ).toBe(true);
    // The realistic botched resolution deletes only part of the block; a
    // detector that needed the whole block would wave it through.
    expect(git.hasConflictMarkers("<<<<<<< HEAD\nmine\n")).toBe(true);
    expect(git.hasConflictMarkers("kept\n>>>>>>> feature\n")).toBe(true);
    expect(git.hasConflictMarkers("||||||| base\nold\n")).toBe(true);
    // Prose that merely mentions a marker, and a Markdown heading underline,
    // must NOT trip it — a false positive refuses a legitimate commit.
    expect(git.hasConflictMarkers("the marker <<<<<<< appears inline\n")).toBe(
      false,
    );
    expect(git.hasConflictMarkers("Title\n=======\n\nbody\n")).toBe(false);
  });
});

describe("commitChanges on a conflicted merge", () => {
  it("concludes the merge once the conflict is resolved", async () => {
    const { tmp } = conflictedRepo();
    try {
      resolve(tmp);
      const result = await git.commitChanges(tmp, {
        paths: "all",
        subject: "resolve conflict with feature",
      });

      expect(result.mergeCommit).toBe(true);
      expect(result.resolvedConflicts).toEqual(["a.txt"]);
      // Two parents, i.e. a real merge commit rather than a flattened one.
      const parents = execFileSync(
        "git",
        ["rev-list", "-1", "--parents", result.sha],
        { cwd: tmp },
      )
        .toString()
        .trim()
        .split(/\s+/);
      expect(parents).toHaveLength(3);
      // The merge is over and the tree is clean, so it is mergeable again.
      expect(await git.mergeState(tmp)).toMatchObject({
        inProgress: false,
        conflictedPaths: [],
      });
      expect(porcelain(tmp)).toBe("");
      expect(readFileSync(join(tmp, "a.txt"), "utf8")).toBe("one\nresolved\n");
      // Diffed against the FIRST parent: `<sha>^!` is not a diffable range
      // for a merge, and this is the "what did the merge bring in" view.
      expect(result.files.map((f) => f.path).sort()).toEqual([
        "a.txt",
        "c.txt",
      ]);
      expect(result.diffStat.filesChanged).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stages only the resolved conflicts, not unrelated work in the tree", async () => {
    const { tmp } = conflictedRepo();
    try {
      // Work the agent happened to do while resolving. `paths: "all"` mid-merge
      // must NOT absorb it: a merge commit that quietly swallowed unrelated
      // edits would be a worse trap than the stuck tree this path fixes.
      resolve(tmp);
      writeFileSync(join(tmp, "b.txt"), "two\nunrelated edit\n");
      writeFileSync(join(tmp, "scratch.txt"), "unrelated new file\n");

      const result = await git.commitChanges(tmp, {
        paths: "all",
        subject: "resolve only",
      });

      expect(result.files.map((f) => f.path).sort()).toEqual([
        "a.txt",
        "c.txt",
      ]);
      expect(result.remainingDirtyFiles.map((f) => f.path).sort()).toEqual([
        "b.txt",
        "scratch.txt",
      ]);
      expect(porcelain(tmp)).toBe(" M b.txt\n?? scratch.txt\n");
      // And the leftovers are still committable afterwards, as an ordinary commit.
      const after = await git.commitChanges(tmp, {
        paths: "all",
        subject: "the rest",
      });
      expect(after.mergeCommit).toBe(false);
      expect(after.files.map((f) => f.path).sort()).toEqual([
        "b.txt",
        "scratch.txt",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to commit a file that still has conflict markers", async () => {
    const { tmp, preMergeSha } = conflictedRepo();
    try {
      await expect(
        git.commitChanges(tmp, { paths: "all", subject: "commit the markers" }),
      ).rejects.toThrow("unresolved conflict markers in: a.txt");

      // Crucially the failure must not consume the merge: the tree is still
      // finishable, which is the whole point of this path.
      expect(await git.mergeState(tmp)).toMatchObject({
        inProgress: true,
        conflictedPaths: ["a.txt"],
      });
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp })
          .toString()
          .trim(),
      ).toBe(preMergeSha);

      resolve(tmp);
      const result = await git.commitChanges(tmp, {
        paths: "all",
        subject: "resolved",
      });
      expect(result.mergeCommit).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("commits markers anyway when allowConflictMarkers is set", async () => {
    const { tmp } = conflictedRepo();
    try {
      const result = await git.commitChanges(tmp, {
        paths: "all",
        subject: "markers are part of the file",
        allowConflictMarkers: true,
      });
      expect(result.mergeCommit).toBe(true);
      expect(readFileSync(join(tmp, "a.txt"), "utf8")).toContain("<<<<<<<");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a partial commit while a merge is in progress", async () => {
    const { tmp } = conflictedRepo();
    try {
      resolve(tmp);
      // A merge commit cannot be partial: the index already holds every
      // cleanly-merged path (c.txt here), so naming a subset would commit
      // far more than it named.
      await expect(
        git.commitChanges(tmp, { paths: ["a.txt"], subject: "just a.txt" }),
      ).rejects.toThrow('paths: "all"');
      expect(await git.mergeState(tmp)).toMatchObject({ inProgress: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still commits when the resolution reproduces the pre-merge content", async () => {
    const { tmp } = conflictedRepo();
    try {
      // "Take ours" for every conflicting hunk. The staged diff against HEAD
      // is then empty for a.txt, but the merge commit must still be created —
      // refusing here would strand the tree mid-merge forever.
      resolve(tmp, "one\nmain\n");
      execFileSync("git", ["rm", "-q", "--cached", "c.txt"], { cwd: tmp });
      rmSync(join(tmp, "c.txt"));

      const result = await git.commitChanges(tmp, {
        paths: "all",
        subject: "take ours",
      });
      expect(result.mergeCommit).toBe(true);
      expect(result.files).toEqual([]);
      expect(await git.mergeState(tmp)).toMatchObject({ inProgress: false });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves the merge finishable when a hook rejects the commit", async () => {
    const { tmp } = conflictedRepo();
    try {
      // A rejecting pre-commit hook is the realistic mid-flight failure: the
      // index is rolled back, so the resolution must still be re-committable
      // rather than the tree being stranded half-staged.
      const hooks = join(tmp, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
      resolve(tmp);

      await expect(
        git.commitChanges(tmp, { paths: "all", subject: "rejected" }),
      ).rejects.toThrow();
      expect(await git.mergeState(tmp)).toMatchObject({
        inProgress: true,
        conflictedPaths: ["a.txt"],
      });

      writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      const result = await git.commitChanges(tmp, {
        paths: "all",
        subject: "accepted",
      });
      expect(result.mergeCommit).toBe(true);
      expect(await git.mergeState(tmp)).toMatchObject({ inProgress: false });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still rejects an empty commit when no merge is in progress", async () => {
    const { tmp } = initRepo();
    try {
      await expect(
        git.commitChanges(tmp, { paths: "all", subject: "noop" }),
      ).rejects.toThrow("no selected changes");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("abortMerge", () => {
  it("returns the tree to its pre-merge state", async () => {
    const { tmp, preMergeSha } = conflictedRepo();
    try {
      resolve(tmp, "half-resolved\n");
      const result = await git.abortMerge(tmp);
      expect(result.headSha).toBe(preMergeSha);
      expect(await git.mergeState(tmp)).toMatchObject({
        inProgress: false,
        conflictedPaths: [],
      });
      expect(porcelain(tmp)).toBe("");
      expect(readFileSync(join(tmp, "a.txt"), "utf8")).toBe("one\nmain\n");
      expect(existsSync(join(tmp, "c.txt"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses when no merge is in progress", async () => {
    const { tmp } = initRepo();
    try {
      await expect(git.abortMerge(tmp)).rejects.toThrow(
        "no merge is in progress",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("unmerged paths with no merge in progress", () => {
  /**
   * A conflicted cherry-pick: unmerged index entries and `CHERRY_PICK_HEAD`
   * rather than `MERGE_HEAD`. Git refuses every commit until the conflict is
   * resolved, so the same resolve-then-commit path has to work — but there is
   * no merge to abort and no structured `--continue`, and the guidance must not
   * pretend otherwise.
   */
  function cherryPickConflict() {
    const { tmp, run } = initRepo();
    run(["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(tmp, "a.txt"), "one\nfeature\n");
    run(["commit", "-q", "-am", "feature change"]);
    const featureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp })
      .toString()
      .trim();
    run(["checkout", "-q", "main"]);
    writeFileSync(join(tmp, "a.txt"), "one\nmain\n");
    run(["commit", "-q", "-am", "main change"]);
    let conflicted = false;
    try {
      run(["cherry-pick", featureSha]);
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
    return { tmp };
  }

  /** A conflicted `git stash pop`: unmerged entries, no merge, no sequencer. */
  function stashPopConflict() {
    const { tmp, run } = initRepo();
    writeFileSync(join(tmp, "a.txt"), "one\nstashed\n");
    run(["stash", "push", "-q"]);
    writeFileSync(join(tmp, "a.txt"), "one\ncommitted\n");
    run(["commit", "-q", "-am", "conflicting change"]);
    let conflicted = false;
    try {
      run(["stash", "pop"]);
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
    return { tmp };
  }

  it("names only the commit path when there is nothing to abort or continue", async () => {
    const { tmp } = stashPopConflict();
    try {
      const state = await git.mergeState(tmp);
      expect(state).toMatchObject({
        inProgress: false,
        sequencer: null,
        conflictedPaths: ["a.txt"],
      });

      const out = await gitTool(tmp, "git_status").handler({});
      expect(out.ok && out.followUpHint).toBe(unmergedPathsFollowUpHint());
      // Naming an abort here would send the agent at a tool that fails.
      expect(out.ok && out.followUpHint).toContain(
        "git_merge_abort does not apply",
      );
      expect(await gitTool(tmp, "git_merge_abort").handler({})).toMatchObject({
        ok: false,
        error: { code: "no_merge_in_progress" },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("admits a cherry-pick cannot be continued through the portal", async () => {
    const { tmp } = cherryPickConflict();
    try {
      expect(await git.mergeState(tmp)).toMatchObject({
        inProgress: false,
        sequencer: "cherry-pick",
        conflictedPaths: ["a.txt"],
      });

      const out = await gitTool(tmp, "git_status").handler({});
      expect(out.ok && out.followUpHint).toBe(
        sequencerFollowUpHint("cherry-pick"),
      );
      // The ticket forbids claiming a capability the surface lacks: the hint
      // has to say the commit does not advance the operation.
      expect(out.ok && out.followUpHint).toContain(
        "does NOT advance the cherry-pick",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("commits the resolution as an ordinary commit", async () => {
    const { tmp } = cherryPickConflict();
    try {
      await expect(
        git.commitChanges(tmp, { paths: ["a.txt"], subject: "partial" }),
      ).rejects.toThrow('paths: "all"');
      resolve(tmp);
      const result = await git.commitChanges(tmp, {
        paths: "all",
        subject: "resolve cherry-pick",
      });
      expect(result.mergeCommit).toBe(false);
      expect(result.resolvedConflicts).toEqual(["a.txt"]);
      expect(porcelain(tmp)).toBe("");
      // A single-commit cherry-pick really is finished: the marker git uses
      // to track it is gone, so nothing is left half-applied.
      expect(existsSync(join(tmp, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
      expect(await git.mergeState(tmp)).toMatchObject({
        conflictedPaths: [],
        sequencer: null,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("merge-aware git tools", () => {
  it("git_status reports the merge and points at the way out", async () => {
    const { tmp } = conflictedRepo();
    try {
      const tool = buildGitTools(tmp).find((t) => t.name === "git_status");
      const out = await tool!.handler({});
      expect(out.ok).toBe(true);
      expect(
        out.ok && (out.result as { merge: git.MergeState }).merge,
      ).toMatchObject({
        inProgress: true,
        conflictedPaths: ["a.txt"],
      });
      expect(out.ok && out.followUpHint).toBe(mergeInProgressFollowUpHint());
      expect(out.ok && out.followUpHint).toContain("git_merge_abort");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("git_status omits the hint on a clean tree", async () => {
    const { tmp } = initRepo();
    try {
      const tool = buildGitTools(tmp).find((t) => t.name === "git_status");
      const out = await tool!.handler({});
      expect(out.ok && out.followUpHint).toBeUndefined();
      expect(
        out.ok && (out.result as { merge: git.MergeState }).merge.inProgress,
      ).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("git_merge_abort is an always-prompt tool that clears the merge", async () => {
    const { tmp, preMergeSha } = conflictedRepo();
    try {
      const tool = buildGitTools(tmp).find((t) => t.name === "git_merge_abort");
      expect(tool?.permissionBehavior).toBe("always-prompt");
      const out = await tool!.handler({});
      expect(out.ok).toBe(true);
      expect(out.ok && (out.result as { headSha: string }).headSha).toBe(
        preMergeSha,
      );
      expect(await git.mergeState(tmp)).toMatchObject({ inProgress: false });

      // Second call has nothing to abort and says so structurally rather
      // than throwing.
      const again = await tool!.handler({});
      expect(again.ok).toBe(false);
      expect(!again.ok && again.error.code).toBe("no_merge_in_progress");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("git_merge_abort rejects unknown properties", async () => {
    const tool = buildGitTools(
      mkdtempSync(join(tmpdir(), "gitmerge-args-")),
    ).find((t) => t.name === "git_merge_abort");
    await expect(tool!.handler({ hard: true })).rejects.toThrow(
      "Unrecognized key",
    );
  });

  it("git_commit concludes a merge through the tool surface", async () => {
    const { tmp } = conflictedRepo();
    try {
      const tool = buildGitTools(tmp).find((t) => t.name === "git_commit");
      const blocked = await tool!
        .handler({ paths: "all", subject: "unresolved" })
        .catch((e: unknown) => e);
      expect(String(blocked)).toContain("unresolved conflict markers");

      resolve(tmp);
      const out = await tool!.handler({
        paths: "all",
        subject: "resolve conflict",
      });
      expect(out.ok).toBe(true);
      expect(
        out.ok && (out.result as { mergeCommit: boolean }).mergeCommit,
      ).toBe(true);
      expect(await git.mergeState(tmp)).toMatchObject({ inProgress: false });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
