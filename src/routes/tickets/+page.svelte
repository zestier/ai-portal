<script lang="ts">
  import type { PageData } from "./$types";
  import type { WorkspaceTicket, WorkspaceTicketStatus } from "$lib/types";
  import { TICKET_PRIORITIES } from "$lib/types";
  import Pill from "$lib/components/ui/Pill.svelte";
  import { priorityLabel, priorityTone } from "$lib/tickets/priority";
  import {
    fetchTicketsPage,
    type TicketListSort,
    type TicketListStatus,
    type TicketPriorityFilter,
  } from "$lib/client/tickets-list";
  import { replaceState } from "$app/navigation";
  import { untrack } from "svelte";

  let { data }: { data: PageData } = $props();

  const tabs: { value: TicketListStatus; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "done", label: "Done" },
    { value: "archived", label: "Archived" },
    { value: "all", label: "All" },
  ];

  const statusLabel: Record<WorkspaceTicketStatus, string> = {
    open: "Open",
    done: "Done",
    archived: "Archived",
  };

  const statusTone: Record<
    WorkspaceTicketStatus,
    "accent" | "success" | "neutral"
  > = {
    open: "accent",
    done: "success",
    archived: "neutral",
  };

  const emptyLabel: Record<TicketListStatus, string> = {
    open: "No open tickets.",
    done: "No done tickets.",
    archived: "No archived tickets.",
    all: "No tickets yet.",
  };

  const workspace = untrack(() => data.ticketWorkspace);
  const pageSize = untrack(() => data.pageSize);

  let status = $state<TicketListStatus>(untrack(() => data.initialStatus));
  let items = $state<WorkspaceTicket[]>(untrack(() => data.initialTickets));
  let hasMore = $state(untrack(() => data.initialHasMore));
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  // Priority filter + sort are server-driven: changing either resets to page 0
  // and refetches the correctly ordered/filtered window. They're seeded from the
  // loader (URL-derived) so first paint matches a shared/reloaded link.
  let priorityFilter = $state<TicketPriorityFilter>(
    untrack(() => data.initialPriority ?? "all"),
  );
  let sort = $state<TicketListSort>(
    untrack(() => data.initialSort ?? "recency"),
  );
  const sortByPriority = $derived(sort === "priority");

  function fmtDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  // Reflect sort + filter in the URL (omitting defaults) without re-running the
  // loader, so the view is shareable and survives reload.
  function syncUrl() {
    const params = new URLSearchParams();
    if (sort === "priority") params.set("sort", "priority");
    if (priorityFilter !== "all") params.set("priority", priorityFilter);
    const qs = params.toString();
    replaceState(qs ? `?${qs}` : location.pathname, {});
  }

  async function loadFirstPage() {
    if (!workspace) return;
    loading = true;
    errorMsg = null;
    try {
      const page = await fetchTicketsPage({
        status,
        workspace,
        limit: pageSize,
        offset: 0,
        sort,
        priority: priorityFilter,
      });
      items = page.tickets;
      hasMore = page.hasMore;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load tickets.";
    } finally {
      loading = false;
    }
  }

  async function selectStatus(next: TicketListStatus) {
    if (next === status || loading) return;
    status = next;
    items = [];
    hasMore = false;
    await loadFirstPage();
  }

  async function selectPriority(next: TicketPriorityFilter) {
    if (next === priorityFilter || loading) return;
    priorityFilter = next;
    syncUrl();
    await loadFirstPage();
  }

  async function toggleSort() {
    if (loading) return;
    sort = sort === "priority" ? "recency" : "priority";
    syncUrl();
    await loadFirstPage();
  }

  async function loadMore() {
    if (loading || !hasMore || !workspace) return;
    loading = true;
    errorMsg = null;
    try {
      const page = await fetchTicketsPage({
        status,
        workspace,
        limit: pageSize,
        offset: items.length,
        sort,
        priority: priorityFilter,
      });
      items = [...items, ...page.tickets];
      hasMore = page.hasMore;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load tickets.";
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head><title>Tickets</title></svelte:head>

<div class="wrap">
  <a class="back eyebrow" href="/">← Back to portal</a>

  <header class="page-header">
    <div class="heading">
      <p class="eyebrow">Workspace tickets</p>
      <h1>Tickets</h1>
    </div>
    {#if workspace}
      <p class="workspace mono">{workspace}</p>
    {/if}
  </header>

  {#if !workspace}
    <p class="empty muted">
      No active workspace. Open a conversation to see its workspace tickets
      here.
    </p>
  {:else}
    <div class="tabs" role="tablist" aria-label="Ticket status">
      {#each tabs as tab (tab.value)}
        <button
          class="tab"
          role="tab"
          aria-selected={status === tab.value}
          class:active={status === tab.value}
          disabled={loading && status === tab.value}
          onclick={() => selectStatus(tab.value)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    {#if errorMsg}
      <p class="empty error">{errorMsg}</p>
    {/if}

    <div class="controls">
      <label class="control">
        <span class="control-label">Priority</span>
        <select
          class="select"
          value={priorityFilter}
          onchange={(e) =>
            selectPriority(e.currentTarget.value as TicketPriorityFilter)}
          disabled={loading}
          aria-label="Filter by priority"
        >
          <option value="all">All priorities</option>
          {#each TICKET_PRIORITIES as p (p)}
            <option value={p}>{priorityLabel[p]}</option>
          {/each}
        </select>
      </label>
      <button
        class="tab sort-toggle"
        class:active={sortByPriority}
        aria-pressed={sortByPriority}
        disabled={loading}
        onclick={toggleSort}
      >
        Sort by priority
      </button>
    </div>

    {#if items.length === 0 && !loading}
      <p class="empty muted">
        {priorityFilter === "all"
          ? emptyLabel[status]
          : "No tickets match this priority."}
      </p>
    {:else}
      <ul class="ticket-list">
        {#each items as ticket (ticket.id)}
          <li class="ticket-row">
            <a class="ticket-link" href={`/tickets/${ticket.id}`}>
              <span class="ticket-title">{ticket.title}</span>
            </a>
            <span class="ticket-meta">
              <span class="updated muted">{fmtDate(ticket.updatedAt)}</span>
              <Pill tone={priorityTone[ticket.priority]}>{ticket.priority}</Pill
              >
              <Pill tone={statusTone[ticket.status]}
                >{statusLabel[ticket.status]}</Pill
              >
            </span>
          </li>
        {/each}
      </ul>

      {#if hasMore}
        <div class="load-more">
          <button class="btn" disabled={loading} onclick={loadMore}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .wrap {
    width: 100%;
    max-width: 760px;
    min-width: 0;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 3rem;
    height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .back {
    align-self: flex-start;
    color: var(--text-muted);
    text-decoration: none;
  }
  .back:hover {
    color: var(--text);
  }
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .heading {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .page-header h1 {
    margin: 0;
    line-height: 1.25;
  }
  .workspace {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    overflow-wrap: anywhere;
    text-align: right;
  }
  .mono {
    font-family: var(--mono);
  }
  .tabs {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
  }
  .tab {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    padding: 0.3rem 0.75rem;
    cursor: pointer;
    font-size: var(--fs-sm);
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    background: var(--surface-2);
    border-color: var(--accent);
    color: var(--text);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .control {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .control-label {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .select {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 0.3rem 0.5rem;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .sort-toggle[aria-pressed="true"] {
    background: var(--surface-2);
    border-color: var(--accent);
    color: var(--text);
  }
  .ticket-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .ticket-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-width: 0;
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .ticket-row:hover {
    background: var(--surface-2);
  }
  .ticket-link {
    min-width: 0;
    color: var(--text);
    text-decoration: none;
    flex: 1;
  }
  .ticket-link:hover .ticket-title {
    color: var(--accent);
  }
  .ticket-title {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ticket-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }
  .updated {
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .empty {
    margin: 0;
    font-size: var(--fs-md);
  }
  .error {
    color: var(--danger, #c0392b);
  }
  .load-more {
    display: flex;
    justify-content: center;
    margin-top: var(--space-2);
  }
  @media (max-width: 768px) {
    .wrap {
      padding: 1.5rem 1.25rem 2.5rem var(--mobile-hamburger-inset);
      gap: var(--space-3);
    }
    .page-header h1 {
      font-size: var(--fs-2xl);
    }
  }
</style>
