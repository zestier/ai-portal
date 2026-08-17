<script lang="ts">
  import type { PageData } from "./$types";
  import type {
    ChatPromptTemplate,
    WorkspaceTicket,
    WorkspaceTicketPriority,
    WorkspaceTicketStatus,
  } from "$lib/types";
  import { TICKET_PRIORITIES } from "$lib/types";
  import Pill from "$lib/components/ui/Pill.svelte";
  import { priorityLabel, priorityTone } from "$lib/tickets/priority";
  import Alert from "$lib/components/ui/Alert.svelte";
  import Modal from "$lib/components/ui/Modal.svelte";
  import { renderMarkdown } from "$lib/client/markdown";
  import { copyableCodeBlocks } from "$lib/client/copyable-code-blocks";
  import { goto, invalidateAll } from "$app/navigation";
  import {
    ticketStatusActions,
    type TicketStatusAction,
  } from "$lib/tickets/actions";
  import {
    patchTicketStatus,
    patchTicketPriority,
  } from "$lib/client/ticket-status";
  import { deleteWorkspaceTicket } from "$lib/client/ticket-archive";
  import {
    createTicketDraftChat,
    createTicketLaunchChat,
    defaultOptions as ticketLaunchDefaults,
  } from "$lib/client/ticket-chat-launch";
  import LaunchReviewDialog from "$lib/components/LaunchReviewDialog.svelte";
  import type { TemplateLaunchOptions } from "$lib/prompt-templates";
  import { onMount } from "svelte";

  let { data }: { data: PageData } = $props();

  // `renderMarkdown` relies on DOMPurify, which needs a real DOM, so it only
  // runs in the browser. Rendering markdown after mount keeps SSR output and
  // the first client render identical (both show the plain-text fallback),
  // avoiding a hydration mismatch — the same approach the chat view uses.
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });

  const ticket = $derived(data.ticket);

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

  const blocked = $derived(data.dependsOn.some((d) => d.status === "open"));

  // Status buttons re-derive from the current status, so an in-place refresh
  // (invalidateAll) after a transition swaps the toolbar to the new matrix.
  const statusActions = $derived(ticketStatusActions(ticket.status));

  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  let archiveOpen = $state(false);
  let deleteOpen = $state(false);
  // Ticket action awaiting confirmation in the review dialog.
  let reviewingAction = $state<ChatPromptTemplate | null>(null);

  function flashError(msg: string) {
    errorMsg = msg;
  }

  async function applyStatus(target: WorkspaceTicketStatus) {
    if (busy) return;
    busy = true;
    errorMsg = null;
    try {
      const result = await patchTicketStatus({
        ticketId: ticket.id,
        status: target,
        fetcher: fetch,
      });
      if (!result.ok) {
        flashError(`Could not update ticket (${result.status ?? "network"})`);
        return;
      }
      await invalidateAll();
    } catch {
      flashError("Could not update ticket");
    } finally {
      busy = false;
    }
  }

  function runStatusAction(action: TicketStatusAction) {
    if (busy) return;
    if (action.confirm) {
      archiveOpen = true;
      return;
    }
    void applyStatus(action.target);
  }

  async function applyPriority(target: WorkspaceTicketPriority) {
    if (busy || target === ticket.priority) return;
    busy = true;
    errorMsg = null;
    try {
      const result = await patchTicketPriority({
        ticketId: ticket.id,
        priority: target,
        fetcher: fetch,
      });
      if (!result.ok) {
        flashError(`Could not update priority (${result.status ?? "network"})`);
        return;
      }
      await invalidateAll();
    } catch {
      flashError("Could not update priority");
    } finally {
      busy = false;
    }
  }

  function onPriorityChange(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement)
      .value as WorkspaceTicketPriority;
    void applyPriority(value);
  }

  function confirmArchive() {
    archiveOpen = false;
    void applyStatus("archived");
  }

  function cancelArchive() {
    archiveOpen = false;
  }

  function requestDelete() {
    if (busy) return;
    deleteOpen = true;
  }

  function cancelDelete() {
    deleteOpen = false;
  }

  async function confirmDelete() {
    deleteOpen = false;
    if (busy) return;
    busy = true;
    errorMsg = null;
    try {
      const result = await deleteWorkspaceTicket({
        ticketId: ticket.id,
        workspace: ticket.workspaceKey,
        fetcher: fetch,
      });
      if (!result.ok) {
        flashError(`Could not delete ticket (${result.status ?? "network"})`);
        return;
      }
      await goto("/tickets");
    } catch {
      flashError("Could not delete ticket");
    } finally {
      busy = false;
    }
  }

  /**
   * Entry point for the ticket-action buttons. `review` actions open the review
   * dialog first; the rest launch with the action's own settings.
   */
  function startChatAction(action: ChatPromptTemplate) {
    if (busy) return;
    errorMsg = null;
    if (action.launchBehavior === "review") {
      reviewingAction = action;
      return;
    }
    void runChatAction(
      action,
      ticketLaunchDefaults(action, ticket as WorkspaceTicket),
    );
  }

  async function runChatAction(
    action: ChatPromptTemplate,
    options: TemplateLaunchOptions,
  ) {
    if (busy) return;
    busy = true;
    errorMsg = null;
    try {
      if (action.launchBehavior === "draft") {
        const result = await createTicketDraftChat({
          ticket: ticket as WorkspaceTicket,
          template: action,
          workdir: ticket.workspaceKey,
          options,
          fetcher: fetch,
        });
        if (!result.ok) {
          flashError(`Could not create chat (${result.status ?? "network"})`);
          return;
        }
        reviewingAction = null;
        location.href = result.href;
      } else {
        const result = await createTicketLaunchChat({
          ticket: ticket as WorkspaceTicket,
          template: action,
          workdir: ticket.workspaceKey,
          options,
          fetcher: fetch,
        });
        if (!result.ok) {
          flashError(
            result.stage === "create"
              ? `Could not create chat (${result.status})`
              : `Could not launch ticket chat (${result.status})`,
          );
          return;
        }
        reviewingAction = null;
        location.href = result.href;
      }
    } catch {
      flashError("Could not launch ticket chat");
    } finally {
      busy = false;
    }
  }

  function fmtDate(ms: number): string {
    return new Date(ms).toLocaleString();
  }
