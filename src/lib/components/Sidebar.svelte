<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import type { Conversation, User, WorkspaceTicket } from '$lib/types';
	import Alert from '$lib/components/ui/Alert.svelte';
	import PromptTemplateLauncher from '$lib/components/PromptTemplateLauncher.svelte';
	import type { TicketChatMode } from '$lib/client/tickets';
	import {
		ticketChatConversationMode,
		ticketChatPrompt,
		ticketChatTitle
	} from '$lib/client/tickets';
	import { createTicketDraftChat } from '$lib/client/ticket-chat-launch';
	import { archiveWorkspaceTicket } from '$lib/client/ticket-archive';

	let {
		conversations,
		tickets,
		ticketCount,
		ticketWorkspace,
		user,
		onnavigate
	}: {
		conversations: Conversation[];
		tickets: WorkspaceTicket[];
		ticketCount: number;
		ticketWorkspace: string | null;
		user: User | null;
		onnavigate?: () => void;
	} = $props();

	let openMenuId = $state<string | null>(null);
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let archivedOpen = $state(false);
	let selectMode = $state(false);
	let selected = $state(new Set<string>());
	let bulkBusy = $state(false);
	let ticketsOpen = $state(false);
	let ticketDraftOpen = $state(false);
	let ticketTitle = $state('');
	let ticketBusy = $state(false);
	let ticketLaunchId = $state<string | null>(null);
	let ticketArchiveId = $state<string | null>(null);
	let expandedTicketIds = $state(new Set<string>());
	let errorMsg = $state<string | null>(null);
	let errorTimer: ReturnType<typeof setTimeout> | null = null;
	let firstMenuItem: HTMLButtonElement | null = $state(null);
	let renameInput: HTMLInputElement | null = $state(null);

	const active = $derived(conversations.filter((c) => c.archivedAt == null));
	const archived = $derived(conversations.filter((c) => c.archivedAt != null));
	const selectedActiveCount = $derived(active.filter((c) => selected.has(c.id)).length);
	const allActiveSelected = $derived(active.length > 0 && selectedActiveCount === active.length);

	function flashError(msg: string) {
		errorMsg = msg;
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = setTimeout(() => (errorMsg = null), 5000);
	}

	async function api(
		url: string,
		init: globalThis.RequestInit,
		errLabel: string
	): Promise<boolean> {
		try {
			const res = await fetch(url, init);
			if (!res.ok) {
				flashError(`${errLabel} failed (${res.status})`);
				return false;
			}
			return true;
		} catch {
			flashError(`${errLabel} failed`);
			return false;
		}
	}

	async function addTicket() {
		const title = ticketTitle.trim();
		if (!title || !ticketWorkspace || ticketBusy) return;
		ticketBusy = true;
		try {
			const ok = await api(
				'/api/tickets',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title, workspace: ticketWorkspace })
				},
				'Add ticket'
			);
			if (ok) {
				ticketTitle = '';
				ticketDraftOpen = false;
				await invalidateAll();
			}
		} finally {
			ticketBusy = false;
		}
	}

	function toggleTickets() {
		ticketsOpen = !ticketsOpen;
		if (!ticketsOpen) ticketDraftOpen = false;
	}

	function toggleTicketDraft() {
		if (!ticketWorkspace) return;
		ticketsOpen = true;
		ticketDraftOpen = !ticketDraftOpen;
	}

	function isTicketExpanded(ticketId: string): boolean {
		return expandedTicketIds.has(ticketId);
	}

	function toggleTicketExpanded(ticketId: string) {
		const next = new Set(expandedTicketIds);
		if (next.has(ticketId)) {
			next.delete(ticketId);
		} else {
			next.add(ticketId);
		}
		expandedTicketIds = next;
	}

	function collapseTicket(ticketId: string) {
		const next = new Set(expandedTicketIds);
		next.delete(ticketId);
		expandedTicketIds = next;
	}

	async function launchTicketChat(ticket: WorkspaceTicket, mode: TicketChatMode) {
		if (ticketLaunchId || ticketArchiveId === ticket.id) return;
		ticketLaunchId = ticket.id;
		let conversationId: string | null = null;
		try {
			const convRes = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: ticketChatTitle(ticket, mode),
					workdir: ticketWorkspace ?? undefined,
					mode: ticketChatConversationMode(mode)
				})
			});
			if (!convRes.ok) {
				flashError(`Could not create chat (${convRes.status})`);
				return;
			}
			const body = await convRes.json();
			conversationId = body.conversation.id;
			const turnRes = await fetch(`/api/conversations/${conversationId}/turns`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: ticketChatPrompt(ticket, mode) })
			});
			if (!turnRes.ok) {
				await api(
					`/api/conversations/${conversationId}`,
					{ method: 'DELETE' },
					'Clean up failed ticket chat'
				);
				flashError(`Could not launch ticket chat (${turnRes.status})`);
				return;
			}
			await invalidateAll();
			onnavigate?.();
			location.href = `/conversations/${conversationId}`;
		} catch {
			if (conversationId) {
				await api(
					`/api/conversations/${conversationId}`,
					{ method: 'DELETE' },
					'Clean up failed ticket chat'
				);
			}
			flashError('Could not launch ticket chat');
		} finally {
			ticketLaunchId = null;
		}
	}

	async function openTicketDraft(ticket: WorkspaceTicket, mode: TicketChatMode = 'do') {
		if (ticketLaunchId || ticketArchiveId === ticket.id) return;
		ticketLaunchId = ticket.id;
		try {
			const result = await createTicketDraftChat({
				ticket,
				mode,
				workdir: ticketWorkspace,
				fetcher: fetch
			});
			if (!result.ok) {
				flashError(`Could not create chat (${result.status ?? 'network'})`);
				return;
			}
			await invalidateAll();
			onnavigate?.();
			location.href = result.href;
		} catch {
			flashError('Could not open ticket draft');
		} finally {
			ticketLaunchId = null;
		}
	}

	async function archiveTicket(ticket: WorkspaceTicket) {
		if (ticketArchiveId || ticketLaunchId) return;
		ticketArchiveId = ticket.id;
		try {
			const result = await archiveWorkspaceTicket({
				ticketId: ticket.id,
				workspace: ticketWorkspace,
				fetcher: fetch
			});
			if (!result.ok) {
				flashError(`Remove ticket failed (${result.status ?? 'network'})`);
				return;
			}
			collapseTicket(ticket.id);
			await invalidateAll();
		} catch {
			flashError('Remove ticket failed');
		} finally {
			ticketArchiveId = null;
		}
	}

	async function openMenu(id: string) {
		openMenuId = id;
		await tick();
		firstMenuItem?.focus();
	}

	function closeMenu() {
		openMenuId = null;
	}

	function toggleMenu(id: string, ev: Event) {
		ev.preventDefault();
		ev.stopPropagation();
		if (openMenuId === id) closeMenu();
		else openMenu(id);
	}

	async function startRename(c: Conversation) {
		closeMenu();
		renamingId = c.id;
		renameValue = c.title;
		await tick();
		renameInput?.focus();
		renameInput?.select();
	}

	async function commitRename(c: Conversation) {
		const next = renameValue.trim();
		const id = c.id;
		renamingId = null;
		if (!next || next === c.title) return;
		const ok = await api(
			`/api/conversations/${id}`,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: next })
			},
			'Rename'
		);
		if (ok) await invalidateAll();
	}

	function cancelRename() {
		renamingId = null;
	}

	async function setArchived(id: string, archived: boolean) {
		closeMenu();
		const ok = await api(
			`/api/conversations/${id}`,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ archived })
			},
			archived ? 'Archive' : 'Unarchive'
		);
		if (ok) await invalidateAll();
	}

	async function deleteConv(id: string) {
		closeMenu();
		if (!confirm('Delete this conversation? This cannot be undone.')) return;
		const ok = await api(`/api/conversations/${id}`, { method: 'DELETE' }, 'Delete');
		if (ok) {
			await invalidateAll();
			if (location.pathname === `/conversations/${id}`) location.href = '/';
		}
	}

	function toggleSelectMode() {
		selectMode = !selectMode;
		selected = new Set();
	}

	function toggleSelected(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function toggleSelectAllActive() {
		const next = new Set(selected);
		if (allActiveSelected) {
			for (const c of active) next.delete(c.id);
		} else {
			for (const c of active) next.add(c.id);
		}
		selected = next;
	}

	async function bulk(action: 'archive' | 'unarchive' | 'delete') {
		const ids = [...selected];
		if (ids.length === 0) return;
		if (action === 'delete') {
			if (
				!confirm(
					`Delete ${ids.length} conversation${ids.length === 1 ? '' : 's'}? This cannot be undone.`
				)
			)
				return;
		}
		bulkBusy = true;
		try {
			const results = await Promise.all(
				ids.map((id) => {
					if (action === 'delete') {
						return fetch(`/api/conversations/${id}`, { method: 'DELETE' }).then((r) => r.ok);
					}
					return fetch(`/api/conversations/${id}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ archived: action === 'archive' })
					}).then((r) => r.ok);
				})
			);
			const failed = results.filter((ok) => !ok).length;
			if (failed > 0) flashError(`${failed} of ${ids.length} ${action} operations failed`);
			await invalidateAll();
			if (action === 'delete') {
				const currentId = location.pathname.match(/^\/conversations\/([^/]+)/)?.[1];
				if (currentId && ids.includes(currentId)) location.href = '/';
			}
			selected = new Set();
			selectMode = false;
		} finally {
			bulkBusy = false;
		}
	}

	function fmt(ts: number) {
		const d = new Date(ts);
		const diff = (Date.now() - ts) / 1000;
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return d.toLocaleDateString();
	}

	function onWindowClick() {
		closeMenu();
	}

	function onWindowKey(ev: KeyboardEvent) {
		if (ev.key === 'Escape') {
			if (openMenuId) {
				closeMenu();
				ev.stopPropagation();
			} else if (renamingId) {
				cancelRename();
			}
		}
	}

	function stop(ev: Event) {
		ev.stopPropagation();
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<div class="sidebar-inner">
	<div class="top">
		<PromptTemplateLauncher
			variant="sidebar"
			onNavigate={onnavigate}
			onError={(message) => flashError(message)}
		/>
		<div class="top-meta">
			<span class="count muted">
				{active.length} chat{active.length === 1 ? '' : 's'}
			</span>
			<button
				class="btn sm ghost select-toggle"
				class:active={selectMode}
				onclick={toggleSelectMode}
				disabled={conversations.length === 0}
			>
				{selectMode ? 'Done' : 'Select'}
			</button>
		</div>
	</div>

	<section class="tickets" aria-label="Workspace tickets">
		<div class="tickets-head">
			<button
				class="section-toggle tickets-toggle"
				aria-expanded={ticketsOpen}
				aria-controls="workspace-ticket-list"
				onclick={toggleTickets}
			>
				<span class="caret" class:open={ticketsOpen}>▸</span>
				Tickets ({ticketCount})
			</button>
			<button
				class="btn sm ghost"
				title="Add ticket"
				aria-label="Add ticket"
				disabled={!ticketWorkspace}
				onclick={toggleTicketDraft}
			>
				+
			</button>
		</div>
		{#if ticketsOpen}
			<div id="workspace-ticket-list">
				{#if ticketDraftOpen}
					<form
						class="ticket-form"
						onsubmit={(e) => {
							e.preventDefault();
							addTicket();
						}}
					>
						<input
							bind:value={ticketTitle}
							maxlength="200"
							placeholder="Do this later..."
							aria-label="Ticket title"
							disabled={ticketBusy}
						/>
						<button class="btn sm" disabled={ticketBusy || !ticketTitle.trim()}>Add</button>
					</form>
				{/if}
				{#if tickets.length === 0}
					<p class="muted empty ticket-empty">No open tickets.</p>
				{:else}
					<div class="ticket-list">
						{#each tickets as ticket (ticket.id)}
							<div class="ticket">
								<div class="ticket-row">
									<button
										class="ticket-disclosure"
										title={ticket.title}
										aria-expanded={isTicketExpanded(ticket.id)}
										aria-controls={`ticket-details-${ticket.id}`}
										onclick={() => toggleTicketExpanded(ticket.id)}
									>
										<span class="caret ticket-caret" class:open={isTicketExpanded(ticket.id)}
											>▸</span
										>
										<span class="ticket-title">{ticket.title}</span>
									</button>
								</div>
								{#if isTicketExpanded(ticket.id)}
									<div class="ticket-expanded" id={`ticket-details-${ticket.id}`}>
										<div
											class="ticket-actions"
											role="group"
											aria-label={`Actions for ${ticket.title}`}
										>
											<button
												class="ticket-action"
												title="Start implementation chat"
												aria-label={`Do ticket: ${ticket.title}`}
												disabled={ticketLaunchId !== null || ticketArchiveId === ticket.id}
												onclick={() => launchTicketChat(ticket, 'do')}
											>
												Do
											</button>
											<button
												class="ticket-action"
												title="Open editable draft chat"
												aria-label={`Open draft for ticket: ${ticket.title}`}
												disabled={ticketLaunchId !== null || ticketArchiveId === ticket.id}
												onclick={() => openTicketDraft(ticket)}
											>
												Draft
											</button>
											<button
												class="ticket-action"
												title="Start ticket refinement chat"
												aria-label={`Refine ticket: ${ticket.title}`}
												disabled={ticketLaunchId !== null || ticketArchiveId === ticket.id}
												onclick={() => launchTicketChat(ticket, 'refine')}
											>
												Refine
											</button>
											<button
												class="ticket-action danger"
												title="Remove ticket from open list"
												aria-label={`Remove ticket: ${ticket.title}`}
												disabled={ticketLaunchId !== null || ticketArchiveId === ticket.id}
												onclick={() => archiveTicket(ticket)}
											>
												Remove
											</button>
										</div>
										<div class="ticket-details">
											{#if ticket.body.trim()}
												<div class="ticket-body">{ticket.body}</div>
											{:else}
												<div class="ticket-body muted">No details.</div>
											{/if}
											<div class="ticket-meta muted">ID: {ticket.id}</div>
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
					{#if ticketCount > tickets.length}
						<p class="muted ticket-more">Showing latest {tickets.length} open tickets.</p>
					{/if}
				{/if}
			</div>
		{/if}
	</section>

	{#if errorMsg}
		<div class="error-wrap">
			<Alert kind="error" dismissible ondismiss={() => (errorMsg = null)}>{errorMsg}</Alert>
		</div>
	{/if}

	<nav class="convs" aria-label="Conversations">
		{#if active.length === 0}
			<p class="muted empty">No conversations yet.</p>
		{/if}
		{#each active as c (c.id)}
			{@const isMenu = openMenuId === c.id}
			{@const isRenaming = renamingId === c.id}
			<div class="conv" class:selected={selected.has(c.id)}>
				{#if selectMode}
					<input
						type="checkbox"
						class="select-box"
						aria-label={`Select ${c.title}`}
						checked={selected.has(c.id)}
						onclick={stop}
						onchange={() => toggleSelected(c.id)}
					/>
				{/if}
				{#if isRenaming}
					<input
						bind:this={renameInput}
						bind:value={renameValue}
						class="rename-input"
						maxlength="200"
						onclick={stop}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								commitRename(c);
							} else if (e.key === 'Escape') {
								e.preventDefault();
								cancelRename();
							}
						}}
						onblur={() => commitRename(c)}
					/>
				{:else}
					<a
						class="title-area"
						href={`/conversations/${c.id}`}
						onclick={(e) => {
							if (selectMode) {
								e.preventDefault();
								toggleSelected(c.id);
							} else {
								onnavigate?.();
							}
						}}
					>
						<div class="title">{c.title}</div>
						<div class="meta muted">{fmt(c.updatedAt)}</div>
					</a>
				{/if}
				{#if !selectMode && !isRenaming}
					<button
						class="menu-btn"
						class:open={isMenu}
						title="More actions"
						aria-label={`Actions for ${c.title}`}
						aria-haspopup="true"
						aria-expanded={isMenu}
						onclick={(e) => toggleMenu(c.id, e)}
					>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
							<circle cx="3" cy="8" r="1.4" />
							<circle cx="8" cy="8" r="1.4" />
							<circle cx="13" cy="8" r="1.4" />
						</svg>
					</button>
				{/if}
				{#if isMenu}
					<div class="menu" onclick={stop} onkeydown={stop} role="presentation">
						<button bind:this={firstMenuItem} onclick={() => startRename(c)}>Rename</button>
						<button onclick={() => setArchived(c.id, true)}>Archive</button>
						<button class="danger" onclick={() => deleteConv(c.id)}>Delete</button>
					</div>
				{/if}
			</div>
		{/each}

		{#if archived.length > 0}
			<button
				class="section-toggle"
				aria-expanded={archivedOpen}
				onclick={() => (archivedOpen = !archivedOpen)}
			>
				<span class="caret" class:open={archivedOpen}>▸</span>
				Archived ({archived.length})
			</button>
			{#if archivedOpen}
				{#each archived as c (c.id)}
					{@const isMenu = openMenuId === c.id}
					{@const isRenaming = renamingId === c.id}
					<div class="conv archived" class:selected={selected.has(c.id)}>
						{#if selectMode}
							<input
								type="checkbox"
								class="select-box"
								aria-label={`Select ${c.title}`}
								checked={selected.has(c.id)}
								onclick={stop}
								onchange={() => toggleSelected(c.id)}
							/>
						{/if}
						{#if isRenaming}
							<input
								bind:this={renameInput}
								bind:value={renameValue}
								class="rename-input"
								maxlength="200"
								onclick={stop}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										commitRename(c);
									} else if (e.key === 'Escape') {
										e.preventDefault();
										cancelRename();
									}
								}}
								onblur={() => commitRename(c)}
							/>
						{:else}
							<a
								class="title-area"
								href={`/conversations/${c.id}`}
								onclick={(e) => {
									if (selectMode) {
										e.preventDefault();
										toggleSelected(c.id);
									} else {
										onnavigate?.();
									}
								}}
							>
								<div class="title">{c.title}</div>
								<div class="meta muted">{fmt(c.updatedAt)}</div>
							</a>
						{/if}
						{#if !selectMode && !isRenaming}
							<button
								class="menu-btn"
								class:open={isMenu}
								title="More actions"
								aria-label={`Actions for ${c.title}`}
								aria-haspopup="true"
								aria-expanded={isMenu}
								onclick={(e) => toggleMenu(c.id, e)}
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 16 16"
									fill="currentColor"
									aria-hidden="true"
								>
									<circle cx="3" cy="8" r="1.4" />
									<circle cx="8" cy="8" r="1.4" />
									<circle cx="13" cy="8" r="1.4" />
								</svg>
							</button>
						{/if}
						{#if isMenu}
							<div class="menu" onclick={stop} onkeydown={stop} role="presentation">
								<button bind:this={firstMenuItem} onclick={() => startRename(c)}>Rename</button>
								<button onclick={() => setArchived(c.id, false)}>Unarchive</button>
								<button class="danger" onclick={() => deleteConv(c.id)}>Delete</button>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		{/if}
	</nav>

	{#if selectMode}
		<div class="bulk-bar" role="toolbar" aria-label="Bulk actions">
			<span class="bulk-count muted">{selected.size} selected</span>
			<div class="bulk-actions">
				<button
					class="btn sm ghost"
					disabled={bulkBusy || active.length === 0}
					aria-pressed={allActiveSelected}
					onclick={toggleSelectAllActive}
				>
					{allActiveSelected ? 'Clear active' : 'Select all'}
				</button>
				<button
					class="btn sm"
					disabled={bulkBusy ||
						selected.size === 0 ||
						[...selected].every((id) => active.find((c) => c.id === id) == null)}
					onclick={() => bulk('archive')}>Archive</button
				>
				<button
					class="btn sm"
					disabled={bulkBusy ||
						selected.size === 0 ||
						[...selected].every((id) => archived.find((c) => c.id === id) == null)}
					onclick={() => bulk('unarchive')}>Unarchive</button
				>
				<button
					class="btn sm ghost danger"
					disabled={bulkBusy || selected.size === 0}
					onclick={() => bulk('delete')}>Delete</button
				>
			</div>
		</div>
	{/if}

	<div class="bottom">
		<a class="settings-link" href="/settings" onclick={onnavigate}>⚙ Settings</a>
		{#if user}
			<div class="user muted">
				{user.displayName ?? user.githubLogin}
			</div>
		{/if}
	</div>
</div>

<style>
	.sidebar-inner {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.top {
		padding: var(--space-3) var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.top-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.tickets {
		padding: 0 var(--space-3) var(--space-2);
		border-bottom: 1px solid var(--border);
		margin-bottom: var(--space-2);
	}
	.tickets-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-1);
	}
	.tickets-toggle {
		flex: 1;
		min-width: 0;
		padding: var(--space-1) 0;
	}
	.ticket-form {
		display: flex;
		gap: var(--space-1);
		margin-bottom: var(--space-2);
	}
	.ticket-form input {
		min-width: 0;
		flex: 1;
		padding: 0.25rem 0.4rem;
	}
	.ticket-empty {
		padding: 0;
		margin: var(--space-1) 0 var(--space-2);
		font-size: var(--fs-sm);
	}
	.ticket-more {
		margin: calc(-1 * var(--space-1)) 0 var(--space-2);
		font-size: var(--fs-xs);
	}
	.ticket-list {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-bottom: var(--space-2);
	}
	.ticket {
		border-radius: var(--radius-sm);
		min-width: 0;
		padding: 0.25rem 0.35rem;
	}
	.ticket:hover,
	.ticket:focus-within {
		background: var(--surface-2);
	}
	.ticket-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}
	.ticket-disclosure {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 0.25rem;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		padding: 0;
		text-align: left;
	}
	.ticket-disclosure:hover,
	.ticket-disclosure:focus-visible {
		color: var(--text);
		outline: none;
	}
	.ticket-caret {
		color: var(--text-muted);
		font-size: var(--fs-xs);
		flex-shrink: 0;
	}
	.ticket-action {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		font-size: var(--fs-xs);
		padding: 0.1rem 0.35rem;
		flex-shrink: 0;
	}
	.ticket-action:hover,
	.ticket-action:focus-visible {
		color: var(--text);
		border-color: var(--accent);
		outline: none;
	}
	.ticket-action.danger {
		margin-left: auto;
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
	}
	.ticket-action.danger:hover,
	.ticket-action.danger:focus-visible {
		color: var(--danger-text);
		border-color: var(--danger);
		background: var(--danger);
	}
	.ticket-action:disabled {
		cursor: wait;
		opacity: 0.65;
	}
	.ticket-title {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
	}
	.ticket-expanded {
		min-width: 0;
	}
	.ticket-details {
		margin: 0.3rem 0 0.15rem 1rem;
		font-size: var(--fs-xs);
		line-height: 1.35;
		color: var(--text);
	}
	.ticket-body {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.ticket-meta {
		margin-top: 0.25rem;
		font-family: var(--font-mono);
		overflow-wrap: anywhere;
	}
	.ticket-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.3rem 0 0 1rem;
		min-width: 0;
	}
	.count {
		font-size: var(--fs-xs);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.select-toggle.active {
		color: var(--accent);
	}
	.error-wrap {
		margin: 0 var(--space-3) var(--space-2);
	}
	.convs {
		flex: 1;
		overflow-y: auto;
		padding: 0 0.5rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.section-toggle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		background: transparent;
		border: 0;
		color: var(--text-muted);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 0.75rem 0.5rem 0.25rem;
		cursor: pointer;
		text-align: left;
	}
	.section-toggle:hover {
		color: var(--text);
	}
	.caret {
		display: inline-block;
		transition: transform 120ms ease-out;
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.empty {
		padding: 0 0.5rem;
		font-size: 0.9em;
	}
	.conv {
		position: relative;
		display: flex;
		align-items: stretch;
		gap: 0.4rem;
		padding: 0.4rem 0.5rem 0.4rem 0.6rem;
		border-radius: 6px;
	}
	.conv:hover,
	.conv:focus-within {
		background: var(--surface-2);
	}
	.conv.selected {
		background: color-mix(in srgb, var(--accent) 18%, var(--surface));
	}
	.conv.archived .title,
	.conv.archived .meta {
		opacity: 0.7;
	}
	.select-box {
		align-self: center;
		margin: 0;
		cursor: pointer;
	}
	.title-area {
		flex: 1;
		min-width: 0;
		display: block;
		color: inherit;
		padding-right: 0.25rem;
	}
	.title-area:hover {
		text-decoration: none;
	}
	.title {
		font-size: 0.95em;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: 0.75em;
	}
	.rename-input {
		flex: 1;
		min-width: 0;
		padding: 0.25rem 0.4rem;
		font-size: 0.95em;
	}
	.menu-btn {
		align-self: center;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		background: transparent;
		border: 0;
		color: var(--text-muted);
		border-radius: var(--radius-sm);
		cursor: pointer;
		padding: 0;
		opacity: 0;
		flex-shrink: 0;
		transition:
			background 0.12s ease,
			color 0.12s ease,
			opacity 0.12s ease;
	}
	.conv:hover .menu-btn,
	.conv:focus-within .menu-btn,
	.menu-btn:focus-visible,
	.menu-btn.open {
		opacity: 1;
	}
	@media (hover: none) {
		.menu-btn {
			opacity: 1;
		}
	}
	.menu-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.menu-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.menu {
		position: absolute;
		right: 0.4rem;
		top: 100%;
		z-index: 30;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-2);
		display: flex;
		flex-direction: column;
		min-width: 140px;
		padding: var(--space-1);
	}
	.menu button {
		background: transparent;
		border: 0;
		color: var(--text);
		text-align: left;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm);
		font-size: var(--fs-md);
		cursor: pointer;
	}
	.menu button:hover,
	.menu button:focus-visible {
		background: var(--surface-2);
		outline: none;
	}
	.menu button.danger {
		color: var(--danger);
	}
	.menu button.danger:hover,
	.menu button.danger:focus-visible {
		background: var(--danger);
		color: var(--danger-text);
	}
	.bulk-bar {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		justify-content: space-between;
		padding: var(--space-2) var(--space-3);
		border-top: 1px solid var(--border);
		background: var(--surface);
	}
	.bulk-count {
		font-size: var(--fs-sm);
	}
	.bulk-actions {
		display: inline-flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	.bottom {
		padding: 0.75rem 1rem;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.settings-link {
		color: var(--text);
	}
	.user {
		font-size: 0.8em;
	}
</style>
