<script lang="ts">
	import type { PageData } from './$types';
	import type { WorkspaceTicketStatus } from '$lib/types';
	import Pill from '$lib/components/ui/Pill.svelte';
	import { renderMarkdown } from '$lib/client/markdown';
	import { copyableCodeBlocks } from '$lib/client/copyable-code-blocks';
	import { onMount } from 'svelte';

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
		open: 'Open',
		done: 'Done',
		archived: 'Archived'
	};

	const statusTone: Record<WorkspaceTicketStatus, 'accent' | 'success' | 'neutral'> = {
		open: 'accent',
		done: 'success',
		archived: 'neutral'
	};

	const blocked = $derived(data.dependsOn.some((d) => d.status === 'open'));

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
		<Pill tone={statusTone[ticket.status]}>{statusLabel[ticket.status]}</Pill>
	</header>

	<dl class="meta">
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
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="markdown" use:copyableCodeBlocks>{@html renderMarkdown(ticket.body)}</div>
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
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="markdown" use:copyableCodeBlocks>{@html renderMarkdown(ticket.plan)}</div>
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
				<Pill tone={blocked ? 'warning' : 'success'}>
					{blocked ? 'Blocked' : 'Ready to start'}
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
						<Pill tone={dep.status === 'open' ? 'warning' : 'success'}>
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
			<p class="empty muted">Blocks nothing — no other ticket is waiting on this.</p>
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
	.markdown {
		margin: 0;
		overflow-wrap: anywhere;
		line-height: 1.5;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.markdown :global(> :first-child) {
		margin-top: 0;
	}
	.markdown :global(> :last-child) {
		margin-bottom: 0;
	}
	.markdown :global(.contains-task-list) {
		list-style: none;
		padding-left: 0;
	}
	.markdown :global(.task-list-item) {
		list-style: none;
	}
	.markdown :global(.task-list-item input) {
		margin-right: var(--space-1);
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
