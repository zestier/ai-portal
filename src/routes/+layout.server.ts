import type { LayoutServerLoad } from "./$types";
import {
  conversationId as convCodec,
  ticketId as ticketIdCodec,
} from "$lib/ids";
import * as convs from "$lib/server/db/repos/conversations";
import * as tickets from "$lib/server/db/repos/tickets";
import * as promptTemplates from "$lib/server/db/repos/prompt-templates";
import * as settings from "$lib/server/db/repos/settings";
import { awaitingInputConversationIds } from "$lib/server/runtime/interactive-requests";
import { runningConversationIds } from "$lib/server/runtime/turn-runner";
import type { SidebarTicket } from "$lib/types";
import {
  defaultTicketWorkspace,
  ticketWorkspaceFromConversation,
} from "$lib/server/ticket-workspace";

export const load: LayoutServerLoad = ({ locals, params }) => {
  const conversations = locals.userId
    ? convs.list(locals.userId, { includeArchived: true })
    : [];
  // Intersect the registry's awaiting set with this user's conversations so a
  // single-instance indicator never leaks another user's pending state.
  const awaiting = locals.userId
    ? awaitingInputConversationIds()
    : new Set<number>();
  const awaitingConversationIds = conversations
    .filter((c) => c.archivedAt == null && awaiting.has(convCodec.parse(c.id)))
    .map((c) => c.id);
  // The two halves of the sidebar's "active" indicator. Same intersect-with-
  // this-user's-conversations discipline as `awaiting` above: the turn registry
  // is process-global, so scoping it here keeps a single-instance deployment
  // from leaking another user's running turns. `unreadConversationIds` is
  // already user-scoped by its query.
  const running = locals.userId ? runningConversationIds() : new Set<number>();
  const runningIds = conversations
    .filter((c) => c.archivedAt == null && running.has(convCodec.parse(c.id)))
    .map((c) => c.id);
  const unreadIds = locals.userId
    ? // The conversation being viewed is seen by definition. Its own page
      // `load` marks it read, but the two loads run concurrently, so filtering
      // here is what makes the result deterministic rather than a race.
      [...convs.unreadConversationIds(locals.userId)].filter(
        (id) => params.id === undefined || id !== params.id,
      )
    : ([] as string[]);
  let ticketWorkspace: string | null = null;
  if (locals.userId) {
    const activeConversation =
      typeof params.id === "string"
        ? convs.get(convCodec.tryParse(params.id) ?? -1, locals.userId)
        : null;
    ticketWorkspace = activeConversation
      ? ticketWorkspaceFromConversation(activeConversation)
      : defaultTicketWorkspace(locals.userId);
  }
  let ticketActions: ReturnType<typeof promptTemplates.list> = [];
  if (locals.userId) {
    // Lazy-seed Do/Draft/Refine the first time the user has no ticket actions
    // so the sidebar always renders sensible defaults out of the box.
    promptTemplates.ensureTicketActionDefaults(locals.userId);
    ticketActions = promptTemplates.list(locals.userId, {
      type: "ticket-action",
      status: "open",
    });
  }
  // Enrich the sidebar window with each ticket's still-open prerequisites so it
  // can flag blocked tickets (and tooltip their blocker titles) without a second
  // round-trip. `listForSidebar` already orders ready-before-blocked across the
  // full open set, so the 10-row window surfaces ready tickets first.
  const userId = locals.userId;
  let sidebarTickets: SidebarTicket[] = [];
  if (userId && ticketWorkspace) {
    sidebarTickets = tickets
      .listForSidebar(userId, ticketWorkspace, 10)
      .map((ticket) => ({
        ...ticket,
        blockers: tickets
          .dependencyRefs(ticketIdCodec.parse(ticket.id), userId)
          .filter((ref) => ref.status === "open"),
      }));
  }
  return {
    user: locals.user,
    conversations,
    awaitingConversationIds,
    runningConversationIds: runningIds,
    unreadConversationIds: unreadIds,
    tickets: sidebarTickets,
    ticketCount:
      locals.userId && ticketWorkspace
        ? tickets.count(locals.userId, ticketWorkspace)
        : 0,
    ticketWorkspace,
    ticketActions,
    // Per-user default chat template for the New chat buttons. NULL when
    // unset (blank chat). Only read, never cached — the launcher re-checks
    // it after any save via invalidateAll.
    defaultPromptTemplateId: locals.userId
      ? (settings.get(locals.userId)?.defaultPromptTemplateId ?? null)
      : null,
  };
};
