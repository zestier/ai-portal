<script lang="ts">
	import Alert from '$lib/components/ui/Alert.svelte';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';
	import type { CustomMemoryProfile, FormResult } from './settings-types';

	let {
		profiles,
		form
	}: {
		profiles: CustomMemoryProfile[];
		form: FormResult | null;
	} = $props();

	const openProfiles = $derived(profiles.filter((profile) => profile.status === 'open'));
	const archivedProfiles = $derived(profiles.filter((profile) => profile.status === 'archived'));
	const defaultSchemaJson = JSON.stringify(
		{
			entities: ['character', 'faction', 'location'],
			facts: {
				required: ['predicate', 'value', 'visibility']
			},
			validation: ['location_conflicts', 'secret_visibility']
		},
		null,
		2
	);

	function schemaText(profile: CustomMemoryProfile): string {
		return JSON.stringify(profile.schema, null, 2);
	}
</script>

<div
	id="settings-panel-memory"
	class="tab-panel memory-profiles"
	role="tabpanel"
	aria-labelledby="settings-tab-memory"
>
	<PanelHeader title="Memory profiles">
		{#snippet meta()}Author custom profile schemas and instructions. These are saved for inspection
			and future activation; built-in modes remain the runtime-safe choices today.{/snippet}
	</PanelHeader>

	{#if form?.formId?.includes('MemoryProfile')}
		<Alert kind={form.ok ? 'success' : 'error'}>
			{form.ok ? 'Memory profile saved.' : (form.error ?? 'Memory profile update failed.')}
		</Alert>
	{/if}

	<section class="card">
		<h3>Create custom memory profile</h3>
		<form method="POST" action="?/createMemoryProfile" class="settings-form">
			<label>
				Name
				<input name="name" maxlength="120" required placeholder="Campaign lore keeper" />
			</label>
			<label>
				Description
				<input name="description" maxlength="500" placeholder="Tracks factions, lore, and canon" />
			</label>
			<label>
				Instructions
				<textarea
					name="instructions"
					rows="5"
					maxlength="8000"
					required
					placeholder="Describe what this profile should remember and validate..."
				></textarea>
			</label>
			<label>
				Schema JSON
				<textarea name="schemaJson" rows="8" maxlength="20000" required
					>{defaultSchemaJson}</textarea
				>
			</label>
			<button class="btn primary" type="submit">Save profile</button>
		</form>
	</section>

	<section class="card">
		<div class="section-row">
			<h3>Your custom profiles</h3>
			<span class="muted small">{openProfiles.length} active</span>
		</div>
		{#if openProfiles.length === 0}
			<p class="muted empty">No custom memory profiles yet.</p>
		{:else}
			<div class="custom-list">
				{#each openProfiles as profile (profile.id)}
					<details class="custom-profile">
						<summary>
							<span>
								<strong>{profile.name}</strong>
								<small>{profile.description || 'Custom memory profile'}</small>
							</span>
						</summary>
						<form method="POST" action="?/updateMemoryProfile" class="settings-form compact">
							<input type="hidden" name="id" value={profile.id} />
							<label>
								Name
								<input name="name" maxlength="120" required value={profile.name} />
							</label>
							<label>
								Description
								<input name="description" maxlength="500" value={profile.description} />
							</label>
							<label>
								Instructions
								<textarea name="instructions" rows="5" maxlength="8000" required
									>{profile.instructions}</textarea
								>
							</label>
							<label>
								Schema JSON
								<textarea name="schemaJson" rows="8" maxlength="20000" required
									>{schemaText(profile)}</textarea
								>
							</label>
							<div class="actions">
								<button class="btn primary" type="submit">Save changes</button>
								<button class="btn danger" type="submit" form="archive-memory-profile-{profile.id}">
									Archive
								</button>
							</div>
						</form>
						<form
							id="archive-memory-profile-{profile.id}"
							method="POST"
							action="?/archiveMemoryProfile"
						>
							<input type="hidden" name="id" value={profile.id} />
						</form>
					</details>
				{/each}
			</div>
		{/if}
		{#if archivedProfiles.length > 0}
			<details class="archived">
				<summary>Archived profiles ({archivedProfiles.length})</summary>
				<ul>
					{#each archivedProfiles as profile (profile.id)}
						<li>{profile.name}</li>
					{/each}
				</ul>
			</details>
		{/if}
	</section>
</div>

<style>
	.memory-profiles {
		display: grid;
		gap: var(--space-4);
	}
	h3 {
		margin: 0;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		padding: var(--space-4);
		display: grid;
		gap: var(--space-3);
	}
	.settings-form {
		display: grid;
		gap: var(--space-3);
	}
	.settings-form.compact {
		margin-top: var(--space-3);
	}
	label {
		display: grid;
		gap: var(--space-1);
	}
	input,
	textarea {
		width: 100%;
	}
	textarea {
		resize: vertical;
		font-family: var(--mono);
	}
	.actions,
	.section-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.section-row {
		justify-content: space-between;
	}
	.custom-list {
		display: grid;
		gap: var(--space-2);
	}
	.custom-profile {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		padding: var(--space-3);
	}
	summary {
		cursor: pointer;
	}
	.custom-profile summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.custom-profile small {
		display: block;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.archived ul {
		margin-bottom: 0;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: var(--fs-sm);
	}
	.empty {
		margin: 0;
	}
</style>
