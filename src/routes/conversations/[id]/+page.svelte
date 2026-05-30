<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import Chat from '$lib/components/Chat.svelte';
	import ChangesTabIndicator from '$lib/components/ChangesTabIndicator.svelte';
	import FileBrowser from '$lib/components/FileBrowser.svelte';
	import MemoryInspector from '$lib/components/MemoryInspector.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	type Tab = 'chat' | 'memory' | 'changes' | 'files' | 'commits';
	const tabs: Tab[] = ['chat', 'memory', 'changes', 'files', 'commits'];

	function readTab(value: string | null): Tab {
		return value && tabs.includes(value as Tab) ? (value as Tab) : 'chat';
	}

	const tab = $derived(readTab($page.url.searchParams.get('tab')));

	async function selectTab(nextTab: Tab) {
		if (nextTab === tab) return;
		const nextUrl = new URL($page.url);
		if (nextTab === 'chat') nextUrl.searchParams.delete('tab');
		else nextUrl.searchParams.set('tab', nextTab);
		await goto(nextUrl, { keepFocus: true, noScroll: true, replaceState: true });
	}
</script>

<svelte:head>
	<title>{data.conversation.title} — Zestier's AI Portal</title>
</svelte:head>

<div class="conversation">
	<div class="tabs" role="tablist">
		<button
			role="tab"
			aria-selected={tab === 'chat'}
			class:active={tab === 'chat'}
			onclick={() => selectTab('chat')}
		>
			Chat
		</button>
		<button
			role="tab"
			aria-selected={tab === 'memory'}
			class:active={tab === 'memory'}
			onclick={() => selectTab('memory')}
		>
			Memory
		</button>
		<button
			role="tab"
			aria-selected={tab === 'changes'}
			class:active={tab === 'changes'}
			onclick={() => selectTab('changes')}
		>
			<span class="tab-label">
				<span>Changes</span>
				<ChangesTabIndicator conversationId={data.conversation.id} />
			</span>
		</button>
		<button
			role="tab"
			aria-selected={tab === 'files'}
			class:active={tab === 'files'}
			onclick={() => selectTab('files')}
		>
			Files
		</button>
		<button
			role="tab"
			aria-selected={tab === 'commits'}
			class:active={tab === 'commits'}
			onclick={() => selectTab('commits')}
		>
			Commits
		</button>
	</div>
	<div class="tab-body" class:hidden={tab !== 'chat'}>
		<Chat
			conversation={data.conversation}
			providerCapabilities={data.providerCapabilities}
			providerDisplayName={data.providerDisplayName}
			providerModels={data.providerModels}
			providerModelsError={data.providerModelsError}
			defaultModelPlaceholder={data.defaultModelPlaceholder}
			effectiveModel={data.effectiveModel}
			chatPlaceholder={data.chatPlaceholder}
			initialMessages={data.messages}
			initialUsage={data.contextUsage}
			parent={data.parent}
			initialActiveTurnId={data.activeTurnId}
			initialPendingInteractive={data.pendingInteractive}
			initialComposer={data.initialComposer}
			initialMemorySnapshot={data.memorySnapshot}
		/>
	</div>
	{#if tab === 'memory'}
		<div class="tab-body">
			<MemoryInspector conversationId={data.conversation.id} initialMemory={data.memorySnapshot} />
		</div>
	{:else if tab !== 'chat'}
		<div class="tab-body">
			<FileBrowser conversationId={data.conversation.id} pane={tab} />
		</div>
	{/if}
</div>

<style>
	.conversation {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.tabs {
		display: flex;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		flex: 0 0 auto;
	}
	/* On mobile the sidebar toggle is a fixed-position hamburger at top-left;
	   inset the tab strip so it doesn't sit underneath. */
	@media (max-width: 768px) {
		.tabs {
			padding-left: 2.75rem;
		}
	}
	.tabs button {
		background: transparent;
		color: var(--text-muted);
		border: 0;
		border-bottom: 2px solid transparent;
		padding: var(--space-2) var(--space-4);
		cursor: pointer;
		font: inherit;
	}
	.tab-label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}
	.tabs button.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.tab-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.tab-body.hidden {
		display: none;
	}
</style>
