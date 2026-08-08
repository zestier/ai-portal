<script lang="ts">
	import {
		describeGrantScope,
		formatExpiry,
		formatTime,
		grantScopeLabel,
		type FormResult,
		type PermissionGrant
	} from './settings-types';
	import type { GrantScope } from '$lib/permissions/scope-types';
	import {
		GRANT_FORM_TOOLS,
		customToolNameError,
		grantToolLabel,
		isGrantTool,
		type GrantFormTool
	} from '$lib/permissions/metadata';
	import type { PortalToolCatalogEntry } from '$lib/tools/catalog-types';
	import { customToolGrantCaveat } from '$lib/tools/catalog-types';
	import GrantScopeEditor from '$lib/components/GrantScopeEditor.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';

	let {
		grants,
		portalTools,
		form
	}: {
		grants: PermissionGrant[];
		portalTools: PortalToolCatalogEntry[];
		form: FormResult | null;
	} = $props();

	type GrantDecision = 'allow' | 'force-allow' | 'deny' | 'prompt';

	let newGrantTool = $state<GrantFormTool>('shell');
	let newGrantToolName = $state('');
	let newGrantDecision = $state<GrantDecision>('allow');
	let newGrantExpiry = $state('');
	let newGrantDenyReason = $state('');
	let editingGrantId = $state<number | null>(null);
	let editingGrantMeta = $state<{
		conversationId: string | null;
		conversationTitle: string | null;
	} | null>(null);
	let detailsOpen = $state(false);
	let editorDetails: HTMLDetailsElement | undefined = $state();

	let searchQuery = $state('');
	let decisionFilter = $state<'all' | GrantDecision>('all');
	let toolFilter = $state('all');
	let kindFilter = $state('all');
	let scopeFilter = $state<'all' | 'global' | 'conversation'>('all');
	let expiryFilter = $state<'all' | 'never' | 'expiring' | 'expired'>('all');
	let provenanceFilter = $state<'all' | PermissionGrant['source']>('all');

	// Edited scope state, produced by the shared GrantScopeEditor. `seedScope` +
	// `seedEpoch` push a scope INTO the editor (on edit / reset); `scopeJson` /
	// `scopeError` read the editor's current build back out.
	let seedScope = $state<GrantScope | null>(null);
	let seedEpoch = $state(0);
	let scopeJson = $state('');
	let scopeError = $state<string | null>(null);

	let userTouched = $state(false);

	// A custom-tool grant is keyed by tool NAME and always carries the
	// `{kind:'any'}` scope, so it bypasses the structured scope editor entirely.
	const isCustomTool = $derived(newGrantTool === 'custom-tool');
	const customToolError = $derived(isCustomTool ? customToolNameError(newGrantToolName) : null);
	const submittedScopeJson = $derived(isCustomTool ? '{"kind":"any"}' : scopeJson);
	const canSubmitGrant = $derived(isCustomTool ? customToolError === null : scopeJson !== '');
	const buildError = $derived(userTouched ? (isCustomTool ? customToolError : scopeError) : null);
	const portalToolsByName = $derived(new Map(portalTools.map((t) => [t.name, t])));
	const selectedPortalTool = $derived(portalToolsByName.get(newGrantToolName.trim()) ?? null);
	const customToolCaveat = $derived(
		selectedPortalTool ? customToolGrantCaveat(selectedPortalTool) : null
	);

	function onSubmitCreateGrant(e: SubmitEvent) {
		if (!canSubmitGrant) {
			userTouched = true;
			e.preventDefault();
		}
	}

	function resetGrantForm() {
		editingGrantId = null;
		editingGrantMeta = null;
		newGrantTool = 'shell';
		newGrantToolName = '';
		newGrantDecision = 'allow';
		newGrantExpiry = '';
		newGrantDenyReason = '';
		seedScope = null;
		seedEpoch += 1;
		userTouched = false;
	}

	function expiryToLocalInput(ms: number | null): string {
		if (ms == null) return '';
		const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
		return d.toISOString().slice(0, 16);
	}

	function startEditGrant(g: PermissionGrant) {
		resetGrantForm();
		editingGrantId = g.id;
		editingGrantMeta = {
			conversationId: g.conversationId,
			conversationTitle: g.conversationTitle
		};
		newGrantDecision = g.decision;
		newGrantExpiry = expiryToLocalInput(g.expiresAt);
		newGrantDenyReason = g.denyReason ?? '';

		if (isGrantTool(g.tool)) {
			newGrantTool = g.tool;
		} else if (g.permissionKind === 'custom-tool') {
			newGrantTool = 'custom-tool';
			newGrantToolName = g.tool;
		}

		seedScope = g.scope;
		seedEpoch += 1;

		detailsOpen = true;
		queueMicrotask(() => {
			editorDetails?.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
			(
				editorDetails?.querySelector('select, input, textarea, button') as HTMLElement | null
			)?.focus();
		});
	}

	$effect(() => {
		if (
			form?.ok &&
			(form.formId === 'createGrant' || form.formId === 'updateGrant') &&
			!form.duplicate
		) {
			resetGrantForm();
		}
	});

	function canEditGrant(g: PermissionGrant): boolean {
		if (g.scope === null) return false;
		// A custom-tool row's whole scope is its tool name, so `{kind:'any'}` is
		// editable here even though it isn't authorable for the scoped kinds.
		if (g.permissionKind === 'custom-tool') {
			return g.scope.kind === 'any' && customToolNameError(g.tool) === null;
		}
		if (g.scope.kind === 'any') return false;
		if (!isGrantTool(g.tool)) return false;
		if (g.scope.kind === 'fs' && g.scope.perms && g.scope.perms.length > 1) return false;
		return true;
	}

	function resetFilters() {
		searchQuery = '';
		decisionFilter = 'all';
		toolFilter = 'all';
		kindFilter = 'all';
		scopeFilter = 'all';
		expiryFilter = 'all';
		provenanceFilter = 'all';
	}

	function isExpired(g: PermissionGrant): boolean {
		return g.expiresAt !== null && g.expiresAt <= Date.now();
	}

	function isExpiringSoon(g: PermissionGrant): boolean {
		return (
			g.expiresAt !== null && g.expiresAt > Date.now() && g.expiresAt <= Date.now() + 7 * 86_400_000
		);
	}

	function expiryStateLabel(g: PermissionGrant): string {
		if (isExpired(g)) return 'Expired';
		if (isExpiringSoon(g)) return 'Expiring soon';
		if (g.expiresAt === null) return 'No expiry';
		return 'Scheduled expiry';
	}

	function provenanceLabel(g: PermissionGrant): string {
		switch (g.source) {
			case 'seed':
				return 'Default seed';
			case 'prompt':
				return 'Prompt-created';
			case 'settings':
				return 'Settings-created';
			case 'legacy':
				return 'Legacy';
		}
	}

	function decisionLabel(decision: GrantDecision): string {
		switch (decision) {
			case 'allow':
				return 'Approve';
			case 'force-allow':
				return 'Force approve';
			case 'deny':
				return 'Deny';
			case 'prompt':
				return 'Prompt';
		}
	}

	function groupSearchText(g: PermissionGrant): string {
		return [
			String(g.id),
			g.tool,
			g.permissionKind ?? 'any kind',
			g.decision,
			describeGrantScope(g),
			grantScopeLabel(g),
			g.conversationId ?? '',
			g.denyReason ?? '',
			provenanceLabel(g),
			JSON.stringify(g.scope ?? g.scopePattern ?? '')
		]
			.join(' ')
			.toLowerCase();
	}

	function matchesFilters(g: PermissionGrant): boolean {
		const q = searchQuery.trim().toLowerCase();
		if (q && !groupSearchText(g).includes(q)) return false;
		if (decisionFilter !== 'all' && g.decision !== decisionFilter) return false;
		if (toolFilter !== 'all' && g.tool !== toolFilter) return false;
		if (kindFilter !== 'all' && (g.permissionKind ?? 'any kind') !== kindFilter) return false;
		if (scopeFilter === 'global' && g.conversationId !== null) return false;
		if (scopeFilter === 'conversation' && g.conversationId === null) return false;
		if (provenanceFilter !== 'all' && g.source !== provenanceFilter) return false;
		if (expiryFilter === 'never' && g.expiresAt !== null) return false;
		if (expiryFilter === 'expiring' && !isExpiringSoon(g)) return false;
		if (expiryFilter === 'expired' && !isExpired(g)) return false;
		return true;
	}

	function getGrantStats(items: PermissionGrant[]) {
		return {
			total: items.length,
			allow: items.filter((g) => g.decision === 'allow' || g.decision === 'force-allow').length,
			deny: items.filter((g) => g.decision === 'deny').length,
			prompt: items.filter((g) => g.decision === 'prompt').length,
			global: items.filter((g) => g.conversationId === null).length,
			conversation: items.filter((g) => g.conversationId !== null).length,
			seed: items.filter((g) => g.source === 'seed').length,
			expiring: items.filter(isExpiringSoon).length,
			expired: items.filter(isExpired).length
		};
	}

	function buildGrantSections(items: PermissionGrant[]) {
		const deny = items.filter((g) => g.decision === 'deny');
		const prompt = items.filter((g) => g.decision === 'prompt');
		const userGlobal = items.filter(
			(g) =>
				(g.decision === 'allow' || g.decision === 'force-allow') &&
				g.source !== 'seed' &&
				g.conversationId === null
		);
		const conversation = items.filter(
			(g) =>
				(g.decision === 'allow' || g.decision === 'force-allow') &&
				g.source !== 'seed' &&
				g.conversationId !== null
		);
		const defaults = items.filter(
			(g) => (g.decision === 'allow' || g.decision === 'force-allow') && g.source === 'seed'
		);

		return [
			{
				id: 'deny',
				title: 'Hard deny rules',
				description:
					'Rules that reject matching requests automatically. They never prompt on their own, but a valid force_retry_tool (token from the denial) still reaches a human permission dialog that can override them.',
				grants: deny
			},
			{
				id: 'prompt',
				title: 'Prompt-required rules',
				description:
					'Rules that block automated approval but allow a human permission dialog or force_retry_tool escalation.',
				grants: prompt
			},
			{
				id: 'user-global',
				title: 'Non-seed global approvals',
				description: 'Approve rules not marked as default seeds that apply across conversations.',
				grants: userGlobal
			},
			{
				id: 'conversation',
				title: 'Conversation-scoped approvals',
				description: 'Approve rules created from a specific conversation prompt.',
				grants: conversation
			},
			{
				id: 'defaults',
				title: 'Default seed approvals',
				description: 'Built-in safe defaults installed for each user; revocable and restorable.',
				grants: defaults
			}
		].filter((section) => section.grants.length > 0);
	}

	const toolOptions = $derived([...new Set(grants.map((g) => g.tool))].sort());
	const kindOptions = $derived(
		[...new Set(grants.map((g) => g.permissionKind ?? 'any kind'))].sort()
	);
	const stats = $derived(getGrantStats(grants));
	const filteredGrants = $derived(grants.filter(matchesFilters));
	const filteredStats = $derived(getGrantStats(filteredGrants));
	const grantSections = $derived(buildGrantSections(filteredGrants));
	const hasActiveFilters = $derived(
		searchQuery.trim().length > 0 ||
			decisionFilter !== 'all' ||
			toolFilter !== 'all' ||
			kindFilter !== 'all' ||
			scopeFilter !== 'all' ||
			expiryFilter !== 'all' ||
			provenanceFilter !== 'all'
	);
