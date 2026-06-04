<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { authLabel, type FormResult, type SettingsTab } from './settings-types';
	import type { PageData } from './$types';
	import ActivityPanel from './ActivityPanel.svelte';
	import GeneralSettings from './GeneralSettings.svelte';
	import MemoryProfilesSettings from './MemoryProfilesSettings.svelte';
	import PermissionGrants from './PermissionGrants.svelte';
	import PromptsSettings from './PromptsSettings.svelte';
	import SettingsTabs from './SettingsTabs.svelte';
	import UpdatePanel from './UpdatePanel.svelte';

	let { data, form }: { data: PageData; form: FormResult | null } = $props();

	const visibleTabs = $derived<SettingsTab[]>(
		data.enableRedeploy
			? ['general', 'prompts', 'memory', 'permissions', 'activity', 'update']
			: ['general', 'prompts', 'memory', 'permissions', 'activity']
	);

	function readTab(value: string | null, allowedTabs: SettingsTab[]): SettingsTab {
		return value && allowedTabs.includes(value as SettingsTab) ? (value as SettingsTab) : 'general';
	}

	function fallbackTab(form: FormResult | null): SettingsTab {
		if (form?.formId === 'save') return 'general';
		if (form?.formId?.includes('PromptTemplate')) return 'prompts';
		if (form?.formId?.includes('MemoryProfile')) return 'memory';
		if (
			form?.formId === 'createGrant' ||
			form?.formId === 'updateGrant' ||
			form?.formId === 'revokeGrant' ||
			form?.formId === 'revokeAllGrants' ||
			form?.formId === 'restoreSeedGrants'
		) {
			return 'permissions';
		}
		return 'general';
	}

	const activeTab = $derived.by(() => {
		const urlTab = $page.url.searchParams.get('tab');
		if (urlTab !== null) return readTab(urlTab, visibleTabs);
		return readTab(fallbackTab(form), visibleTabs);
	});

	async function selectTab(tab: SettingsTab) {
		if (tab === activeTab) return;
		const nextUrl = new URL($page.url);
		if (tab === 'general') nextUrl.searchParams.delete('tab');
		else nextUrl.searchParams.set('tab', tab);
		await goto(nextUrl, { keepFocus: true, noScroll: true, replaceState: true });
	}
</script>

<svelte:head><title>Settings — Zestier's AI Portal</title></svelte:head>

<div class="wrap">
	<header class="settings-header">
		<div>
			<p class="eyebrow">Portal preferences</p>
			<h1>Settings</h1>
		</div>
		<span
			class="auth-pill"
			class:ok={data.defaultProviderStatus.statusChecked &&
				data.defaultProviderStatus.auth.isAuthenticated}
		>
			{data.defaultProviderStatus.displayName}: {data.defaultProviderStatus.statusChecked
				? authLabel(data.defaultProviderStatus.auth)
				: 'not selected'}
		</span>
	</header>

	<SettingsTabs
		tabs={visibleTabs}
		{activeTab}
		grantCount={data.grants.length}
		onSelect={selectTab}
	/>

	{#if activeTab === 'general'}
		<GeneralSettings settings={data.settings} providers={data.providers} {form} />
	{:else if activeTab === 'prompts'}
		<PromptsSettings
			builtInTemplates={data.builtInPromptTemplates}
			promptTemplates={data.promptTemplates}
			{form}
		/>
	{:else if activeTab === 'memory'}
		<MemoryProfilesSettings profiles={data.customMemoryProfiles} {form} />
	{:else if activeTab === 'permissions'}
		<PermissionGrants grants={data.grants} {form} />
	{:else if activeTab === 'activity'}
		<ActivityPanel decisions={data.recentDecisions} />
	{:else if activeTab === 'update' && data.enableRedeploy}
		<UpdatePanel deploy={data.deploy} />
	{/if}
</div>

<style>
	.wrap {
		width: 100%;
		max-width: 960px;
		min-width: 0;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 3rem;
		height: 100%;
		overflow-y: auto;
	}
	.settings-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	h1 {
		margin: 0;
	}
	.eyebrow {
		margin: 0 0 0.25rem;
	}
	.auth-pill {
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
		font-size: 0.85em;
		padding: 0.3rem 0.7rem;
		white-space: nowrap;
	}
	.auth-pill.ok {
		border-color: var(--success);
		color: var(--success);
	}
</style>
