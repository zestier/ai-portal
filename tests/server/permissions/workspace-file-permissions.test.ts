// Hash-gated import of the checked-in workspace permissions file
// (`.zap/permissions.toml`).
//
// Threat model: the agent is trusted enough to run in the workspace, but it
// must not widen its OWN permissions by editing a checked-in file. The file
// only becomes active grants through a human approval, and any drift from the
// last approved snapshot keeps the OLD state active (fail-closed) while a
// review dialog shows a unified diff.
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setupLocalEnv } from "../../helpers/env";
import * as settings from "../../../src/lib/server/db/repos/settings";
import * as interactiveRequests from "../../../src/lib/server/runtime/interactive-requests";
import {
  checkWorkspaceFileGate,
  applyWorkspaceFile,
  getWorkspaceFileStatus,
  hashWorkspaceFile,
  workspacePermissionsFilePath,
} from "../../../src/lib/server/permissions/workspace-file-gate";
import { canonicalWorkspaceRoot } from "../../../src/lib/server/permissions/repo-root";
import { parseWorkspaceGrantFile } from "../../../src/lib/server/permissions/workspace-file-format";
import { parseShellCommand } from "../../../src/lib/server/permissions/shell-parser";
import type { PortalEvent } from "../../../src/lib/types";

let userId: number;

beforeEach(async () => {
  await setupLocalEnv("portal-workspace-file-");
  const reUsers = await import("../../../src/lib/server/db/repos/users");
  userId = reUsers.ensureLocalUser().id;
});

function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "portal-wf-ws-")));
}

