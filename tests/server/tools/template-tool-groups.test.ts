import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { resetServerSingletons, setupLocalEnv } from "../../helpers/env";
import { makeTmpDir } from "../../helpers/tmp";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Managed-worktree creation derives the branch `portal/<conversationId>` from
// the source repo. With integer ids those names reset to 1,2,3 per test, so a
// real checkout as PROJECT_ROOT would leak colliding branches into the host
// repo; point the route at an isolated committed repo instead.
function committedRepository(): string {
  const source = makeTmpDir("portal-tmpl-tg-source-");
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.name", "Portal Test"]);
  git(source, ["config", "user.email", "portal-test@localhost"]);
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "initial"]);
  return source;
}

describe("chat template tool-group presets", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-template-tool-groups-");
    process.env.PROJECT_ROOT = committedRepository();
    await resetServerSingletons();
  });

  describe("repo round-trip", () => {
    it("defaults chat templates to an empty disabled set", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Story",
        prompt: "Tell a story.",
      });
      expect(tpl.disabledToolGroups).toEqual([]);
      expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([]);
    });

    it("persists and sanitizes a chat template preset (canonical order, unknowns dropped)", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Story",
        prompt: "Tell a story.",
        disabledToolGroups: ["tickets", "bogus", "git", "git"],
      });
      expect(tpl.disabledToolGroups).toEqual(["git", "tickets"]);
      expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([
        "git",
        "tickets",
      ]);
    });

    it("updates a chat template preset and can clear it", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Story",
        prompt: "Tell a story.",
      });
      templates.update(tpl.id, user.id, {
        disabledToolGroups: ["git", "tickets"],
      });
      expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([
        "git",
        "tickets",
      ]);
      templates.update(tpl.id, user.id, { disabledToolGroups: [] });
      expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([]);
    });

    it("persists a ticket-action preset through create/get/update", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        type: "ticket-action",
        title: "Do",
        prompt: "Do the ticket.",
        disabledToolGroups: ["git"],
      });
      expect(tpl.disabledToolGroups).toEqual(["git"]);
      expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([
        "git",
      ]);
      // And an update on a ticket-action template can change the preset too.
      templates.update(tpl.id, user.id, { disabledToolGroups: ["memory"] });
      expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([
        "memory",
      ]);
    });
  });

  describe("template_create / template_update tools", () => {
    async function buildTools(userId: number) {
      const mod =
        await import("../../../src/lib/server/tools/prompt-templates");
      return mod.buildPromptTemplateTools({ userId });
    }

    it("creates a chat template with a validated preset", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const user = users.ensureLocalUser();
      const tools = await buildTools(user.id);
      const create = tools.find((t) => t.name === "template_create");
      const res = await create!.handler({
        type: "chat",
        title: "Story",
        prompt: "Tell a story.",
        disabledToolGroups: ["git", "tickets"],
      });
      expect(res.ok).toBe(true);
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const list = templates.list(user.id, { type: "chat" });
      expect(list[0]?.disabledToolGroups).toEqual(["git", "tickets"]);
    });

    it("rejects unknown group ids at the tool boundary", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const user = users.ensureLocalUser();
      const tools = await buildTools(user.id);
      const create = tools.find((t) => t.name === "template_create");
      await expect(
        create!.handler({
          type: "chat",
          title: "Story",
          prompt: "Tell a story.",
          disabledToolGroups: ["not-a-group"],
        }),
      ).rejects.toThrow();
    });

    it("updates a chat template preset via the tool", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Story",
        prompt: "Tell a story.",
      });
      const tools = await buildTools(user.id);
      const update = tools.find((t) => t.name === "template_update");
      const res = await update!.handler({
        id: String(tpl.id),
        disabledToolGroups: ["memory"],
      });
      expect(res.ok).toBe(true);
      expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([
        "memory",
      ]);
    });
  });

  describe("launch seeds the conversation", () => {
    it("copies a chat template preset onto a conversation created with promptTemplateId", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Story",
        prompt: "Tell a story.",
        disabledToolGroups: ["git", "tickets"],
      });

      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Story chat",
            promptTemplateId: tpl.id,
          }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.disabledToolGroups).toEqual(["git", "tickets"]);
    });

    it("seeds a ticket-action template preset onto the conversation too", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        type: "ticket-action",
        title: "Do",
        prompt: "Do the ticket.",
        disabledToolGroups: ["git"],
      });

      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Do chat", promptTemplateId: tpl.id }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.disabledToolGroups).toEqual(["git"]);
    });

    it("lets an explicit disabledToolGroups body win over the template preset", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Story",
        prompt: "Tell a story.",
        disabledToolGroups: ["git"],
      });

      // A review-dialog edit that switched to memory must beat the preset.
      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Story chat",
            promptTemplateId: tpl.id,
            disabledToolGroups: ["memory"],
          }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.disabledToolGroups).toEqual(["memory"]);
    });

    it("lets an explicit empty disabledToolGroups clear the template preset", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Story",
        prompt: "Tell a story.",
        disabledToolGroups: ["git"],
      });

      // Clients always send the resolved groups; an explicit `[]` must not
      // silently re-seed from the template (D6).
      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Story chat",
            promptTemplateId: tpl.id,
            disabledToolGroups: [],
          }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.disabledToolGroups).toEqual([]);
    });

    it("seeds nothing when the template belongs to another user", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const other = users.ensureLocalUser("other");
      const tpl = templates.create(other.id, {
        title: "Story",
        prompt: "Tell a story.",
        disabledToolGroups: ["git"],
      });

      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Story chat",
            promptTemplateId: tpl.id,
          }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.disabledToolGroups).toEqual([]);
    });

    it("seeds nothing when no promptTemplateId is supplied", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Plain chat" }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.disabledToolGroups).toEqual([]);
    });

    it("creates a managed worktree when the template pins workspaceMode: worktree", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Isolated",
        prompt: "Work in isolation.",
        workspaceMode: "worktree",
      });

      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Isolated chat",
            promptTemplateId: tpl.id,
          }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.workspaceKind).toBe("managed-worktree");
    });

    it("lets an explicit workspace override the template preference", async () => {
      const users = await import("../../../src/lib/server/db/repos/users");
      const templates =
        await import("../../../src/lib/server/db/repos/prompt-templates");
      const { POST } =
        await import("../../../src/routes/api/conversations/+server");
      const user = users.ensureLocalUser();
      const tpl = templates.create(user.id, {
        title: "Isolated",
        prompt: "Work in isolation.",
        workspaceMode: "worktree",
      });

      // A review launch that switched back to the shared checkout must win.
      const res = await POST({
        locals: { userId: user.id, user: { githubLogin: "local" } },
        request: new Request("http://localhost/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Shared chat",
            promptTemplateId: tpl.id,
            workspace: { kind: "shared" },
          }),
        }),
        getClientAddress: () => "127.0.0.1",
      } as unknown as Parameters<typeof POST>[0]);
      const body = await (res as Response).json();
      expect(body.conversation.workspaceKind).toBe("shared");
    });
  });
});
