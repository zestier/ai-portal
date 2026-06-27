<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import SidebarRail from '$lib/components/SidebarRail.svelte';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		resolveInitialSidebarOpen,
		SIDEBAR_DESKTOP_MIN_WIDTH,
		SIDEBAR_MOBILE_MAX_WIDTH,
		SIDEBAR_STORAGE_KEY
	} from '$lib/client/sidebar';

	let { data, children } = $props();

	// Default to open for SSR; the real value is resolved on mount where
	// localStorage and matchMedia are available.
	let sidebarOpen = $state(true);
	let hydrated = $state(false);

	const isLoginPage = $derived($page.url.pathname === '/login');

	function closeOnMobileNavigate() {
		if (window.matchMedia(`(max-width: ${SIDEBAR_MOBILE_MAX_WIDTH}px)`).matches) {
			sidebarOpen = false;
		}
	}

	onMount(() => {
		sidebarOpen = resolveInitialSidebarOpen({
			getStored: () => localStorage.getItem(SIDEBAR_STORAGE_KEY),
			isDesktop: () => window.matchMedia(`(min-width: ${SIDEBAR_DESKTOP_MIN_WIDTH}px)`).matches
		});
		hydrated = true;
	});

	$effect(() => {
		if (hydrated) {
			localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen));
		}
	});
</script>

{#if isLoginPage || !data.user}
	{@render children()}
{:else}
	<div class="layout" class:collapsed={!sidebarOpen} class:preload={!hydrated}>
		<div class="rail-wrap">
			<SidebarRail
				user={data.user}
				expanded={sidebarOpen}
				ontoggle={() => (sidebarOpen = !sidebarOpen)}
				onnavigate={closeOnMobileNavigate}
			/>
		</div>
		<button
			type="button"
			class="mobile-menu btn icon ghost"
			class:hidden={sidebarOpen}
			aria-label="Open menu"
			title="Open menu"
			onclick={() => (sidebarOpen = true)}
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M2 4h12" />
				<path d="M2 8h12" />
				<path d="M2 12h12" />
			</svg>
		</button>
		{#if sidebarOpen}
			<button
				type="button"
				class="scrim"
				aria-label="Close sidebar"
				onclick={() => (sidebarOpen = false)}
			></button>
		{/if}
		<aside class="sidebar" class:open={sidebarOpen} aria-hidden={!sidebarOpen}>
			<div class="drawer-header">
				<span class="drawer-brand">Zestier's AI Portal</span>
				<button
					type="button"
					class="drawer-close btn icon ghost"
					aria-label="Close menu"
					title="Close menu"
					onclick={() => (sidebarOpen = false)}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M4 4l8 8" />
						<path d="M12 4l-8 8" />
					</svg>
				</button>
			</div>
			<Sidebar
				conversations={data.conversations}
				awaitingConversationIds={data.awaitingConversationIds}
				tickets={data.tickets}
				ticketCount={data.ticketCount}
				ticketWorkspace={data.ticketWorkspace}
				ticketActions={data.ticketActions}
				user={data.user}
				onnavigate={closeOnMobileNavigate}
			/>
		</aside>
		<main class="main">
			{@render children()}
		</main>
	</div>
{/if}

<style>
	.layout {
		display: grid;
		grid-template-columns: 44px 280px 1fr;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
		transition: grid-template-columns 150ms ease-out;
	}
	.layout.collapsed {
		grid-template-columns: 44px 0 1fr;
	}
	.rail-wrap {
		display: contents;
	}
	.sidebar {
		background: var(--surface);
		border-right: 1px solid var(--border);
		overflow-y: auto;
		overflow-x: hidden;
		min-width: 0;
	}
	.main {
		overflow: hidden;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.scrim {
		display: none;
	}
	.drawer-header {
		display: none;
	}
	.mobile-menu {
		display: none;
	}
	.layout.preload,
	.layout.preload .sidebar {
		transition: none;
	}
	/* Pre-hydration: resolve the collapsed visuals from the inline script so
	   the first paint matches the persisted preference without a flash. */
	:global(html[data-sidebar='closed']) .layout.preload {
		grid-template-columns: 44px 0 1fr;
	}

	@media (max-width: 768px) {
		.layout,
		.layout.collapsed {
			grid-template-columns: 1fr;
		}
		.rail-wrap {
			display: none;
		}
		.mobile-menu {
			display: inline-flex;
			position: fixed;
			top: var(--space-2);
			left: var(--space-2);
			z-index: var(--z-overlay);
		}
		.mobile-menu.hidden {
			display: none;
		}
		.sidebar {
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			width: 80%;
			max-width: 320px;
			transform: translateX(-100%);
			transition: transform 150ms ease-out;
			z-index: calc(var(--z-sidebar) + 1);
		}
		.sidebar.open {
			transform: translateX(0);
		}
		.drawer-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: var(--space-2);
			padding: var(--space-2) var(--space-3);
			border-bottom: 1px solid var(--border);
		}
		.drawer-brand {
			font-weight: 600;
			font-size: var(--fs-lg);
			color: var(--text);
		}
		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			background: var(--overlay);
			border: 0;
			padding: 0;
			cursor: pointer;
			z-index: var(--z-sidebar);
		}
		:global(html[data-sidebar='closed']) .layout.preload .sidebar {
			transform: translateX(-100%);
		}
	}
</style>
