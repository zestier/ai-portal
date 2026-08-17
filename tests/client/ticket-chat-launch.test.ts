import { describe, expect, it, vi } from "vitest";
import { createTicketDraftChat } from "../../src/lib/client/ticket-chat-launch";
import type { ChatPromptTemplate, WorkspaceTicket } from "../../src/lib/types";

const ticket: WorkspaceTicket = {
  id: "T1",
  userId: 1,
  workspaceKey: "/workspace",
  title: "Fix sidebar actions",
  body: "Add a launch button.",
  plan: "",
  priority: "P2",
  status: "open",
  sourceConversationId: null,
  sourceMessageId: null,
  createdAt: 1,
  updatedAt: 1,
  closedAt: null,
};

function action(
  overrides: Partial<ChatPromptTemplate> = {},
): ChatPromptTemplate {
  return {
    id: "PT100",
    userId: 1,
    type: "ticket-action",
    title: "Do",
    description: "",
    prompt:
      "Do this workspace ticket: {{ticket.title}}\n\nExecute the spec and plan below. When the plan is detailed, follow it as written — make the changes each step describes, verify each step as it specifies, and do not redesign it. If something is genuinely missing or impossible, stop and ask rather than improvising.\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}",
    launchBehavior: "draft",
    conversationMode: null,
    approvalMode: null,
    model: null,
    disabledToolGroups: [],
    workspaceMode: null,
    status: "open",
    pinned: true,
    orderIndex: 10,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

describe("createTicketDraftChat", () => {
  it("creates a conversation and returns a draft URL + interpolated prompt without posting a turn", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return Response.json(
          { conversation: { id: "conv-1" } },
          { status: 201 },
        );
      },
    );

    const result = await createTicketDraftChat({
      ticket,
      template: action(),
      workdir: "/workspace",
      fetcher,
    });

    expect(result).toEqual({
      ok: true,
      href: "/conversations/conv-1?draftTicketId=T1&ticketActionId=PT100",
      prompt:
        "Do this workspace ticket: Fix sidebar actions\n\nExecute the spec and plan below. When the plan is detailed, follow it as written — make the changes each step describes, verify each step as it specifies, and do not redesign it. If something is genuinely missing or impossible, stop and ask rather than improvising.\n\nTicket ID: T1\n\nAdd a launch button.\n\nPlan:\n(none)",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("/api/conversations");
    expect(String(url)).not.toContain("/turns");
    expect(JSON.parse(init?.body as string)).toEqual({
      title: "Fix sidebar actions",
      workdir: "/workspace",
      promptTemplateId: "PT100",
      disabledToolGroups: [],
    });
  });

  it("applies the action conversation-mode override at creation", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return Response.json(
          { conversation: { id: "conv-2" } },
          { status: 201 },
        );
      },
    );

    const result = await createTicketDraftChat({
      ticket,
      template: action({ id: "PT101", conversationMode: "interactive" }),
      workdir: "/workspace",
      fetcher,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.href).toBe(
        "/conversations/conv-2?draftTicketId=T1&ticketActionId=PT101",
      );
    }
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      title: "Fix sidebar actions",
      workdir: "/workspace",
      promptTemplateId: "PT101",
      disabledToolGroups: [],
      mode: "interactive",
    });
  });

  it("sends the ticket workspace as the worktree source when the action pins a worktree", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return Response.json(
          { conversation: { id: "conv-3" } },
          { status: 201 },
        );
      },
    );

    await createTicketDraftChat({
      ticket,
      template: action({ workspaceMode: "worktree" }),
      workdir: "/workspace",
      fetcher,
    });

    // `workdir` and `workspace` are mutually exclusive server-side, so the
    // ticket's workspace has to travel as the worktree's source path.
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      title: "Fix sidebar actions",
      workspace: { kind: "worktree", sourcePath: "/workspace" },
      promptTemplateId: "PT100",
      disabledToolGroups: [],
    });
  });

  it("prefers explicit launch options over the action’s stored settings", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return Response.json(
          { conversation: { id: "conv-4" } },
          { status: 201 },
        );
      },
    );

    // This is what a confirmed review dialog produces: edited prompt + options.
    const result = await createTicketDraftChat({
      ticket,
      template: action({
        workspaceMode: "worktree",
        conversationMode: "autopilot",
      }),
      workdir: "/workspace",
      options: {
        prompt: "Edited prompt",
        workspace: "shared",
        conversationMode: "interactive",
        approvalMode: null,
        model: "claude-sonnet-4.6",
        disabledToolGroups: ["git"],
      },
      fetcher,
    });

    expect(result.ok && result.prompt).toBe("Edited prompt");
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      title: "Fix sidebar actions",
      workdir: "/workspace",
      promptTemplateId: "PT100",
      disabledToolGroups: ["git"],
      mode: "interactive",
      model: "claude-sonnet-4.6",
    });
  });
});
