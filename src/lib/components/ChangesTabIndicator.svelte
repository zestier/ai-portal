<script lang="ts">
	import { untrack } from 'svelte';
	import { fetchHeadStatus, type HeadStatus } from '$lib/client/file-browser';
	import Pill from './ui/Pill.svelte';

	let { conversationId }: { conversationId: number } = $props();

	const POLL_MS = 5000;

	let head = $state<HeadStatus | null>(null);
	let error = $state<string | null>(null);
	let loadVersion = 0;

	async function load() {
		const version = ++loadVersion;
		try {
			const next = await fetchHeadStatus(conversationId);
			if (version !== loadVersion) return;
			head = next;
			error = null;
		} catch (e) {
			if (version !== loadVersion) return;
			error = e instanceof Error ? e.message : String(e);
		}
	}

	$effect(() => {
		void conversationId;
		untrack(() => {
			head = null;
			error = null;
			void load();
		});
	});

	$effect(() => {
		void conversationId;
		const id = setInterval(() => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			void load();
		}, POLL_MS);
		return () => clearInterval(id);
	});

	const dirtyCount = $derived(head?.initialized ? head.dirtyCount : 0);
	const label = $derived(
		dirtyCount > 0
			? `${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}`
			: 'No uncommitted changes'
	);
</script>

{#if !error && dirtyCount > 0}
	<span class="badge-wrap" aria-label={label} title={label}>
		<Pill tone="warning">
			<span class="dot" aria-hidden="true"></span>
			{dirtyCount}
		</Pill>
	</span>
{/if}

<style>
	.badge-wrap {
		display: inline-flex;
	}

	.dot {
		width: 0.42rem;
		height: 0.42rem;
		border-radius: 999px;
		background: currentColor;
		flex: 0 0 auto;
	}
</style>