</script>

<div
	id="settings-panel-permissions"
	class="tab-panel grants"
	role="tabpanel"
	aria-labelledby="settings-tab-permissions"
>
	<PanelHeader title="Saved permission grants" fullBleed>
		{#snippet meta()}Review persistent approve, deny, and prompt rules; audit defaults; and find
			conversation-scoped rules quickly.{/snippet}
	</PanelHeader>

	<div class="grant-summary" aria-label="Permission grant summary">
		<div class="summary-card">
			<span class="summary-value">{stats.total}</span>
			<span class="summary-label">Total grants</span>
		</div>
		<div class="summary-card">
			<span class="summary-value">{stats.allow}</span>
			<span class="summary-label">Approvals</span>
		</div>
		<div class="summary-card danger-card">
			<span class="summary-value">{stats.deny}</span>
			<span class="summary-label">Denies</span>
		</div>
		<div class="summary-card warning-card">
			<span class="summary-value">{stats.prompt}</span>
			<span class="summary-label">Prompts</span>
		</div>
		<div class="summary-card">
			<span class="summary-value">{stats.seed}</span>
			<span class="summary-label">Default seeds</span>
		</div>
		<div class="summary-card">
			<span class="summary-value">{stats.conversation}</span>
			<span class="summary-label">Conversation-scoped</span>
		</div>
		<div class="summary-card warning-card">
			<span class="summary-value">{stats.expiring + stats.expired}</span>
			<span class="summary-label">Expiring/expired</span>
		</div>
	</div>

	<div class="grant-toolbar">
		<details class="add-grant" bind:open={detailsOpen} bind:this={editorDetails}>
			<summary
				>{editingGrantId !== null ? 'Edit permission grant' : 'Add a permission grant'}</summary
			>
			<form
				method="POST"
				action={editingGrantId !== null ? '?/updateGrant' : '?/createGrant'}
				class="add-grant-form"
				onsubmit={onSubmitCreateGrant}
			>
				{#if editingGrantId !== null}
					<p class="muted small">
						Editing grant #{editingGrantId}{editingGrantMeta?.conversationId
							? ` (scoped to ${editingGrantMeta.conversationTitle ?? editingGrantMeta.conversationId})`
							: ' (user-global)'}. The conversation scope and original grant time are preserved.
					</p>
					<input type="hidden" name="id" value={editingGrantId} />
				{:else}
					<p class="muted small">
						Author a user-global grant directly, without waiting for a tool prompt.
						Conversation-scoped grants are still created from the "Allow always" / "Deny always"
						buttons on the in-chat permission dialog.
					</p>
				{/if}

				<div class="grid">
					<label>
						Decision
						<select name="decision" bind:value={newGrantDecision}>
							<option value="allow">Approve</option>
							<option value="deny">Deny</option>
							<option value="prompt">Prompt</option>
						</select>
					</label>
					<label>
						Tool
						<select name="tool" bind:value={newGrantTool}>
							{#each GRANT_FORM_TOOLS as tool}
								<option value={tool}>{grantToolLabel(tool)}</option>
							{/each}
						</select>
					</label>
					<label>
						Expires (optional)
						<input type="datetime-local" name="expiresAt" bind:value={newGrantExpiry} />
					</label>
				</div>

				{#if newGrantDecision === 'deny' || newGrantDecision === 'prompt'}
					<label class="deny-reason">
						{newGrantDecision === 'prompt'
							? 'Default deny / auto-deny feedback (optional)'
							: 'Deny reason / feedback (optional)'}
						<textarea
							name="denyReason"
							bind:value={newGrantDenyReason}
							rows="2"
							maxlength="500"
							placeholder={newGrantDecision === 'prompt'
								? 'e.g. This command requires human review; use a safer structured tool if possible.'
								: 'e.g. Prefer the structured `view` tool instead of `cat`.'}
						></textarea>
						{#if newGrantDecision === 'prompt'}
							<span class="muted small"
								>Prefills the permission dialog's deny feedback and is sent to the agent if the
								prompt grant must auto-deny because no dialog can be shown. Max 500 chars.</span
							>
						{:else}
							<span class="muted small"
								>Surfaced to the agent as the SDK reject `feedback` string — explain *why* and what
								to do instead. Max 500 chars.</span
							>
						{/if}
					</label>
				{:else}
					<input type="hidden" name="denyReason" value="" />
				{/if}

				{#if newGrantTool === 'custom-tool'}
					<fieldset class="scope-fields custom-tool-fields">
						<legend>Custom-tool scope</legend>
						<label>
							Tool name
							<input
								type="text"
								name="toolName"
								list="portal-tool-names"
								bind:value={newGrantToolName}
								oninput={() => (userTouched = true)}
								placeholder="worktree_create"
								spellcheck="false"
								autocomplete="off"
							/>
							<span class="muted small">
								A portal tool is authorized as a whole — there is no finer scope, so the name is the
								scope. Names not in the list are accepted too (MCP / provider tools).
							</span>
						</label>
						<datalist id="portal-tool-names">
							{#each portalTools as tool}
								<option value={tool.name}>{tool.group}</option>
							{/each}
						</datalist>
						{#if customToolCaveat}
							<p class="tool-caveat">⚠️ {customToolCaveat}</p>
						{/if}
					</fieldset>
				{:else}
					<GrantScopeEditor
						tool={newGrantTool}
						{seedScope}
						{seedEpoch}
						onChange={(r) => {
							scopeJson = r.json;
							scopeError = r.error;
						}}
					/>
				{/if}

				<input type="hidden" name="scopeJson" value={submittedScopeJson} />

				{#if submittedScopeJson}
					<details class="scope-preview">
						<summary>Preview JSON</summary>
						<pre><code>{submittedScopeJson}</code></pre>
					</details>
				{/if}
				{#if buildError}
					<div class="err small">{buildError}</div>
				{/if}
				{#if form?.formId === 'createGrant' && form.error}
					<div class="err small">{form.error}</div>
				{/if}
				{#if form?.formId === 'createGrant' && form.ok}
					<div class="ok small">
						{form.duplicate ? 'An identical grant already exists — no change.' : 'Grant created.'}
					</div>
				{/if}
				{#if form?.formId === 'updateGrant' && form.error}
					<div class="err small">{form.error}</div>
				{/if}
				{#if form?.formId === 'updateGrant' && form.ok}
					<div class="ok small">Grant updated.</div>
				{/if}

				<div class="form-actions">
					<button class="btn primary" type="submit" disabled={!canSubmitGrant}>
						{editingGrantId !== null ? 'Save changes' : 'Add grant'}
					</button>
					{#if editingGrantId !== null}
						<button class="btn" type="button" onclick={resetGrantForm}>Cancel</button>
					{/if}
				</div>
			</form>
		</details>

		<div class="grant-bulk-actions" aria-label="Grant maintenance actions">
			<form
				method="POST"
				action="?/restoreSeedGrants"
				class="restore-seeds"
				onsubmit={(e) => {
					if (
						!confirm(
							'Restore the built-in default grants?\n\nThe default shell readers (cat, head, tail, ls, find, …) now also defer to your `read` grants, so restoring them lets those commands reach every path your `read` grants already cover — including any you added yourself, outside the workspace. Nothing you could run before stops working, and your own grants are not modified.'
						)
					) {
						e.preventDefault();
					}
				}}
			>
				<button
					class="btn small"
					type="submit"
					title="Replace identifiable default seed grants with the current default set; user-created non-default rules are left alone"
				>
					Restore default seed grants
				</button>
			</form>
			{#if grants.length > 0}
				<form
					method="POST"
					action="?/revokeAllGrants"
					class="revoke-all"
					onsubmit={(e) => {
						if (
							!confirm(
								`Revoke all ${grants.length} saved permission grant${grants.length === 1 ? '' : 's'}? This removes default, user-created, and conversation-scoped grants. You can restore default seeds afterward, but user-created rules cannot be recovered.`
							)
						) {
							e.preventDefault();
						}
					}}
				>
					<button class="btn small danger" type="submit">Revoke all grants</button>
				</form>
			{/if}
		</div>
	</div>

	{#if grants.length === 0}
		<EmptyState
			title="No saved grants yet"
			description={`No saved grants. When you click "Allow always" or "Deny always" on a tool prompt, the resulting approve or hard-deny rule shows up here so you can revoke it later. You can also add prompt-required rules here to force interactive approval for matching requests. The button above re-installs the built-in defaults (file/dir reads, structured tools, and safety rules).`}
		/>
	{:else}
		<form class="grant-filters" role="search" onsubmit={(e) => e.preventDefault()}>
			<div class="filter-header">
				<div>
					<h3>Find grants</h3>
					<p class="muted small">
						Showing {filteredStats.total} of {stats.total} grants. Hidden grants are only filtered from
						this view, not revoked.
					</p>
				</div>
				{#if hasActiveFilters}
					<button class="btn small" type="button" onclick={resetFilters}>Reset filters</button>
				{/if}
			</div>
			<label class="search-field">
				Search grants
				<input
					type="search"
					bind:value={searchQuery}
					placeholder="Search tool, scope, conversation, feedback, or grant id"
					autocomplete="off"
				/>
			</label>
			<div class="filter-grid">
				<label>
					Decision filter
					<select bind:value={decisionFilter}>
						<option value="all">All decisions</option>
						<option value="allow">Approve only</option>
						<option value="deny">Deny only</option>
						<option value="prompt">Prompt only</option>
					</select>
				</label>
				<label>
					Tool filter
					<select bind:value={toolFilter}>
						<option value="all">All tools</option>
						{#each toolOptions as tool}
							<option value={tool}>{tool}</option>
						{/each}
					</select>
				</label>
				<label>
					Permission kind filter
					<select bind:value={kindFilter}>
						<option value="all">All kinds</option>
						{#each kindOptions as kind}
							<option value={kind}>{kind}</option>
						{/each}
					</select>
				</label>
				<label>
					Scope filter
					<select bind:value={scopeFilter}>
						<option value="all">Global and conversation</option>
						<option value="global">Global only</option>
						<option value="conversation">Conversation-scoped only</option>
					</select>
				</label>
				<label>
					Expiration filter
					<select bind:value={expiryFilter}>
						<option value="all">All expiration states</option>
						<option value="never">No expiry</option>
						<option value="expiring">Expiring in 7 days</option>
						<option value="expired">Expired</option>
					</select>
				</label>
				<label>
					Source filter
					<select bind:value={provenanceFilter}>
						<option value="all">All sources</option>
						<option value="seed">Default seed</option>
						<option value="prompt">Prompt-created</option>
						<option value="settings">Settings-created</option>
						<option value="legacy">Legacy</option>
					</select>
				</label>
			</div>
		</form>

		{#if filteredGrants.length === 0}
			<div aria-live="polite">
				<EmptyState
					title="No grants match these filters"
					description={`Broaden the search or reset filters to see the hidden ${stats.total} saved grant${stats.total === 1 ? '' : 's'}.`}
				>
					{#snippet actions()}
						<button class="btn small" type="button" onclick={resetFilters}>Reset filters</button>
					{/snippet}
				</EmptyState>
			</div>
		{:else}
			<div class="filtered-summary" aria-live="polite">
				<span>{filteredStats.allow} approve</span>
				<span>{filteredStats.deny} deny</span>
				<span>{filteredStats.prompt} prompt</span>
				<span>{filteredStats.global} global</span>
				<span>{filteredStats.conversation} conversation-scoped</span>
				<span>{filteredStats.seed} default seed</span>
			</div>

			{#each grantSections as section (section.id)}
				<section class="grant-section" aria-labelledby={`grant-section-${section.id}`}>
					<div class="grant-section-heading">
						<div>
							<h3 id={`grant-section-${section.id}`}>{section.title}</h3>
							<p class="muted small">{section.description}</p>
						</div>
						<span class="section-count">{section.grants.length}</span>
					</div>
					<ul class="grant-list">
						{#each section.grants as g (g.id)}
							<li class="grant-row">
								<div class="grant-row-main">
									<div class="grant-row-title">
										<span class="decision-tag eyebrow {g.decision}"
											>{decisionLabel(g.decision)}</span
										>
										<code class="tool">{g.tool}</code>
										<span class="kind">{g.permissionKind ?? 'any kind'}</span>
										<span class="source-tag" class:seed={g.source === 'seed'}
											>{provenanceLabel(g)}</span
										>
										<span
											class="expiry-tag"
											class:warn={isExpiringSoon(g)}
											class:danger={isExpired(g)}>{expiryStateLabel(g)}</span
										>
									</div>
									<code class="pattern">{describeGrantScope(g)}</code>
									<div class="meta">
										<span>{grantScopeLabel(g)}</span>
										<span>Granted {formatTime(g.grantedAt)}</span>
										<span>Expires {formatExpiry(g.expiresAt)}</span>
									</div>
									{#if g.denyReason}
										<p class="deny-reason-row muted small">Feedback: {g.denyReason}</p>
									{/if}
								</div>
								<div class="grant-row-actions">
									<details class="grant-details">
										<summary>Details</summary>
										<dl>
											<div>
												<dt>Grant ID</dt>
												<dd>#{g.id}</dd>
											</div>
											<div>
												<dt>Scope</dt>
												<dd><code>{describeGrantScope(g)}</code></dd>
											</div>
											<div>
												<dt>Source</dt>
												<dd>{provenanceLabel(g)}</dd>
											</div>
											<div>
												<dt>Conversation</dt>
												<dd>{g.conversationId ? grantScopeLabel(g) : 'Global'}</dd>
											</div>
											{#if g.conversationId}
												<div>
													<dt>Conversation ID</dt>
													<dd><code>{g.conversationId}</code></dd>
												</div>
											{/if}
											{#if g.argsHash}
												<div>
													<dt>Args hash</dt>
													<dd><code>{g.argsHash}</code></dd>
												</div>
											{/if}
											{#if g.denyReason}
												<div>
													<dt>Feedback</dt>
													<dd>{g.denyReason}</dd>
												</div>
											{/if}
											<div>
												<dt>Raw scope</dt>
												<dd>
													<pre>{JSON.stringify(g.scope ?? g.scopePattern ?? '*', null, 2)}</pre>
												</dd>
											</div>
										</dl>
									</details>
									<form
										method="POST"
										action="?/revokeGrant"
										class="revoke"
										onsubmit={(e) => {
											if (
												!confirm(
													`Revoke grant #${g.id} (${g.decision} ${g.tool} ${describeGrantScope(g)})?`
												)
											) {
												e.preventDefault();
											}
										}}
									>
										<input type="hidden" name="id" value={g.id} />
										{#if canEditGrant(g)}
											<button
												class="btn small"
												type="button"
												onclick={() => startEditGrant(g)}
												title="Prefill the grant editor with this grant">Edit</button
											>
										{/if}
										<button class="btn small" type="submit">Revoke</button>
									</form>
								</div>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		{/if}
	{/if}
</div>

<style>
	.tab-panel {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		overflow: hidden;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin-bottom: 1.25rem;
	}
	form input,
	form select {
		width: 100%;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	code {
		background: var(--code-bg);
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
	}
	.form-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 0.25rem;
	}
	.grant-summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 0.6rem;
		margin-bottom: 1rem;
	}
	.summary-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.7rem;
		background: color-mix(in srgb, var(--surface), var(--code-bg) 22%);
	}
	.summary-value {
		display: block;
		font-size: var(--fs-3xl);
		font-weight: 700;
		line-height: 1;
	}
	.summary-label {
		display: block;
		margin-top: 0.25rem;
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}
	.danger-card .summary-value {
		color: var(--danger);
	}
	.warning-card .summary-value {
		color: var(--warning);
	}
	.grant-toolbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.75rem;
		align-items: start;
		margin-bottom: 1rem;
		min-width: 0;
	}
	.add-grant {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		min-width: 0;
	}
	.add-grant > summary {
		cursor: pointer;
		font-weight: 600;
	}
	.add-grant-form {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.add-grant-form .grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
		gap: 0.75rem;
		min-width: 0;
	}
	.scope-preview pre {
		background: var(--code-bg);
		padding: 0.5rem;
		border-radius: 4px;
		overflow-x: auto;
		font-size: var(--fs-md);
	}
	.custom-tool-fields {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.custom-tool-fields legend {
		padding: 0 0.25rem;
		font-size: var(--fs-md);
		color: var(--text-muted);
	}
	.custom-tool-fields label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
	}
	.custom-tool-fields input {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	.tool-caveat {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--warning);
		border-radius: 6px;
		background: var(--warning-bg);
		color: var(--text);
		font-size: var(--fs-md);
		line-height: 1.4;
	}
	.err {
		color: var(--danger);
	}
	.ok {
		color: var(--success);
		margin-left: 0.5rem;
	}
	.small {
		font-size: var(--fs-md);
	}
	.filter-header h3,
	.grant-section-heading h3 {
		margin: 0 0 0.2rem;
		font-size: var(--fs-lg);
	}
	.filter-header p,
	.grant-section-heading p,
	.deny-reason-row {
		margin: 0;
	}
	.grant-filters {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		background: color-mix(in srgb, var(--surface), var(--code-bg) 12%);
	}
	.filter-header {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		align-items: start;
	}
	.search-field {
		margin-top: 0.2rem;
	}
	.filter-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 0.75rem;
	}
	.filtered-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		margin: 0 0 0.85rem;
	}
	.filtered-summary span,
	.section-count,
	.source-tag,
	.expiry-tag {
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.12rem 0.5rem;
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}
	.grant-section {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		margin-top: 0.9rem;
		overflow: hidden;
	}
	.grant-section-heading {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface), var(--code-bg) 18%);
	}
	.grant-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.grant-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.75rem;
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		font-size: var(--fs-md);
	}
	.grant-row:last-child {
		border-bottom: 0;
	}
	.grant-row-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.45rem;
	}
	.decision-tag {
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}
	.decision-tag.allow,
	.decision-tag.force-allow {
		color: var(--success);
		border-color: var(--success);
	}
	.decision-tag.prompt {
		color: var(--warning);
		border-color: var(--warning);
	}
	.decision-tag.deny {
		color: var(--danger);
		border-color: var(--danger);
	}
	.source-tag.seed {
		color: var(--success);
		border-color: color-mix(in srgb, var(--success), var(--border) 35%);
	}
	.expiry-tag.warn {
		color: var(--warning);
		border-color: var(--warning);
	}
	.expiry-tag.danger {
		color: var(--danger);
		border-color: var(--danger);
	}
	.grant-row .tool {
		font-weight: 600;
	}
	.grant-row .kind {
		font-size: var(--fs-sm);
		opacity: 0.75;
	}
	.grant-row .pattern {
		display: block;
		font-family: var(--font-mono, monospace);
		font-size: var(--fs-md);
		opacity: 0.85;
		overflow-wrap: anywhere;
		white-space: normal;
		width: fit-content;
		max-width: 100%;
	}
	.grant-row .meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.75rem;
		margin-top: 0.45rem;
		font-size: var(--fs-sm);
		opacity: 0.75;
	}
	.deny-reason-row {
		margin-top: 0.45rem;
		overflow-wrap: anywhere;
	}
	.grant-row-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: flex-end;
	}
	.grant-details {
		text-align: right;
	}
	.grant-details > summary {
		cursor: pointer;
	}
	.grant-details dl {
		margin: 0.5rem 0 0;
		width: min(32rem, 70vw);
		text-align: left;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.65rem;
		background: var(--surface);
	}
	.grant-details dl > div {
		display: grid;
		grid-template-columns: minmax(7rem, 0.35fr) minmax(0, 1fr);
		gap: 0.5rem;
		padding: 0.25rem 0;
	}
	.grant-details dt {
		font-weight: 600;
		color: var(--text-muted);
	}
	.grant-details dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.grant-details pre {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: var(--fs-sm);
	}
	.grant-row .revoke {
		flex-direction: row;
		gap: 0.35rem;
		margin: 0;
	}
	.revoke-all {
		margin: 0;
	}
	.grant-bulk-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: flex-end;
	}
	.grant-bulk-actions > form {
		margin: 0;
	}
	.btn.small {
		padding: 0.2rem 0.55rem;
		font-size: var(--fs-sm);
	}
	@media (max-width: 720px) {
		.grant-toolbar,
		.grant-row {
			grid-template-columns: 1fr;
		}
		.add-grant,
		.add-grant-form,
		.add-grant-form .grid {
			width: 100%;
			box-sizing: border-box;
		}
		.grant-bulk-actions,
		.grant-row-actions {
			align-items: stretch;
			justify-content: stretch;
		}
		.grant-details {
			text-align: left;
		}
		.grant-details dl {
			width: auto;
		}
		.grant-details dl > div {
			grid-template-columns: 1fr;
			gap: 0.15rem;
		}
	}
</style>
