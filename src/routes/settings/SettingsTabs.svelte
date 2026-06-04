<script lang="ts">
	import type { SettingsTab } from './settings-types';

	let {
		tabs,
		activeTab,
		grantCount,
		onSelect
	}: {
		tabs: SettingsTab[];
		activeTab: SettingsTab;
		grantCount: number;
		onSelect: (tab: SettingsTab) => void;
	} = $props();

	function tabLabel(tab: SettingsTab): string {
		switch (tab) {
			case 'general':
				return 'General';
			case 'prompts':
				return 'Prompts';
			case 'memory':
				return 'Memory';
			case 'permissions':
				return `Permissions (${grantCount})`;
			case 'activity':
				return 'Activity';
			case 'update':
				return 'Update';
		}
	}
</script>

<div class="settings-tabs" role="tablist" aria-label="Settings sections">
	{#each tabs as tab (tab)}
		<button
			id="settings-tab-{tab}"
			type="button"
			role="tab"
			aria-selected={activeTab === tab}
			aria-controls="settings-panel-{tab}"
			class:active={activeTab === tab}
			onclick={() => onSelect(tab)}
		>
			{tabLabel(tab)}
		</button>
	{/each}
</div>

<style>
	.settings-tabs {
		display: flex;
		gap: 0.35rem;
		margin-bottom: 1rem;
		overflow-x: auto;
		border-bottom: 1px solid var(--border);
		scroll-snap-type: x proximity;
		/* Scroll affordance: edge fade "covers" (move with content, attachment:
		   local) hide a dark shadow at whichever edge has more content to reveal. */
		background:
			linear-gradient(to right, var(--bg), transparent) 0 0,
			linear-gradient(to left, var(--bg), transparent) 100% 0,
			radial-gradient(farthest-side at 0 50%, rgba(0, 0, 0, 0.4), transparent) 0 0,
			radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.4), transparent) 100% 0;
		background-repeat: no-repeat;
		background-size:
			32px 100%,
			32px 100%,
			16px 100%,
			16px 100%;
		background-attachment: local, local, scroll, scroll;
	}
	.settings-tabs button {
		background: transparent;
		color: var(--text-muted);
		border: 0;
		border-bottom: 2px solid transparent;
		padding: 0.65rem 0.85rem;
		cursor: pointer;
		font: inherit;
		white-space: nowrap;
		scroll-snap-align: start;
	}
	.settings-tabs button:hover {
		color: var(--text);
	}
	.settings-tabs button.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
</style>
