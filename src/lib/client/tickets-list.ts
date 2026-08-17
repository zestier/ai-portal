import type { WorkspaceTicket, WorkspaceTicketPriority } from "$lib/types";

export type TicketListStatus = "open" | "done" | "archived" | "all";

/** Result ordering for the `/tickets` index list. `recency` is the default. */
export type TicketListSort = "recency" | "priority";

/** Priority filter for the index list; `'all'` (the default) includes every priority. */
export type TicketPriorityFilter = WorkspaceTicketPriority | "all";

/** Page size for the `/tickets` index list and its "Load more" pagination. */
export const TICKETS_PAGE_SIZE = 20;

type TicketsFetch = (url: string) => Promise<Response>;

export interface TicketsPage {
  tickets: WorkspaceTicket[];
  /** True when the returned page filled `limit`, so another page may exist. */
  hasMore: boolean;
}

/**
 * Build the `/api/tickets` query string for a single page of the index list.
 * Kept separate from the fetch so it can be unit-tested without a network stub.
 *
 * `sort`/`priority` are only emitted when non-default (`priority` sort / a
 * specific priority) so the default request stays byte-identical to before and
 * shareable URLs stay clean.
 */
export function ticketsPageUrl({
  status,
  workspace,
  limit,
  offset,
  sort = "recency",
  priority = "all",
}: {
  status: TicketListStatus;
  workspace?: string | null;
  limit: number;
  offset: number;
  sort?: TicketListSort;
  priority?: TicketPriorityFilter;
}): string {
  const params = new URLSearchParams();
  params.set("status", status);
  if (workspace) params.set("workspace", workspace);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort === "priority") params.set("sort", "priority");
  if (priority !== "all") params.set("priority", priority);
  return `/api/tickets?${params.toString()}`;
}

/**
 * Fetch one page of tickets for the index page. `hasMore` is inferred from a
 * full page (`tickets.length === limit`): a naive offset signal that's good
 * enough for this low-stakes list. The signal still holds once `sort`/`priority`
 * are server-side, since the filtered+sorted query itself is what's paged.
 */
export async function fetchTicketsPage({
  status,
  workspace,
  limit,
  offset,
  sort = "recency",
  priority = "all",
  fetcher = fetch,
}: {
  status: TicketListStatus;
  workspace?: string | null;
  limit: number;
  offset: number;
  sort?: TicketListSort;
  priority?: TicketPriorityFilter;
  fetcher?: TicketsFetch;
}): Promise<TicketsPage> {
  const res = await fetcher(
    ticketsPageUrl({
      status,
      limit,
      offset,
      sort,
      priority,
      ...(workspace !== undefined ? { workspace } : {}),
    }),
  );
  if (!res.ok) throw new Error(`Failed to load tickets (${res.status})`);
  const data = (await res.json()) as { tickets: WorkspaceTicket[] };
  const tickets = data.tickets ?? [];
  return { tickets, hasMore: tickets.length === limit };
}