function writeFile(root: string, text: string): void {
  const path = workspacePermissionsFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function makeEmitter() {
  const events: PortalEvent[] = [];
  return {
    events,
    emit: (ev: PortalEvent) => {
      events.push(ev);
    },
  };
}

function driveGate(
  root: string,
  conversationId = 1,
  emitter: ReturnType<typeof makeEmitter> = makeEmitter(),
) {
  checkWorkspaceFileGate({
    userId,
    conversationId,
    workspaceRoot: root,
    emit: emitter.emit,
  });
  return emitter;
}

function workspaceFileRequests(events: PortalEvent[]) {
  return events
    .filter((e) => e.type === "interactive.request")
    .map((e) => e.request)
    .filter((r) => r.kind === "workspace_file");
}

function approve(requestId: string): boolean {
  return interactiveRequests.resolve(requestId, userId, {
    kind: "workspace_file",
    decision: "approve",
  });
}

function reject(requestId: string): boolean {
  return interactiveRequests.resolve(requestId, userId, {
    kind: "workspace_file",
    decision: "reject",
  });
}

function shellCtx(command: string, workspaceRoot: string) {
  const parsed = parseShellCommand(command);
  return {
    shellSegments: parsed.kind === "parsed" ? parsed.segments : null,
    workspaceRoots: [workspaceRoot],
    shellCwd: workspaceRoot,
  };
}
function shellMatch(root: string, command: string) {
  return settings.matchGrant(
    userId,
    1,
    "shell",
    "shell",
    command,
    shellCtx(command, root),
  );
}
function fsMatch(
  root: string,
  kind: "read" | "write" | "edit",
  target: string,
) {
  return settings.matchGrant(userId, 1, kind, kind, target, {
    target,
    workspaceRoots: [root],
  });
}
function toolMatch(root: string | null, tool: string) {
  return settings.matchGrant(userId, 1, tool, "custom-tool", null, {
    workspaceRoots: root ? [root] : null,
  });
}
function urlMatch(root: string | null, url: string) {
  return settings.matchGrant(userId, 1, "url", "url", url, {
    url,
    workspaceRoots: root ? [root] : null,
  });
}

const REALISTIC_TOML = `# Checked-in permissions for this workspace.
[[shell]]
decision = "deny"
command = ["rm"]
deny_reason = "rm is blocked by workspace policy."

[[shell]]
command = ["git", "status"]
positionals = "any"
positional_min = 0
positional_max = 0

  [[shell.options]]
  allow = ["--short"]

  [[shell.options]]
  deny = ["--porcelain"]

[[path]]
decision = "allow"
permission = "read"
root = "absolute"
behavior = "prefix"
value = "/tmp/wf-notes"

[[url]]
decision = "allow"
rule = "host"
value = "Example.COM"

[[tool]]
decision = "deny"
name = "git_commit"
deny_reason = "Blocked by workspace policy."
`;

describe("parser — workspace permissions file", () => {
  it("parses a realistic document into one grant per entry", () => {
    const parsed = parseWorkspaceGrantFile(REALISTIC_TOML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grants.length).toBe(5);

    const [rm, gitStatus, readNotes, urlHost, gitCommit] = parsed.grants;
    expect(rm).toMatchObject({
      tool: "shell",
      permissionKind: "shell",
      decision: "deny",
      denyReason: "rm is blocked by workspace policy.",
    });
    expect(rm.scope).toMatchObject({
      kind: "shell",
      rule: { command: [{ token: "rm" }] },
    });

    expect(gitStatus.tool).toBe("shell");
    const rule = gitStatus.scope.kind === "shell" ? gitStatus.scope.rule : null;
    expect(rule?.command.map((c) => c.token)).toEqual(["git", "status"]);
    expect(rule?.command[0].options?.allow).toEqual([
      { name: "--short", kind: "flag" },
    ]);
    expect(rule?.command[1].options?.deny).toEqual(["--porcelain"]);
    expect(rule?.positionalCount).toEqual({ min: 0, max: 0 });

    expect(readNotes).toMatchObject({
      tool: "read",
      permissionKind: "read",
      decision: "allow",
    });
    expect(readNotes.scope).toMatchObject({
      kind: "fs",
      perms: ["read"],
      rule: {
        kind: "path",
        root: "absolute",
        behavior: "prefix",
        value: "/tmp/wf-notes",
      },
    });

    // Host rules are lowercased by the shared schema (same as the form).
    expect(urlHost.scope).toMatchObject({
      kind: "url",
      rule: { kind: "host", host: "example.com" },
    });

    expect(gitCommit).toMatchObject({
      tool: "git_commit",
      permissionKind: "custom-tool",
      decision: "deny",
      denyReason: "Blocked by workspace policy.",
    });
    expect(gitCommit.scope).toEqual({ kind: "any" });
  });

  it("rejects unknown sections and malformed entries with a line-referencing error", () => {
    expect(parseWorkspaceGrantFile(`[[totally_wrong]]\n`)).toEqual({
      ok: false,
      error:
        'unsupported section "totally_wrong"; expected only [[shell]], [[path]], [[url]], [[tool]]',
    });
    expect(
      parseWorkspaceGrantFile(`not toml at all = [unclosed`),
    ).toMatchObject({ ok: false });
    // A shell entry with more [[shell.options]] tables than command tokens.
    expect(
      parseWorkspaceGrantFile(
        `[[shell]]\ncommand = ["git"]\n\n  [[shell.options]]\n  deny = ["-C"]\n\n  [[shell.options]]\n  deny = ["-C"]\n`,
      ),
    ).toEqual({
      ok: false,
      error:
        "entry 0: shell.options has 2 entries but command has 1 tokens; provide one per token",
    });
    // A path entry without the required `value`.
    expect(
      parseWorkspaceGrantFile(
        `[[path]]\npermission = "read"\nroot = "absolute"\nbehavior = "prefix"\n`,
      ),
    ).toMatchObject({
      ok: false,
      error: 'entry 0: path.value is required unless behavior = "any"',
    });
    // An unknown url rule kind must fail, not silently widen to host-suffix.
    expect(
      parseWorkspaceGrantFile(
        `[[url]]\nrule = "hostt"\nvalue = "example.com"\n`,
      ),
    ).toMatchObject({
      ok: false,
      error:
        'entry 0: url.rule must be one of exact | host | host-suffix, got "hostt"',
    });
    // A present-but-wrong-typed optional string must fail, not drop the constraint.
    expect(
      parseWorkspaceGrantFile(
        `[[shell]]\ncommand = ["head"]\npositionals = 123\n`,
      ),
    ).toMatchObject({
      ok: false,
      error: "entry 0: shell.positionals must be a string",
    });
    expect(
      parseWorkspaceGrantFile(`[[shell]]\ncommand = ["head"]\npipeline = 5\n`),
    ).toMatchObject({
      ok: false,
      error: "entry 0: shell.pipeline must be a string",
    });
  });
});

describe("gate — fail-closed hash-gated import", () => {
  it("is silent when there is no file and no accepted state", () => {
    const root = makeWorkspace();
    const emitter = driveGate(root);
    expect(workspaceFileRequests(emitter.events)).toEqual([]);
    expect(getWorkspaceFileStatus(userId, root)).toMatchObject({
      present: false,
      accepted: true,
      drift: false,
    });
  });

  it("raises a review on the first import of a file that grants something", () => {
    const root = makeWorkspace();
    writeFile(root, REALISTIC_TOML);
    const emitter = driveGate(root);
    const reqs = workspaceFileRequests(emitter.events);
    expect(reqs.length).toBe(1);
    const view = reqs[0];
    expect(view.currentHash).toBe(hashWorkspaceFile(REALISTIC_TOML));
    expect(view.acceptedHash).toBeNull();
    expect(view.activeGrantCount).toBe(0);
    expect(view.parseError).toBeUndefined();
    expect(view.diff).toContain("new file");
    expect(view.summary).toContain("Approving applies its 5");
  });

  it("skips a first import that grants nothing (empty valid file)", () => {
    const root = makeWorkspace();
    writeFile(root, "# nothing to import\n");
    const emitter = driveGate(root);
    expect(workspaceFileRequests(emitter.events)).toEqual([]);
    expect(getWorkspaceFileStatus(userId, root)).toMatchObject({
      present: true,
      accepted: true,
      drift: false,
    });
  });

  it("does not re-raise for the same drift in one turn", () => {
    const root = makeWorkspace();
    writeFile(root, REALISTIC_TOML);
    const emitter = driveGate(root);
    driveGate(root, 1, emitter);
    expect(workspaceFileRequests(emitter.events).length).toBe(1);
  });

  it("raises a review when an approved file changes, keeping the old state active", () => {
    const root = makeWorkspace();
    writeFile(root, `[[tool]]\nname = "git_commit"\ndecision = "deny"\n`);
    const first = driveGate(root);
    const view = workspaceFileRequests(first.events)[0];
    expect(approve(view.requestId)).toBe(true);

    // The approved grants are active.
    expect(toolMatch(root, "git_commit")).toBe("deny");
    expect(getWorkspaceFileStatus(userId, root)).toMatchObject({
      accepted: true,
      drift: false,
    });

    // The agent (or anything else) edits the file to allow a risky tool.
    const widened = `[[tool]]\nname = "git_commit"\ndecision = "allow"\n`;
    writeFile(root, widened);
    const emitter = driveGate(root);
    const reqs = workspaceFileRequests(emitter.events);
    expect(reqs.length).toBe(1);
    expect(reqs[0].currentHash).toBe(hashWorkspaceFile(widened));
    expect(reqs[0].acceptedHash).toBe(
      hashWorkspaceFile(`[[tool]]\nname = "git_commit"\ndecision = "deny"\n`),
    );
    expect(reqs[0].oldSnapshot).toContain('"deny"');
    expect(reqs[0].diff).toContain('-decision = "deny"');
    expect(reqs[0].diff).toContain('+decision = "allow"');
    // The old (deny) state is still what decides requests until approved.
    expect(toolMatch(root, "git_commit")).toBe("deny");
  });

  it("raises a review on a whitespace-only drift (conservative hash gate)", () => {
    const root = makeWorkspace();
    const original = `[[tool]]\nname = "git_commit"\ndecision = "deny"\n`;
    writeFile(root, original);
    expect(
      approve(workspaceFileRequests(driveGate(root).events)[0].requestId),
    ).toBe(true);
    writeFile(root, `${original}\n`);
    const emitter = driveGate(root);
    expect(workspaceFileRequests(emitter.events).length).toBe(1);
  });

  it("raises a review when an approved file is deleted, and approval removes its grants", () => {
    const root = makeWorkspace();
    writeFile(root, `[[tool]]\nname = "git_commit"\ndecision = "deny"\n`);
    expect(
      approve(workspaceFileRequests(driveGate(root).events)[0].requestId),
    ).toBe(true);
    expect(toolMatch(root, "git_commit")).toBe("deny");

    rmSync(workspacePermissionsFilePath(root));
    const emitter = driveGate(root);
    const reqs = workspaceFileRequests(emitter.events);
    expect(reqs.length).toBe(1);
    expect(reqs[0].currentHash).toBeNull();
    expect(reqs[0].diff).toContain('-decision = "deny"');
    expect(reqs[0].summary).toContain("deleted");

    expect(approve(reqs[0].requestId)).toBe(true);
    expect(settings.countWorkspaceFileGrants(userId, root)).toBe(0);
    expect(settings.getWorkspacePermissionState(userId, root)).toBeNull();
    expect(toolMatch(root, "git_commit")).not.toBe("deny");
    // Re-gating is silent again: deletion approved = no file, no state.
    const emitter2 = driveGate(root);
    expect(workspaceFileRequests(emitter2.events)).toEqual([]);
  });

  it("rejects an unparseable file without applying anything", () => {
    const root = makeWorkspace();
    writeFile(root, `[[tool]]\nname = `);
    const emitter = driveGate(root);
    const reqs = workspaceFileRequests(emitter.events);
    expect(reqs.length).toBe(1);
    expect(reqs[0].parseError).toBeTruthy();

    const result = applyWorkspaceFile({ userId, workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(settings.countWorkspaceFileGrants(userId, root)).toBe(0);
    expect(settings.getWorkspacePermissionState(userId, root)).toBeNull();
  });

  it("re-applies a drift after a reject is answered (re-nag on next request)", () => {
    const root = makeWorkspace();
    writeFile(root, REALISTIC_TOML);
    const first = driveGate(root);
    expect(reject(workspaceFileRequests(first.events)[0].requestId)).toBe(true);
    // Rejecting cleared the PENDING marker, so the next gate check re-raises.
    const emitter = driveGate(root);
    expect(workspaceFileRequests(emitter.events).length).toBe(1);
  });
});

describe("apply — workspace permissions", () => {
  it("materializes file grants that the matcher resolves, scoped to the file root", () => {
    const root = makeWorkspace();
    writeFile(root, REALISTIC_TOML);
    const result = applyWorkspaceFile({ userId, workspaceRoot: root });
    expect(result).toEqual({ ok: true, applied: 5 });

    // Shell deny from the file fires when the request is scoped to the root.
    expect(shellMatch(root, "rm -rf notes")).toBe("deny");
    // Absolute fs allow covers the granted prefix.
    expect(fsMatch(root, "read", "/tmp/wf-notes/a/b.txt")).toBe("allow");
    expect(fsMatch(root, "read", "/tmp/other.txt")).not.toBe("allow");
    // URL allow (host lowercased at parse time).
    expect(urlMatch(root, "https://example.com/page")).toBe("allow");
    expect(urlMatch(root, "https://evil.example.net")).not.toBe("allow");
    // Custom-tool deny.
    expect(toolMatch(root, "git_commit")).toBe("deny");

    const rows = settings
      .listGrantsForUser(userId)
      .filter((g) => g.source === "workspace-file");
    expect(rows.length).toBe(5);
    expect(rows.every((g) => g.workspaceRoot === root)).toBe(true);
  });

  it("excludes file grants unless the request root is one of the approved roots", () => {
    const rootA = makeWorkspace();
    const rootB = makeWorkspace();
    writeFile(rootA, `[[tool]]\nname = "git_commit"\ndecision = "deny"\n`);
    writeFile(rootB, `[[tool]]\nname = "git_merge_abort"\ndecision = "deny"\n`);
    expect(applyWorkspaceFile({ userId, workspaceRoot: rootA })).toEqual({
      ok: true,
      applied: 1,
    });
    expect(applyWorkspaceFile({ userId, workspaceRoot: rootB })).toEqual({
      ok: true,
      applied: 1,
    });

    // Scoped to A: A's deny applies, B's is excluded.
    expect(toolMatch(rootA, "git_commit")).toBe("deny");
    expect(toolMatch(rootA, "git_merge_abort")).not.toBe("deny");
    // Scoped to B: B's deny applies, A's is excluded.
    expect(toolMatch(rootB, "git_merge_abort")).toBe("deny");
    expect(toolMatch(rootB, "git_commit")).not.toBe("deny");
    // No workspace roots at all: every workspace-file row is excluded.
    expect(toolMatch(null, "git_commit")).not.toBe("deny");
    expect(toolMatch(null, "git_merge_abort")).not.toBe("deny");
  });

  it("a file deny beats a user allow for the same tool (deny wins across sources)", () => {
    const root = makeWorkspace();
    writeFile(
      root,
      `[[tool]]\nname = "git_commit"\ndecision = "deny"\ndeny_reason = "policy"\n`,
    );
    expect(applyWorkspaceFile({ userId, workspaceRoot: root })).toEqual({
      ok: true,
      applied: 1,
    });

    settings.addGrant({
      userId,
      conversationId: null,
      tool: "git_commit",
      permissionKind: "custom-tool",
      scope: { kind: "any" },
      decision: "allow",
      source: "settings",
    });
    const detailed = settings.matchGrantDetailed(
      userId,
      1,
      "git_commit",
      "custom-tool",
      null,
      {
        workspaceRoots: [root],
      },
    );
    expect(detailed.outcome).toBe("deny");
    expect(detailed.feedback).toContain("policy");
  });

  it("is additive over seeds — file grants can extend, never remove, the seed floor", () => {
    const root = makeWorkspace();
    // `git_merge_abort` is deliberately NOT seeded with an allow.
    expect(toolMatch(root, "git_merge_abort")).not.toBe("allow");
    writeFile(root, `[[tool]]\nname = "git_merge_abort"\ndecision = "allow"\n`);
    expect(applyWorkspaceFile({ userId, workspaceRoot: root })).toEqual({
      ok: true,
      applied: 1,
    });
    expect(toolMatch(root, "git_merge_abort")).toBe("allow");
    // Seeds still hold: a seeded allow remains an allow, a seeded prompt a prompt.
    expect(toolMatch(root, "git_status")).toBe("allow");
    expect(toolMatch(root, "git_commit")).not.toBe("allow");
  });

  it("guards against TOCTOU: applying a stale reviewed hash applies nothing", () => {
    const root = makeWorkspace();
    const v1 = `[[tool]]\nname = "git_commit"\ndecision = "deny"\n`;
    writeFile(root, v1);
    // The agent edits the file while the review is open.
    writeFile(root, `[[tool]]\nname = "git_commit"\ndecision = "allow"\n`);
    const result = applyWorkspaceFile({
      userId,
      workspaceRoot: root,
      expectedHash: hashWorkspaceFile(v1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("changed since it was reviewed");
    expect(settings.countWorkspaceFileGrants(userId, root)).toBe(0);
    expect(settings.getWorkspacePermissionState(userId, root)).toBeNull();
  });

  it("re-applying after the file returns to the approved hash is silent", () => {
    const root = makeWorkspace();
    writeFile(root, REALISTIC_TOML);
    expect(
      approve(workspaceFileRequests(driveGate(root).events)[0].requestId),
    ).toBe(true);
    expect(getWorkspaceFileStatus(userId, root)).toMatchObject({
      present: true,
      accepted: true,
      drift: false,
    });
    const emitter = driveGate(root);
    expect(workspaceFileRequests(emitter.events)).toEqual([]);
  });

  it("apply is idempotent for the same file content", () => {
    const root = makeWorkspace();
    writeFile(root, REALISTIC_TOML);
    expect(applyWorkspaceFile({ userId, workspaceRoot: root })).toEqual({
      ok: true,
      applied: 5,
    });
    expect(applyWorkspaceFile({ userId, workspaceRoot: root })).toEqual({
      ok: true,
      applied: 5,
    });
    expect(settings.countWorkspaceFileGrants(userId, root)).toBe(5);
  });

  it("refuses to edit or individually revoke a workspace-file row via the settings path", () => {
    // A file row is owned by the `.zap/permissions.toml` lifecycle: editing it
    // in Settings would flip `source` to 'settings' and silently promote a
    // root-scoped checked-in grant to a permanent user-global one.
    const root = makeWorkspace();
    writeFile(root, `[[tool]]\nname = "git_commit"\ndecision = "deny"\n`);
    expect(applyWorkspaceFile({ userId, workspaceRoot: root })).toEqual({
      ok: true,
      applied: 1,
    });
    const row = settings
      .listGrantsForUser(userId)
      .find((g) => g.source === "workspace-file");
    expect(row).toBeTruthy();
    if (!row) return;

    expect(
      settings.updateGrant(userId, row.id, {
        tool: "git_commit",
        permissionKind: "custom-tool",
        scopePattern: null,
        scope: { kind: "any" },
        decision: "allow",
        expiresAt: null,
        denyReason: null,
      }),
    ).toBe(false);
    expect(settings.revokeGrant(userId, row.id)).toBe(false);

    const after = settings
      .listGrantsForUser(userId)
      .find((g) => g.id === row.id);
    expect(after?.source).toBe("workspace-file");
    expect(after?.decision).toBe("deny");
    expect(toolMatch(root, "git_commit")).toBe("deny");
  });

  it("delete-apply is atomic: revokes the file grants and clears the approval state together", () => {
    const root = makeWorkspace();
    writeFile(root, REALISTIC_TOML);
    expect(applyWorkspaceFile({ userId, workspaceRoot: root })).toEqual({
      ok: true,
      applied: 5,
    });
    rmSync(workspacePermissionsFilePath(root));
    expect(applyWorkspaceFile({ userId, workspaceRoot: root })).toEqual({
      ok: true,
      applied: 5,
    });
    expect(settings.countWorkspaceFileGrants(userId, root)).toBe(0);
    expect(settings.getWorkspacePermissionState(userId, root)).toBeNull();
    expect(
      settings
        .listGrantsForUser(userId)
        .filter((g) => g.source === "workspace-file").length,
    ).toBe(0);
  });
});

// One approval per repository: the gate and the matcher canonicalize every
// root to the repo's main checkout, so a worktree shares the main root's
// approval instead of re-reviewing the file (AC2) and its grants apply there
// (AC3).
function makeGitRepoWithWorktree(): { base: string; main: string; wt: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "portal-wf-repo-")));
  const main = join(base, "main");
  const wt = join(base, "wt");
  mkdirSync(main);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: main, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "portal-test@localhost"]);
  git(["config", "user.name", "Portal Test"]);
  writeFileSync(join(main, "a.txt"), "x");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "base"]);
  git(["worktree", "add", "-q", "-b", "wt-branch", wt, "HEAD"]);
  return { base, main, wt };
}

