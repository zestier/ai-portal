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

<div class="settings-tabs scroll-mask" role="tablist" aria-label="Settings sections">
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
