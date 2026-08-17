import {
  interpolateTicketPrompt,
  ticketActionChatTitle,
  ticketActionDraftUrl,
} from "$lib/tickets/chat";
import {
  templateLaunchDefaults,
  type TemplateLaunchOptions,
} from "$lib/prompt-templates";
import type { ChatPromptTemplate, WorkspaceTicket } from "$lib/types";

type TicketDraftFetch = (url: string, init: RequestInit) => Promise<Response>;

type TicketActionTemplate = Pick<
  ChatPromptTemplate,
  | "id"
  | "prompt"
  | "launchBehavior"
  | "conversationMode"
  | "approvalMode"
  | "model"
  | "workspaceMode"
  | "disabledToolGroups"
>;

/**
 * Conversation-create body describing where a ticket chat runs and with which
 * settings. The API rejects `workdir` and `workspace` together, so a worktree
 * launch passes the ticket's workspace as the worktree *source* instead of as
 * the workdir. `promptTemplateId` is always sent so the conversation seeds any
 * settings (including tool groups) the template pins, and `disabledToolGroups`
 * is always sent (possibly `[]`) so a review-dialog edit can clear the preset.
 */
function createBody(
  ticket: WorkspaceTicket,
  workdir: string | null | undefined,
  options: TemplateLaunchOptions,
  template: TicketActionTemplate,
): Record<string, unknown> {
  return {
    title: ticketActionChatTitle(ticket),
    promptTemplateId: template.id,
    disabledToolGroups: options.disabledToolGroups,
    ...(options.workspace === "worktree"
      ? {
          workspace: {
            kind: "worktree",
            ...(workdir ? { sourcePath: workdir } : {}),
          },
        }
      : { workdir: workdir ?? undefined }),
    mode: options.conversationMode ?? undefined,
    approvalMode: options.approvalMode ?? undefined,
    model: options.model ?? undefined,
  };
}

/**
 * Immediate-launch path for a ticket action (`launchBehavior: 'send'`, and the
 * destination of a confirmed `review`): create a conversation, post the prompt
 * as the first turn, and return the conversation href for the caller to
 * navigate to. On a failed turn (or a thrown request) the just-created
 * conversation is deleted so a launch failure never leaves an empty orphan chat
 * behind.
 *
 * `options` carries the settings the launch actually uses — the template's own
 * values for a plain `send`, or the user's edits from the review dialog.
 *
 * Navigation and busy/error UI stay with the caller; the `stage` on a failure
 * lets each surface produce its own message (create vs. launch).
 */
export async function createTicketLaunchChat({
  ticket,
  template,
  workdir,
  options,
  fetcher = fetch,
}: {
  ticket: WorkspaceTicket;
  template: TicketActionTemplate;
  workdir?: string | null;
  /** Resolved launch settings; defaults to the template's own values. */
  options?: TemplateLaunchOptions;
  fetcher?: TicketDraftFetch;
}): Promise<
  | { ok: true; conversationId: string; href: string }
  | { ok: false; stage: "create" | "launch"; status?: number }
> {
  const resolved = options ?? defaultOptions(template, ticket);
  let conversationId: string | null = null;
  try {
    const convRes = await fetcher("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody(ticket, workdir, resolved, template)),
    });
    if (!convRes.ok)
      return { ok: false, stage: "create", status: convRes.status };
    const body = await convRes.json();
    conversationId = body.conversation.id as string;
    const turnRes = await fetcher(
      `/api/conversations/${conversationId}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: resolved.prompt }),
      },
    );
    if (!turnRes.ok) {
      await deleteConversation(fetcher, conversationId);
      return { ok: false, stage: "launch", status: turnRes.status };
    }
    return {
      ok: true,
      conversationId,
      href: `/conversations/${conversationId}`,
    };
  } catch (err) {
    if (conversationId) await deleteConversation(fetcher, conversationId);
    throw err;
  }
}

async function deleteConversation(
  fetcher: TicketDraftFetch,
  conversationId: string,
): Promise<void> {
  try {
    await fetcher(`/api/conversations/${conversationId}`, { method: "DELETE" });
  } catch {
    // Best-effort cleanup; surfacing this error would mask the original failure.
  }
}

/**
 * Create a draft chat for a ticket-action template with `launchBehavior: 'draft'`.
 * The conversation is created (with any mode override) and the returned URL pre-
 * fills the composer with the interpolated prompt server-side. The interpolated
 * prompt is also computed here so callers/tests can verify it without a round trip.
 */
export async function createTicketDraftChat({
  ticket,
  template,
  workdir,
  options,
  fetcher = fetch,
}: {
  ticket: WorkspaceTicket;
  template: TicketActionTemplate;
  workdir?: string | null;
  /** Resolved launch settings; defaults to the template's own values. */
  options?: TemplateLaunchOptions;
  fetcher?: TicketDraftFetch;
}): Promise<
  { ok: true; href: string; prompt: string } | { ok: false; status?: number }
> {
  const resolved = options ?? defaultOptions(template, ticket);
  const convRes = await fetcher("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createBody(ticket, workdir, resolved, template)),
  });
  if (!convRes.ok) return { ok: false, status: convRes.status };
  const body = await convRes.json();
  return {
    ok: true,
    href: ticketActionDraftUrl(body.conversation.id, ticket.id, template.id),
    prompt: resolved.prompt,
  };
}

/**
 * Launch settings for a ticket action when the caller supplies none: the
 * template's stored workspace/mode/model plus its interpolated prompt. The
 * review dialog seeds its form from the same values.
 */
export function defaultOptions(
  template: TicketActionTemplate,
  ticket: WorkspaceTicket,
): TemplateLaunchOptions {
  return templateLaunchDefaults(
    template,
    interpolateTicketPrompt(template, ticket),
  );
}