describe("worktree — one approval per repository", () => {
  it("shares the main root approval and applies its grants in the worktree", () => {
    const { base, main, wt } = makeGitRepoWithWorktree();
    try {
      writeFile(main, `[[tool]]\nname = "git_commit"\ndecision = "deny"\n`);
      // First gate on the main root raises the import review; approve it.
      const first = driveGate(main);
      const reqs = workspaceFileRequests(first.events);
      expect(reqs.length).toBe(1);
      expect(approve(reqs[0].requestId)).toBe(true);
      expect(toolMatch(main, "git_commit")).toBe("deny");

      // The same repo's worktree root must NOT re-review the file (AC2).
      const wtEmitter = driveGate(wt);
      expect(workspaceFileRequests(wtEmitter.events)).toEqual([]);

      // The approved file grant fires for requests scoped to the worktree (AC3).
      expect(toolMatch(wt, "git_commit")).toBe("deny");
      // And the approval state is keyed by the canonical (main) root.
      expect(
        settings.getWorkspacePermissionState(
          userId,
          canonicalWorkspaceRoot(wt),
        ),
      ).not.toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("an approval raised while the worktree is primary applies repo-wide", () => {
    const { base, main, wt } = makeGitRepoWithWorktree();
    try {
      // The gate reads the main checkout copy even when the primary root is
      // the worktree — canonicalized to the repo root.
      writeFile(
        main,
        `[[tool]]\nname = "git_merge_abort"\ndecision = "deny"\n`,
      );
      const reqs = workspaceFileRequests(driveGate(wt).events);
      expect(reqs.length).toBe(1);
      expect(approve(reqs[0].requestId)).toBe(true);
      // Approved from the worktree, applies to the whole repo (main included).
      expect(toolMatch(main, "git_merge_abort")).toBe("deny");
      expect(toolMatch(wt, "git_merge_abort")).toBe("deny");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
