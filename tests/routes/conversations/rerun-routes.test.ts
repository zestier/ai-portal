import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { isHttpError } from "@sveltejs/kit";
import { setupLocalEnv } from "../../helpers/env";
import { makeTmpDir } from "../../helpers/tmp";

// The /edit and /regenerate routes call startTurnFromUserMessage AFTER the
// (synchronous) message-edit work. Mock it so we can drive the "unexpected
// failure while starting the rerun turn" path and assert the route maps it to
// a clear client error instead of leaking a bare SvelteKit 500.
const startTurnMock = vi.fn();
vi.mock("../../../src/lib/server/turn-start", () => ({
  startTurnFromUserMessage: (...args: unknown[]) => startTurnMock(...args),
}));

async function freshImports() {
  vi.resetModules();
  const users = await import("../../../src/lib/server/db/repos/users");
  const convs = await import("../../../src/lib/server/db/repos/conversations");
  const messages = await import("../../../src/lib/server/db/repos/messages");
  const editRoute =
    await import("../../../src/routes/api/conversations/[id]/messages/[messageId]/edit/+server");
  const regenRoute =
    await import("../../../src/routes/api/conversations/[id]/messages/[messageId]/regenerate/+server");
  const forkRoute =
    await import("../../../src/routes/api/conversations/[id]/messages/[messageId]/fork/+server");
  return { users, convs, messages, editRoute, regenRoute, forkRoute };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function committedRepository(): string {
  const source = makeTmpDir("portal-rerun-fork-source-");
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.name", "Portal Test"]);
  git(source, ["config", "user.email", "portal-test@localhost"]);
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "initial"]);
  return source;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callAndCapture(fn: () => unknown) {
  try {
    const res = (await fn()) as Response;
    return { thrown: null as unknown, status: res.status };
  } catch (e) {
    return { thrown: e, status: undefined };
  }
}

