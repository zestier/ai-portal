import { describe, it, expect } from "vitest";
import {
  gitCommitPreview,
  summarizeGitCommitPermission,
} from "../../src/lib/permissions/git-commit";

describe("gitCommitPreview", () => {
  it('treats the primitive string "all" as the all-changes sentinel', () => {
    const preview = gitCommitPreview({ subject: "wip", paths: "all" });
    expect(preview).not.toBeNull();
    expect(preview?.paths).toBeNull();
    expect(preview?.targetSummary).toBe(
      "All tracked, staged, unstaged, deleted, and untracked workspace changes" +
        " (while concluding a merge: only the conflicted files’ resolutions)",
    );
  });

  it('treats ["all"] as an explicit single-path list, not the sentinel', () => {
    const preview = gitCommitPreview({ subject: "wip", paths: ["all"] });
    expect(preview?.paths).toEqual(["all"]);
    expect(preview?.targetSummary).toBe("1 selected path");
  });

  it("does not treat coercible objects as the all-changes sentinel", () => {
    const preview = gitCommitPreview({
      subject: "wip",
      paths: { toString: () => "all" },
    });
    expect(preview?.paths).toBeNull();
    expect(preview?.targetSummary).toBe("Selected paths");
  });

  it('summarizes a non-"all" path list by count', () => {
    const preview = gitCommitPreview({
      subject: "wip",
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(preview?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(preview?.targetSummary).toBe("2 selected paths");
  });

  it("returns null for non-object payloads", () => {
    expect(gitCommitPreview("all")).toBeNull();
    expect(gitCommitPreview(["all"])).toBeNull();
  });

  describe("destination", () => {
    it("names the conversation workspace when no worktree is targeted", () => {
      const preview = gitCommitPreview({ subject: "wip", paths: "all" });
      expect(preview?.worktree).toBeNull();
      expect(preview?.destinationSummary).toBe("This conversation's workspace");
    });

    it("names the resolved lease, branch, and path", () => {
      const preview = gitCommitPreview(
        { subject: "wip", paths: "all", worktree: "lease-1" },
        {
          leaseId: "lease-1",
          label: "api",
          branch: "portal/lease/x--api",
          path: "/wt/api",
        },
      );
      expect(preview?.worktree).toMatchObject({
        leaseId: "lease-1",
        label: "api",
      });
      expect(preview?.destinationSummary).toBe(
        "worktree api on branch portal/lease/x--api",
      );
    });

    // An unresolvable id still has to be shown: the call will fail, but the
    // human must not read the dialog as "commits into my workspace".
    it("falls back to the raw id when no snapshot was resolved", () => {
      const preview = gitCommitPreview({
        subject: "wip",
        paths: "all",
        worktree: "lease-9",
      });
      expect(preview?.worktree).toEqual({ leaseId: "lease-9" });
      expect(preview?.destinationSummary).toBe("worktree lease-9");
    });

    // The tool's schema trims the selector, so the preview must too — or a
    // padded id renders as unresolved while the commit lands in a real
    // worktree.
    it("normalizes the raw id the way the tool schema does", () => {
      const preview = gitCommitPreview({
        subject: "wip",
        paths: "all",
        worktree: "  lease-9  ",
      });
      expect(preview?.worktree).toEqual({ leaseId: "lease-9" });
      expect(
        gitCommitPreview({ subject: "wip", paths: "all", worktree: "   " })
          ?.worktree,
      ).toBeNull();
    });
  });
});

describe("summarizeGitCommitPermission", () => {
  it("uses targetSummary for the all-changes sentinel", () => {
    const summary = summarizeGitCommitPermission({
      subject: "wip",
      paths: "all",
    });
    expect(summary).toContain(
      "Target: All tracked, staged, unstaged, deleted, and untracked workspace changes",
    );
  });

  it('lists explicit paths, including ["all"]', () => {
    const summary = summarizeGitCommitPermission({
      subject: "wip",
      paths: ["all"],
    });
    expect(summary).toContain("Target: 1 selected path");
    expect(summary).toContain("- all");
  });

  it("lists a multi-path selection", () => {
    const summary = summarizeGitCommitPermission({
      subject: "wip",
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(summary).toContain("Target: 2 selected paths");
    expect(summary).toContain("- src/a.ts");
    expect(summary).toContain("- src/b.ts");
  });

  // The audit row and the best-effort feedback are both built from this
  // string, so the destination has to survive into it — not just the dialog.
  it("always states the destination", () => {
    expect(
      summarizeGitCommitPermission({ subject: "wip", paths: "all" }),
    ).toContain("Destination: This conversation's workspace");
    const inLease = summarizeGitCommitPermission(
      { subject: "wip", paths: "all" },
      {
        leaseId: "lease-1",
        label: "api",
        branch: "portal/lease/x--api",
        path: "/wt/api",
      },
    );
    expect(inLease).toContain(
      "Destination: worktree api on branch portal/lease/x--api",
    );
  });

  // The opt-out changes what "resolved" means, so the human approving a
  // mid-merge commit has to see it in the dialog and in the audit row.
  it("flags an opt-out of the conflict-marker guard", () => {
    expect(
      summarizeGitCommitPermission({
        subject: "wip",
        paths: "all",
        allowConflictMarkers: true,
      }),
    ).toContain("Conflict markers: allowed");
    expect(
      summarizeGitCommitPermission({ subject: "wip", paths: "all" }),
    ).not.toContain("Conflict markers");
    // Only the strict boolean opts out, matching the tool schema.
    expect(
      summarizeGitCommitPermission({
        subject: "wip",
        paths: "all",
        allowConflictMarkers: "yes",
      }),
    ).not.toContain("Conflict markers");
  });
});