</script>

<svelte:head><title>{ticket.title} — Ticket</title></svelte:head>

<div class="wrap">
  <a class="back eyebrow" href="/">← Back to portal</a>

  <header class="ticket-header">
    <div class="heading">
      <p class="eyebrow">Workspace ticket</p>
      <h1>{ticket.title}</h1>
    </div>
    <div class="header-pills">
      <Pill tone={priorityTone[ticket.priority]}>{ticket.priority}</Pill>
      <Pill tone={statusTone[ticket.status]}>{statusLabel[ticket.status]}</Pill>
    </div>
  </header>

  <div class="toolbar" role="group" aria-label="Ticket actions">
    {#each statusActions as action (action.id)}
      <button
        class="btn sm"
        class:primary={action.id === "mark-done"}
        class:danger={action.danger}
        disabled={busy}
        onclick={() => runStatusAction(action)}
      >
        {action.label}
      </button>
    {/each}
    {#each data.ticketActions as action (action.id)}
      <button
        class="btn sm"
        title={action.description || action.title}
        disabled={busy}
        onclick={() => startChatAction(action)}
      >
        {action.title}
      </button>
    {/each}
    <button class="btn sm danger" disabled={busy} onclick={requestDelete}>
      Delete
    </button>
  </div>

  {#if errorMsg}
    <Alert kind="error" dismissible ondismiss={() => (errorMsg = null)}
      >{errorMsg}</Alert
    >
  {/if}

  <dl class="meta">
    <div>
      <dt class="eyebrow">Priority</dt>
      <dd>
        <select
          class="select priority-select"
          value={ticket.priority}
          disabled={busy}
          aria-label="Ticket priority"
          onchange={onPriorityChange}
        >
          {#each TICKET_PRIORITIES as p (p)}
            <option value={p}>{priorityLabel[p]}</option>
          {/each}
        </select>
      </dd>
    </div>
    <div>
      <dt class="eyebrow">ID</dt>
      <dd class="mono">{ticket.id}</dd>
    </div>
    <div>
      <dt class="eyebrow">Workspace</dt>
      <dd class="mono">{ticket.workspaceKey}</dd>
    </div>
    <div>
      <dt class="eyebrow">Created</dt>
      <dd>{fmtDate(ticket.createdAt)}</dd>
    </div>
    <div>
      <dt class="eyebrow">Updated</dt>
      <dd>{fmtDate(ticket.updatedAt)}</dd>
    </div>
  </dl>

  <section class="card">
    <h2 class="eyebrow">Details</h2>
    {#if ticket.body.trim()}
      {#if mounted}
        <div class="markdown-body" use:copyableCodeBlocks>
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(ticket.body)}
        </div>
      {:else}
        <p class="fallback">{ticket.body}</p>
      {/if}
    {:else}
      <p class="empty muted">No details.</p>
    {/if}
  </section>

  <section class="card">
    <h2 class="eyebrow">Plan</h2>
    {#if ticket.plan.trim()}
      {#if mounted}
        <div class="markdown-body" use:copyableCodeBlocks>
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(ticket.plan)}
        </div>
      {:else}
        <p class="fallback">{ticket.plan}</p>
      {/if}
    {:else}
      <p class="empty muted">No plan recorded.</p>
    {/if}
  </section>

  <section class="card">
    <div class="card-head">
      <h2 class="eyebrow">Blocked by</h2>
      {#if data.dependsOn.length > 0}
        <Pill tone={blocked ? "warning" : "success"}>
          {blocked ? "Blocked" : "Ready to start"}
        </Pill>
      {/if}
    </div>
    {#if data.dependsOn.length === 0}
      <p class="empty muted">Not blocked by anything — ready to start.</p>
    {:else}
      <ul class="dep-list">
        {#each data.dependsOn as dep (dep.id)}
          <li>
            <a class="dep-link" href={`/tickets/${dep.id}`}>{dep.title}</a>
            <Pill tone={dep.status === "open" ? "warning" : "success"}>
              {statusLabel[dep.status]}
            </Pill>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card">
    <h2 class="eyebrow">Blocks</h2>
    {#if data.dependents.length === 0}
      <p class="empty muted">
        Blocks nothing — no other ticket is waiting on this.
      </p>
    {:else}
      <ul class="dep-list">
        {#each data.dependents as dep (dep.id)}
          <li>
            <a class="dep-link" href={`/tickets/${dep.id}`}>{dep.title}</a>
            <Pill tone={statusTone[dep.status]}>{statusLabel[dep.status]}</Pill>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<Modal
  open={archiveOpen}
  onClose={cancelArchive}
  role="alertdialog"
  ariaLabel="Archive ticket"
  width="min(420px, 100%)"
>
  <div class="confirm">
    <h2 class="confirm-title">Archive ticket?</h2>
    <p class="confirm-body">
      This hides the ticket from the open list. You can reopen it later from
      this page.
    </p>
    <div class="confirm-actions">
      <button class="btn sm ghost" onclick={cancelArchive}>Cancel</button>
      <button class="btn sm danger primary" onclick={confirmArchive}
        >Archive</button
      >
    </div>
  </div>
</Modal>

<Modal
  open={deleteOpen}
  onClose={cancelDelete}
  role="alertdialog"
  ariaLabel="Delete ticket permanently"
  width="min(420px, 100%)"
>
  <div class="confirm">
    <h2 class="confirm-title">Delete ticket permanently?</h2>
    <p class="confirm-body">
      This permanently removes the ticket and its blocking links from the
      database. This cannot be undone.
    </p>
    <div class="confirm-actions">
      <button class="btn sm ghost" onclick={cancelDelete}>Cancel</button>
      <button class="btn sm danger primary" onclick={confirmDelete}
        >Delete permanently</button
      >
    </div>
  </div>
</Modal>

{#if reviewingAction}
  <LaunchReviewDialog
    open
    templateTitle={reviewingAction.title}
    defaults={ticketLaunchDefaults(reviewingAction, ticket as WorkspaceTicket)}
    {busy}
    error={errorMsg}
    onLaunch={(options) => {
      const action = reviewingAction;
      if (action) void runChatAction(action, options);
    }}
    onCancel={() => {
      reviewingAction = null;
      errorMsg = null;
    }}
  />
{/if}

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
  .ticket-header {
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
  .ticket-header h1 {
    margin: 0;
    overflow-wrap: anywhere;
    /* Desktop keeps the browser-default h1 size (matching Settings); a tighter
		   line-height keeps a long, multi-line title compact. Mobile shrinks it via
		   a --fs-* token below so a long title doesn't dominate the viewport. */
    line-height: 1.25;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .header-pills {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
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
  .select:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .priority-select {
    width: 100%;
    max-width: 220px;
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .confirm-title {
    margin: 0;
    font-size: var(--fs-lg);
  }
  .confirm-body {
    margin: 0;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3) var(--space-4);
    margin: 0;
  }
  .meta div {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .meta dd {
    margin: 0;
    font-size: var(--fs-md);
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--mono);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .card h2 {
    margin: 0;
  }
  .fallback {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .empty {
    margin: 0;
    font-size: var(--fs-md);
  }
  .dep-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .dep-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-width: 0;
  }
  .dep-link {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dep-link:hover {
    color: var(--accent);
  }
  @media (max-width: 768px) {
    .wrap {
      padding: 1.5rem 1.25rem 2.5rem var(--mobile-hamburger-inset);
      gap: var(--space-3);
    }
    .ticket-header h1 {
      font-size: var(--fs-2xl);
    }
  }
</style>