describe("rerun routes: error surfacing", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-rerun-route-");
    startTurnMock.mockReset();
  });

  it("/edit maps an unexpected turn-start failure to a clear 502, not a bare 500", async () => {
    const { users, convs, messages, editRoute } = await freshImports();
    const u = users.ensureLocalUser();
    const conv = convs.create(u.id, {
      title: "c",
      workdir: "/tmp",
      model: "gpt-4",
    });
    const u1 = messages.append(conv.id, { role: "user", content: "original" });

    startTurnMock.mockRejectedValue(
      new Error("Failed to open the agent session for conversation " + conv.id),
    );

    const { thrown } = await callAndCapture(() =>
      editRoute.POST({
        params: { id: conv.id, messageId: u1.id },
        locals: { userId: u.id },
        request: jsonRequest({ content: "edited" }),
      } as never),
    );

    expect(isHttpError(thrown)).toBe(true);
    const httpErr = thrown as { status: number; body: { message: string } };
    // A bare 500 would carry SvelteKit's generic "Internal server error".
    expect(httpErr.status).toBe(502);
    expect(httpErr.body.message).toContain("Couldn't start the rerun");
    expect(httpErr.body.message).toContain("agent session");
  });

  it("/edit still maps InlineEditRejected to its specific 4xx status", async () => {
    const { users, convs, messages, editRoute } = await freshImports();
    const u = users.ensureLocalUser();
    const conv = convs.create(u.id, {
      title: "c",
      workdir: "/tmp",
      model: "gpt-4",
    });
    // Editing an assistant message is rejected with `not_user_message` (400).
    const a1 = messages.append(conv.id, {
      role: "assistant",
      content: "reply",
    });

    const { thrown } = await callAndCapture(() =>
      editRoute.POST({
        params: { id: conv.id, messageId: a1.id },
        locals: { userId: u.id },
        request: jsonRequest({ content: "edited" }),
      } as never),
    );

    expect(isHttpError(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(400);
    // turn-start must never be reached for a rejected edit.
    expect(startTurnMock).not.toHaveBeenCalled();
  });

  it("/regenerate maps an unexpected turn-start failure to a clear 502", async () => {
    const { users, convs, messages, regenRoute } = await freshImports();
    const u = users.ensureLocalUser();
    const conv = convs.create(u.id, {
      title: "c",
      workdir: "/tmp",
      model: "gpt-4",
    });
    messages.append(conv.id, { role: "user", content: "q" });
    const a1 = messages.append(conv.id, { role: "assistant", content: "a" });

    startTurnMock.mockRejectedValue(new Error("runtime connection lost"));

    const { thrown } = await callAndCapture(() =>
      regenRoute.POST({
        params: { id: conv.id, messageId: a1.id },
        locals: { userId: u.id },
      } as never),
    );

    expect(isHttpError(thrown)).toBe(true);
    const httpErr = thrown as { status: number; body: { message: string } };
    expect(httpErr.status).toBe(502);
    expect(httpErr.body.message).toContain("Couldn't start the rerun");
    expect(httpErr.body.message).toContain("runtime connection lost");
  });

  it("rejects reruns before mutating history when a managed workspace is unavailable", async () => {
    const dataDir = await setupLocalEnv("portal-rerun-missing-worktree-");
    const { users, convs, messages, editRoute, regenRoute } =
      await freshImports();
    const user = users.ensureLocalUser();
    const conversationId = "MISSINGWORKTREE";
    const worktreePath = join(
      dataDir,
      "worktrees",
      String(user.id),
      conversationId,
    );
    const conversation = convs.create(user.id, {
      title: "managed",
      workdir: worktreePath,
      workspaceKind: "managed-worktree",
      workspaceKey: "/tmp/source",
      managedWorktree: {
        sourceWorkdir: "/tmp/source",
        path: worktreePath,
        gitCommonDir: "/tmp/source/.git",
        branch: `portal/${conversationId}`,
        baseSha: "a".repeat(40),
      },
      model: "gpt-4",
    });
    const userMessage = messages.append(conversation.id, {
      role: "user",
      content: "original",
    });
    const assistantMessage = messages.append(conversation.id, {
      role: "assistant",
      content: "reply",
    });

    for (const call of [
      () =>
        editRoute.POST({
          params: { id: conversation.id, messageId: userMessage.id },
          locals: { userId: user.id },
          request: jsonRequest({ content: "edited" }),
        } as never),
      () =>
        regenRoute.POST({
          params: { id: conversation.id, messageId: assistantMessage.id },
          locals: { userId: user.id },
        } as never),
    ]) {
      const { thrown } = await callAndCapture(call);
      expect(isHttpError(thrown)).toBe(true);
      expect(thrown).toMatchObject({
        status: 409,
        body: { code: "workspace_unavailable" },
      });
      expect(messages.listByConversation(conversation.id)).toMatchObject([
        { id: userMessage.id, content: "original" },
        { id: assistantMessage.id, content: "reply" },
      ]);
    }
    expect(startTurnMock).not.toHaveBeenCalled();
  });

  it("/fork rolls back a managed child when turn startup fails", async () => {
    const dataDir = await setupLocalEnv("portal-rerun-managed-fork-");
    const source = committedRepository();
    const worktreeRoot = join(dataDir, "worktrees");
    process.env.PROJECT_ROOT = source;
    process.env.WORKTREE_ROOT = worktreeRoot;
    const { users, convs, messages, forkRoute } = await freshImports();
    const snapshots = await import("../../../src/lib/server/snapshots");
    const user = users.ensureLocalUser();
    const conversation = convs.create(user.id, {
      title: "source",
      workdir: source,
      model: "gpt-4",
    });
    const userMessage = messages.append(conversation.id, {
      role: "user",
      content: "original",
    });
    await snapshots.snapshot(source, userMessage.id, "pre");
    startTurnMock.mockRejectedValue(new Error("provider session unavailable"));

    const { thrown } = await callAndCapture(() =>
      forkRoute.POST({
        params: { id: conversation.id, messageId: userMessage.id },
        locals: { userId: user.id },
        request: jsonRequest({ content: "edited", workspace: "worktree" }),
      } as never),
    );

    expect(isHttpError(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(502);
    expect(convs.listChildren(user.id, conversation.id)).toEqual([]);
    const userRoot = join(worktreeRoot, String(user.id));
    expect(existsSync(userRoot) ? readdirSync(userRoot) : []).toEqual([]);
    expect(git(source, ["branch", "--list", "portal/*"])).toBe("");
  });

  it("/edit rejects a concurrent second rerun with 409, not 502", async () => {
    const { users, convs, messages, editRoute } = await freshImports();
    const u = users.ensureLocalUser();
    const conv = convs.create(u.id, {
      title: "c",
      workdir: "/tmp",
      model: "gpt-4",
    });
    const u1 = messages.append(conv.id, { role: "user", content: "original" });

    // First rerun parks inside startTurnFromUserMessage (reservation held).
    let resolveStart: (turn: unknown) => void = () => {};
    startTurnMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    const first = callAndCapture(() =>
      editRoute.POST({
        params: { id: conv.id, messageId: u1.id },
        locals: { userId: u.id },
        request: jsonRequest({ content: "edit-a" }),
      } as never),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Second concurrent rerun must be rejected with a clean 409, not a 502.
    const second = await callAndCapture(() =>
      editRoute.POST({
        params: { id: conv.id, messageId: u1.id },
        locals: { userId: u.id },
        request: jsonRequest({ content: "edit-b" }),
      } as never),
    );
    expect(isHttpError(second.thrown)).toBe(true);
    expect((second.thrown as { status: number }).status).toBe(409);
    expect(startTurnMock).toHaveBeenCalledTimes(1);

    resolveStart({ id: "turn-1" });
    const firstResult = await first;
    expect(firstResult.status).toBe(200);

    // A follow-up rerun succeeds once the reservation is released.
    startTurnMock.mockResolvedValue({ id: "turn-2" });
    const third = await callAndCapture(() =>
      editRoute.POST({
        params: { id: conv.id, messageId: u1.id },
        locals: { userId: u.id },
        request: jsonRequest({ content: "edit-c" }),
      } as never),
    );
    expect(third.status).toBe(200);
  });
});
