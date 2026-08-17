import { describe, expect, it, beforeEach } from "vitest";
import { setupLocalEnv } from "../../helpers/env";

function event(opts: {
  url?: string;
  userId: number | null;
  body?: unknown;
  params?: Record<string, string>;
}) {
  return {
    locals: { userId: opts.userId },
    params: opts.params ?? {},
    url: new URL(opts.url ?? "http://localhost/api/prompt-templates"),
    request: new Request(opts.url ?? "http://localhost/api/prompt-templates", {
      method: opts.body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  };
}

describe("prompt templates", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-prompt-templates-");
  });

  it("repo scopes custom templates by user and archives instead of deleting", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const user = users.ensureLocalUser();
    const other = users.ensureLocalUser("prompt-rival");

    const template = promptTemplates.create(user.id, {
      title: "Release checklist",
      description: "Verify release readiness",
      prompt: "Check changelog, tests, and deployment steps.",
      pinned: true,
      orderIndex: 5,
    });
    promptTemplates.create(other.id, {
      title: "Other user",
      prompt: "Do not show this.",
    });

    expect(promptTemplates.list(user.id).map((item) => item.id)).toEqual([
      template.id,
    ]);
    expect(promptTemplates.get(template.id, other.id)).toBeNull();
    expect(() =>
      promptTemplates.create(user.id, { title: "   ", prompt: "x" }),
    ).toThrow("prompt template title cannot be empty");
    expect(() =>
      promptTemplates.create(user.id, { title: "x", prompt: "   " }),
    ).toThrow("prompt template body cannot be empty");

    const archived = promptTemplates.archive(template.id, user.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.archivedAt).toBeTypeOf("number");
    expect(promptTemplates.list(user.id)).toEqual([]);
    expect(
      promptTemplates.list(user.id, { status: "all" }).map((item) => item.id),
    ).toEqual([template.id]);
  });

  it("seeds, restores, and validates placeholders for ticket-action templates", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const user = users.ensureLocalUser();

    // Lazy seed inserts Do/Draft/Refine on first zero-state.
    promptTemplates.ensureTicketActionDefaults(user.id);
    const seeded = promptTemplates.list(user.id, { type: "ticket-action" });
    expect(seeded.map((t) => t.title)).toEqual(["Do", "Draft", "Refine"]);
    const refine = seeded.find((t) => t.title === "Refine");
    expect(refine?.conversationMode).toBe("interactive");
    expect(seeded.find((t) => t.title === "Draft")?.launchBehavior).toBe(
      "draft",
    );
    // Seeded defaults don't pin a model; launches use the user's default.
    expect(seeded.every((t) => t.model === null)).toBe(true);

    // Chat-type listing excludes ticket actions.
    expect(promptTemplates.list(user.id, { type: "chat" })).toEqual([]);

    // Re-seeding is idempotent: still three actions.
    promptTemplates.ensureTicketActionDefaults(user.id);
    expect(
      promptTemplates.list(user.id, { type: "ticket-action" }),
    ).toHaveLength(3);

    // Archiving every action does not re-seed; restore re-adds them.
    for (const action of seeded) promptTemplates.archive(action.id, user.id);
    promptTemplates.ensureTicketActionDefaults(user.id);
    expect(promptTemplates.list(user.id, { type: "ticket-action" })).toEqual(
      [],
    );
    const restored = promptTemplates.restoreTicketActionDefaults(user.id);
    expect(restored).toBe(3);
    expect(
      promptTemplates.list(user.id, { type: "ticket-action" }),
    ).toHaveLength(3);

    // Placeholder validation rejects unknown names per type.
    expect(() =>
      promptTemplates.create(user.id, {
        type: "ticket-action",
        title: "Bad",
        prompt: "Use {{ticket.bogus}}",
      }),
    ).toThrow(/unknown placeholder/i);
    expect(() =>
      promptTemplates.create(user.id, {
        title: "Chat bad",
        prompt: "Has {{ticket.title}}",
      }),
    ).toThrow(/don't support placeholders/i);
  });

  it("persists, updates, and clears the model override for both template types", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const user = users.ensureLocalUser();

    const action = promptTemplates.create(user.id, {
      type: "ticket-action",
      title: "Ship it",
      prompt: "Do {{ticket.title}}",
      model: "  claude-sonnet-4.6  ",
    });
    // Stored override is trimmed and round-trips through a fresh read.
    expect(action.model).toBe("claude-sonnet-4.6");
    expect(promptTemplates.get(action.id, user.id)?.model).toBe(
      "claude-sonnet-4.6",
    );

    // Empty/whitespace clears back to "use my default model".
    expect(
      promptTemplates.update(action.id, user.id, { model: "   " })?.model,
    ).toBeNull();

    // Chat templates carry the same overrides: they create conversations too.
    const chat = promptTemplates.create(user.id, {
      type: "chat",
      title: "Plain",
      prompt: "No placeholders here",
      model: "claude-sonnet-4.6",
    });
    expect(chat.model).toBe("claude-sonnet-4.6");
    expect(promptTemplates.get(chat.id, user.id)?.model).toBe(
      "claude-sonnet-4.6",
    );
  });

  it("defaults launch behavior per type and persists the workspace mode", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const user = users.ensureLocalUser();

    // Chat templates historically pre-filled the composer, so `draft` is their
    // default; ticket actions keep firing immediately with `send`.
    const chat = promptTemplates.create(user.id, {
      title: "Chat",
      prompt: "Hi",
    });
    expect(chat.launchBehavior).toBe("draft");
    expect(chat.workspaceMode).toBeNull();

    const action = promptTemplates.create(user.id, {
      type: "ticket-action",
      title: "Do",
      prompt: "Do {{ticket.title}}",
    });
    expect(action.launchBehavior).toBe("send");

    // Review + worktree round-trip through a fresh read.
    const reviewed = promptTemplates.update(chat.id, user.id, {
      launchBehavior: "review",
      workspaceMode: "worktree",
    });
    expect(reviewed?.launchBehavior).toBe("review");
    expect(reviewed?.workspaceMode).toBe("worktree");
    const reread = promptTemplates.get(chat.id, user.id);
    expect(reread?.launchBehavior).toBe("review");
    expect(reread?.workspaceMode).toBe("worktree");

    // An unknown workspace mode collapses to "no preference" (shared).
    expect(
      promptTemplates.update(chat.id, user.id, {
        workspaceMode: "ask" as unknown as "shared",
      })?.workspaceMode,
    ).toBeNull();
  });

  it("API lists built-ins and performs user-scoped custom CRUD", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const { GET, POST } =
      await import("../../../src/routes/api/prompt-templates/+server");
    const { PATCH, DELETE } =
      await import("../../../src/routes/api/prompt-templates/[id]/+server");
    const user = users.ensureLocalUser();
    const other = users.ensureLocalUser("prompt-api-rival");

    const builtInsResponse = await GET(event({ userId: user.id }) as never);
    const builtIns = await builtInsResponse.json();
    expect(builtIns.builtInTemplates.length).toBeGreaterThan(0);
    expect(builtIns.customTemplates).toEqual([]);

    const createResponse = await POST(
      event({
        userId: user.id,
        body: {
          title: "Investigate flaky test",
          description: "Find a reliable repro",
          prompt: "Run the relevant tests and isolate the flaky condition.",
          pinned: true,
          orderIndex: 2,
        },
      }) as never,
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.template).toMatchObject({
      title: "Investigate flaky test",
      source: "custom",
      pinned: true,
    });

    const listResponse = await GET(event({ userId: user.id }) as never);
    const listed = await listResponse.json();
    expect(
      listed.customTemplates.map((item: { id: string }) => item.id),
    ).toEqual([created.template.id]);

    const deniedPatch = PATCH(
      event({
        userId: other.id,
        params: { id: created.template.id },
        body: { title: "Nope" },
      }) as never,
    );
    await expect(deniedPatch).rejects.toMatchObject({ status: 404 });

    const patchResponse = await PATCH(
      event({
        userId: user.id,
        params: { id: created.template.id },
        body: {
          title: "Investigate flaky test quickly",
          prompt: "Reproduce the flaky test and summarize the fix.",
          pinned: false,
        },
      }) as never,
    );
    const patched = await patchResponse.json();
    expect(patched.template).toMatchObject({
      title: "Investigate flaky test quickly",
      pinned: false,
    });

    const deleteResponse = await DELETE(
      event({ userId: user.id, params: { id: created.template.id } }) as never,
    );
    const archived = await deleteResponse.json();
    expect(archived.template.status).toBe("archived");
  });

  it("API creates ticket-action templates and rejects unknown placeholders", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const { GET, POST } =
      await import("../../../src/routes/api/prompt-templates/+server");
    const user = users.ensureLocalUser();

    const created = await POST(
      event({
        userId: user.id,
        body: {
          type: "ticket-action",
          title: "Investigate",
          prompt: "Investigate {{ticket.title}} ({{ticket.id}})",
          launchBehavior: "send",
          conversationMode: "interactive",
          model: "claude-sonnet-4.6",
        },
      }) as never,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.template).toMatchObject({
      type: "ticket-action",
      launchBehavior: "send",
      conversationMode: "interactive",
      model: "claude-sonnet-4.6",
    });

    // Ticket actions are excluded from the chat-template GET listing.
    const listResponse = await GET(event({ userId: user.id }) as never);
    const listed = await listResponse.json();
    expect(
      listed.customTemplates.some(
        (t: { id: string }) => t.id === createdBody.template.id,
      ),
    ).toBe(false);

    // Unknown placeholder is rejected with a 400.
    await expect(
      POST(
        event({
          userId: user.id,
          body: {
            type: "ticket-action",
            title: "Bad",
            prompt: "Use {{ticket.bogus}}",
          },
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });

    // A chat template using a ticket placeholder is rejected.
    await expect(
      POST(
        event({
          userId: user.id,
          body: { title: "Chat bad", prompt: "Has {{ticket.title}}" },
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("conversation load prefills the composer from built-in and custom templates only for the owner", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const convs =
      await import("../../../src/lib/server/db/repos/conversations");
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const { load } =
      await import("../../../src/routes/conversations/[id]/+page.server");
    const user = users.ensureLocalUser();
    const other = users.ensureLocalUser("prompt-load-rival");
    const conv = convs.create(user.id, {
      title: "Prompt draft",
      workdir: "/tmp",
      model: null,
    });
    const custom = promptTemplates.create(user.id, {
      title: "Custom launch",
      prompt: "Start from my saved prompt.",
    });

    const customData = await load({
      params: { id: conv.id },
      locals: { userId: user.id },
      url: new URL(
        `http://localhost/conversations/${conv.id}?promptTemplateSource=custom&promptTemplateId=${custom.id}`,
      ),
    } as never);
    expect((customData as { initialComposer: string }).initialComposer).toBe(
      "Start from my saved prompt.",
    );

    const builtInData = await load({
      params: { id: conv.id },
      locals: { userId: user.id },
      url: new URL(
        `http://localhost/conversations/${conv.id}?promptTemplateSource=builtin&promptTemplateId=-2`,
      ),
    } as never);
    expect(
      (builtInData as { initialComposer: string }).initialComposer,
    ).toContain("debugging an error");

    promptTemplates.archive(custom.id, user.id);
    await expect(
      load({
        params: { id: conv.id },
        locals: { userId: user.id },
        url: new URL(
          `http://localhost/conversations/${conv.id}?promptTemplateSource=custom&promptTemplateId=${custom.id}`,
        ),
      } as never),
    ).rejects.toMatchObject({ status: 404 });

    const otherConv = convs.create(other.id, {
      title: "Other prompt draft",
      workdir: "/tmp",
      model: null,
    });
    await expect(
      load({
        params: { id: otherConv.id },
        locals: { userId: other.id },
        url: new URL(
          `http://localhost/conversations/${otherConv.id}?promptTemplateSource=custom&promptTemplateId=${custom.id}`,
        ),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("conversation load interpolates a ticket-action template into the composer", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const convs =
      await import("../../../src/lib/server/db/repos/conversations");
    const tickets = await import("../../../src/lib/server/db/repos/tickets");
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const { ticketWorkspaceFromConversation } =
      await import("../../../src/lib/server/ticket-workspace");
    const { load } =
      await import("../../../src/routes/conversations/[id]/+page.server");
    const user = users.ensureLocalUser();

    const conv = convs.create(user.id, {
      title: "Ticket draft",
      workdir: "/tmp",
      model: null,
    });
    const ticket = tickets.create(user.id, {
      workspaceKey: ticketWorkspaceFromConversation(conv.workdir),
      title: "Fix sidebar actions",
      body: "Add a launch button.",
    });
    const action = promptTemplates.create(user.id, {
      type: "ticket-action",
      title: "Do",
      prompt:
        "Do this workspace ticket: {{ticket.title}}\n\nExecute the spec and plan below. When the plan is detailed, follow it as written — make the changes each step describes, verify each step as it specifies, and do not redesign it. If something is genuinely missing or impossible, stop and ask rather than improvising.\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}",
      launchBehavior: "draft",
    });

    const data = await load({
      params: { id: conv.id },
      locals: { userId: user.id },
      url: new URL(
        `http://localhost/conversations/${conv.id}?draftTicketId=${ticket.id}&ticketActionId=${action.id}`,
      ),
    } as never);
    expect((data as { initialComposer: string }).initialComposer).toBe(
      `Do this workspace ticket: Fix sidebar actions\n\nExecute the spec and plan below. When the plan is detailed, follow it as written — make the changes each step describes, verify each step as it specifies, and do not redesign it. If something is genuinely missing or impossible, stop and ask rather than improvising.\n\nTicket ID: ${ticket.id}\n\nAdd a launch button.\n\nPlan:\n(none)`,
    );

    // A chat template id is not a valid ticket action -> 404.
    const chat = promptTemplates.create(user.id, {
      title: "Chat",
      prompt: "Plain prompt.",
    });
    await expect(
      load({
        params: { id: conv.id },
        locals: { userId: user.id },
        url: new URL(
          `http://localhost/conversations/${conv.id}?draftTicketId=${ticket.id}&ticketActionId=${chat.id}`,
        ),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });
});
