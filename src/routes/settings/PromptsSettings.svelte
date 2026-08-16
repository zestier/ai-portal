<script lang="ts">
	import Alert from '$lib/components/ui/Alert.svelte';
	import Pill from '$lib/components/ui/Pill.svelte';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';
	import LaunchReviewDialog from '$lib/components/LaunchReviewDialog.svelte';
	import type { FormResult, PromptTemplate, SettingsData } from './settings-types';
	import type { PromptTemplateListItem } from '$lib/prompt-templates';
	import {
		buildRefinePromptSeed,
		placeholdersForType,
		launchBehaviorLabel,
		templateLaunchDefaults,
		type TemplateLaunchOptions
	} from '$lib/prompt-templates';
	import { PORTAL_TOOL_GROUPS } from '$lib/tools/groups';
	import { goto, invalidateAll } from '$app/navigation';
	import { createPromptTemplateRefineChat } from '$lib/client/prompt-template-launch';
	import { onDestroy } from 'svelte';

	let {
		builtInTemplates,
		promptTemplates,
		modelOptions = [],
		settings,
		form
	}: {
		builtInTemplates: PromptTemplateListItem[];
		promptTemplates: PromptTemplate[];
		modelOptions?: string[];
		settings: SettingsData;
		form: FormResult | null;
	} = $props();

	const chatTemplates = $derived(promptTemplates.filter((t) => t.type === 'chat'));
	const ticketActions = $derived(promptTemplates.filter((t) => t.type === 'ticket-action'));

	const openChatTemplates = $derived(chatTemplates.filter((t) => t.status === 'open'));
	const openTicketActions = $derived(ticketActions.filter((t) => t.status === 'open'));
	const archivedTemplates = $derived(promptTemplates.filter((t) => t.status === 'archived'));

	const ticketPlaceholders = placeholdersForType('ticket-action');
	const ticketPlaceholderHint = ticketPlaceholders.map((name) => `{{${name}}}`).join(', ');

	const conversationModeOptions: { value: string; label: string }[] = [
		{ value: '', label: 'Use my default mode' },
		{ value: 'interactive', label: 'Interactive' },
		{ value: 'autopilot', label: 'Autopilot' }
	];

	const approvalModeOptions: { value: string; label: string }[] = [
		{ value: '', label: 'Use my default approvals' },
		{ value: 'ask', label: 'Ask every time' },
		{ value: 'auto-approve', label: 'Auto-approve prompts' },
		{ value: 'auto-deny', label: 'Auto-deny prompts (best effort)' }
	];

	// Model-override options for ticket actions. Always include the currently
	// stored override (even if the provider no longer lists it) so editing a
	// stale id doesn't silently drop it.
	function modelOptionsFor(current: string | null | undefined): string[] {
		const ids = [...modelOptions];
		if (current && !ids.includes(current)) ids.unshift(current);
		return ids;
	}

	const workspaceModeOptions: { value: string; label: string }[] = [
		{ value: '', label: 'Shared checkout (default)' },
		{ value: 'worktree', label: 'New isolated worktree' }
	];

	const launchBehaviorOptions: { value: string; label: string }[] = [
		{ value: 'send', label: 'Send immediately' },
		{ value: 'draft', label: 'Open draft in composer' },
		{ value: 'review', label: 'Review before sending' }
	];

	let refiningId = $state<string | null>(null);
	let refineError = $state<string | null>(null);
	let refineErrorId = $state<string | null>(null);
	let refineController: AbortController | null = null;
	// A refine launch awaiting review-dialog confirmation, with the options that
	// seed the dialog (prompt = the refine seed).
	let reviewingRefine = $state<{ template: PromptTemplate; options: TemplateLaunchOptions } | null>(
		null
	);

	async function refineTemplate(template: PromptTemplate) {
		if (refiningId) return;
		refiningId = template.id;
		refineError = null;
		refineErrorId = null;
		// Declared up front so the catch can inspect it (the review branch
		// returns early before any request uses it; onDestroy still aborts it,
		// which is a no-op then).
		const controller = new AbortController();
		refineController = controller;
		try {
			const seed = buildRefinePromptSeed({
				id: template.id,
				type: template.type,
				title: template.title
			});
			const options = templateLaunchDefaults(template, seed);
			// Carve-out (D8): a refine chat must keep the `prompt-templates` group
			// enabled so the agent can read/update the saved template. Filter it
			// from the seed AND from the confirmed review options below.
			options.disabledToolGroups = options.disabledToolGroups.filter(
				(g) => g !== 'prompt-templates'
			);
			if (template.launchBehavior === 'review') {
				reviewingRefine = { template, options };
				return;
			}
			const result = await createPromptTemplateRefineChat({
				template,
				options,
				launchBehavior: template.launchBehavior,
				fetcher: fetch,
				signal: controller.signal
			});
			if (controller.signal.aborted) return;
			if (!result.ok) {
				refineError = `Could not start refine chat (${result.status ?? 'network'})`;
				refineErrorId = template.id;
				return;
			}
			await invalidateAll();
			await goto(result.href);
		} catch (err) {
			if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
				return;
			}
			refineError = 'Could not start refine chat';
			refineErrorId = template.id;
		} finally {
			if (refiningId === template.id) refiningId = null;
		}
	}

	/** Confirmed `review` refine launch: send the seed as the first turn. */
	async function launchRefineSend(options: TemplateLaunchOptions) {
		const pending = reviewingRefine;
		if (!pending) return;
		reviewingRefine = null;
		refiningId = pending.template.id;
		refineError = null;
		refineErrorId = null;
		const controller = new AbortController();
		refineController = controller;
		try {
			// The dialog starts from the already-filtered options, but re-apply
			// the carve-out so a user toggling it back on can't disable
			// `prompt-templates` on a refine chat (D8).
			options.disabledToolGroups = options.disabledToolGroups.filter(
				(g) => g !== 'prompt-templates'
			);
			const result = await createPromptTemplateRefineChat({
				template: pending.template,
				options,
				launchBehavior: 'send',
				fetcher: fetch,
				signal: controller.signal
			});
			if (controller.signal.aborted) return;
			if (!result.ok) {
				refineError = `Could not start refine chat (${result.status ?? 'network'})`;
				refineErrorId = pending.template.id;
				return;
			}
			await invalidateAll();
			await goto(result.href);
		} catch (err) {
			if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
				return;
			}
			refineError = 'Could not start refine chat';
			refineErrorId = pending.template.id;
		} finally {
			if (refiningId === pending.template.id) refiningId = null;
		}
	}

	onDestroy(() => {
		refineController?.abort();
		refineController = null;
	});
</script>

{#snippet launchFields(
	current: {
		launchBehavior?: string | null;
		conversationMode?: string | null;
		approvalMode?: string | null;
		model?: string | null;
		workspaceMode?: string | null;
	},
	defaultBehavior: string
)}
	<div class="inline-fields">
		<label>
			Launch behavior
			<select name="launchBehavior">
				{#each launchBehaviorOptions as opt (opt.value)}
					<option
						value={opt.value}
						selected={(current.launchBehavior ?? defaultBehavior) === opt.value}
					>
						{opt.label}
					</option>
				{/each}
			</select>
		</label>
		<label>
			Git workspace
			<select name="workspaceMode">
				{#each workspaceModeOptions as opt (opt.value)}
					<option value={opt.value} selected={(current.workspaceMode ?? '') === opt.value}>
						{opt.label}
					</option>
				{/each}
			</select>
		</label>
		<label>
			Conversation mode
			<select name="conversationMode">
				{#each conversationModeOptions as opt (opt.value)}
					<option value={opt.value} selected={(current.conversationMode ?? '') === opt.value}>
						{opt.label}
					</option>
				{/each}
			</select>
		</label>
		<label>
			Approvals
			<select name="approvalMode">
				{#each approvalModeOptions as opt (opt.value)}
					<option value={opt.value} selected={(current.approvalMode ?? '') === opt.value}>
						{opt.label}
					</option>
				{/each}
			</select>
		</label>
		<label>
			Model
			<select name="model">
				<option value="" selected={!current.model}>Use my default model</option>
				{#each modelOptionsFor(current.model) as modelId (modelId)}
					<option value={modelId} selected={current.model === modelId}>{modelId}</option>
				{/each}
			</select>
		</label>
	</div>
	<p class="muted small">
		"Review before sending" opens a dialog to edit the prompt and these settings — including the Git
		workspace — before the chat is created.
	</p>
{/snippet}

{#snippet toolGroupFieldset(disabled: string[])}
	<fieldset class="tool-groups-fieldset">
		<legend>Portal tools for launched chats/actions</legend>
		<p class="muted small">
			Checked groups are disabled up front in chats started from this template (a seed — the chat
			can re-enable them). Unchecked groups stay available. Native CLI tools (bash, view, edit…) are
			always available and unaffected. Applies to chat templates and ticket actions alike.
		</p>
		<div class="tool-groups-checks">
			{#each PORTAL_TOOL_GROUPS as group (group.id)}
				<label class="checkbox" title={group.hint}>
					<input
						name="disabledToolGroups"
						type="checkbox"
						value={group.id}
						checked={disabled.includes(group.id)}
					/>
					Disable {group.label}
				</label>
			{/each}
		</div>
	</fieldset>
{/snippet}

{#snippet systemPromptFields(current: {
	systemPrompt?: string | null;
	appendSystemPrompt?: string | null;
})}
	<label>
		System prompt (persona)
		<textarea
			name="systemPrompt"
			rows="3"
			maxlength="20000"
			placeholder="Optional. Replaces the default &quot;You are an expert coding assistant...&quot; block for chats launched from this template."
			>{current.systemPrompt ?? ''}</textarea
		>
	</label>
	<label>
		Append to system prompt
		<textarea
			name="appendSystemPrompt"
			rows="3"
			maxlength="20000"
			placeholder="Optional. Appended under whatever system prompt is active for launched chats."
			>{current.appendSystemPrompt ?? ''}</textarea
		>
	</label>
{/snippet}

<div
	id="settings-panel-prompts"
	class="tab-panel prompts"
	role="tabpanel"
	aria-labelledby="settings-tab-prompts"
>
	<PanelHeader title="Prompts">
		{#snippet meta()}Save reusable prompt templates for recurring workflows. Built-in templates are
			always available when starting a chat.{/snippet}
	</PanelHeader>

	{#if form?.formId?.includes('PromptTemplate') || form?.formId === 'restorePromptTicketActions'}
		<Alert kind={form.ok ? 'success' : 'error'}>
			{form.ok ? 'Prompt template saved.' : (form.error ?? 'Prompt template update failed.')}
		</Alert>
	{/if}

	<section aria-labelledby="create-prompt-template-heading" class="card">
		<h3 id="create-prompt-template-heading">Create a chat template</h3>
		<form method="POST" action="?/createPromptTemplate" class="settings-form">
			<input type="hidden" name="type" value="chat" />
			<label>
				Title
				<input name="title" maxlength="120" required placeholder="Debug production error" />
			</label>
			<label>
				Description
				<input
					name="description"
					maxlength="500"
					placeholder="Triage logs, identify root cause, and propose a fix"
				/>
			</label>
			<label>
				Prompt body
				<textarea
					name="prompt"
					rows="7"
					maxlength="20000"
					required
					placeholder="Describe the recurring task or workflow..."
				></textarea>
			</label>
			{@render systemPromptFields({})}
			{@render launchFields({}, 'draft')}
			<div class="inline-fields">
				<label class="checkbox">
					<input name="pinned" type="checkbox" />
					Pin near the top
				</label>
				<label>
					Order
					<input name="orderIndex" type="number" value="0" />
				</label>
			</div>
			{@render toolGroupFieldset([])}
			<button class="btn primary" type="submit">Save template</button>
		</form>
	</section>

	<section aria-labelledby="default-template-heading" class="card">
		<h3 id="default-template-heading">Default template for New chat</h3>
		<p class="muted small">
			Choose a template the New chat buttons launch by default (a blank chat when None). The
			template's launch behavior applies — a draft pre-fills the composer, a send posts the prompt
			immediately, and a review opens the launch dialog first.
		</p>
		<form method="POST" action="?/saveDefaultPromptTemplate" class="default-template-form">
			<label>
				Template
				<select name="defaultPromptTemplateId">
					<option value="" selected={!settings.defaultPromptTemplateId}>
						(None — blank chat)
					</option>
					{#each builtInTemplates as template (template.id)}
						<option value={template.id} selected={settings.defaultPromptTemplateId === template.id}>
							Built-in: {template.title}
						</option>
					{/each}
					{#each openChatTemplates as template (template.id)}
						<option value={template.id} selected={settings.defaultPromptTemplateId === template.id}>
							{template.title}
						</option>
					{/each}
				</select>
			</label>
			<button class="btn primary" type="submit">Save</button>
		</form>
	</section>

	<section aria-labelledby="built-in-prompts-heading" class="card">
		<h3 id="built-in-prompts-heading">Built-in templates</h3>
		<div class="template-grid">
			{#each builtInTemplates as template (template.id)}
				<article class="template-card">
					<strong>{template.title}</strong>
					<p class="muted small">{template.description}</p>
				</article>
			{/each}
		</div>
	</section>

	<section aria-labelledby="custom-prompts-heading" class="card">
		<div class="section-row">
			<h3 id="custom-prompts-heading">Your chat templates</h3>
			<span class="muted small">{openChatTemplates.length} active</span>
		</div>
		{#if openChatTemplates.length === 0}
			<p class="muted empty">No custom chat templates yet.</p>
		{:else}
			<div class="custom-list">
				{#each openChatTemplates as template (template.id)}
					<details class="custom-template">
						<summary>
							<span>
								<strong>{template.title}</strong>
								<small>{template.description || 'Custom prompt template'}</small>
							</span>
							{#if template.pinned}<Pill tone="accent">Pinned</Pill>{/if}
							{#if template.systemPrompt}<Pill tone="accent">Persona</Pill>{/if}
							{#if template.appendSystemPrompt}<Pill tone="accent">Sys append</Pill>{/if}
						</summary>
						<form method="POST" action="?/updatePromptTemplate" class="settings-form compact">
							<input type="hidden" name="id" value={template.id} />
							<input type="hidden" name="type" value="chat" />
							<label>
								Title
								<input name="title" maxlength="120" required value={template.title} />
							</label>
							<label>
								Description
								<input name="description" maxlength="500" value={template.description} />
							</label>
							<label>
								Prompt body
								<textarea name="prompt" rows="7" maxlength="20000" required
									>{template.prompt}</textarea
								>
							</label>
							{@render systemPromptFields(template)}
							{@render launchFields(template, 'draft')}
							<div class="inline-fields">
								<label class="checkbox">
									<input name="pinned" type="checkbox" checked={template.pinned} />
									Pin near the top
								</label>
								<label>
									Order
									<input name="orderIndex" type="number" value={template.orderIndex} />
								</label>
							</div>
							{@render toolGroupFieldset(template.disabledToolGroups ?? [])}
							<div class="actions">
								<button class="btn primary" type="submit">Save changes</button>
								<button
									class="btn secondary"
									type="button"
									onclick={() => refineTemplate(template)}
									disabled={refiningId !== null}
									title="Starts a chat that refines the saved version of this template. Save changes first to include unsaved edits."
								>
									{refiningId === template.id ? 'Starting...' : 'Refine this prompt'}
								</button>
								<button class="btn danger" type="submit" form="archive-template-{template.id}">
									Archive
								</button>
							</div>
							{#if refineErrorId === template.id}
								<p class="refine-error" role="alert">{refineError}</p>
							{/if}
						</form>
						<form
							id="archive-template-{template.id}"
							method="POST"
							action="?/archivePromptTemplate"
						>
							<input type="hidden" name="id" value={template.id} />
						</form>
					</details>
				{/each}
			</div>
		{/if}
	</section>

	<section aria-labelledby="ticket-actions-heading" class="card">
		<div class="section-row">
			<h3 id="ticket-actions-heading">Ticket actions</h3>
			<span class="muted small">{openTicketActions.length} active</span>
		</div>
		<p class="muted small">
			Each ticket action renders as a button on every workspace ticket. The title is the button
			label. Use placeholders <code>{ticketPlaceholderHint}</code> in the prompt to inject ticket details
			at launch.
		</p>

		<form method="POST" action="?/restorePromptTicketActions" class="restore-form">
			<button class="btn secondary" type="submit">Restore default actions</button>
			<span class="muted small">Re-adds Do, Draft, and Refine if removed.</span>
		</form>

		{#if openTicketActions.length === 0}
			<p class="muted empty">
				No ticket actions. Tickets show only the Remove button until you add or restore actions.
			</p>
		{:else}
			<div class="custom-list">
				{#each openTicketActions as action (action.id)}
					<details class="custom-template">
						<summary>
							<span>
								<strong>{action.title}</strong>
								<small>
									{launchBehaviorLabel(action.launchBehavior)}
									· {action.conversationMode ?? 'default mode'}
									· {action.model ?? 'default model'}
									· {action.workspaceMode === 'worktree' ? 'worktree' : 'shared checkout'}
								</small>
							</span>
							{#if action.pinned}<Pill tone="accent">Pinned</Pill>{/if}
							{#if action.systemPrompt}<Pill tone="accent">Persona</Pill>{/if}
							{#if action.appendSystemPrompt}<Pill tone="accent">Sys append</Pill>{/if}
						</summary>
						<form method="POST" action="?/updatePromptTemplate" class="settings-form compact">
							<input type="hidden" name="id" value={action.id} />
							<input type="hidden" name="type" value="ticket-action" />
							<label>
								Button label
								<input name="title" maxlength="120" required value={action.title} />
							</label>
							<label>
								Description
								<input name="description" maxlength="500" value={action.description} />
							</label>
							<label>
								Prompt body
								<textarea name="prompt" rows="7" maxlength="20000" required
									>{action.prompt}</textarea
								>
							</label>
							<p class="muted small">Placeholders: <code>{ticketPlaceholderHint}</code></p>
							{@render systemPromptFields(action)}
							{@render launchFields(action, 'send')}
							<div class="inline-fields">
								<label class="checkbox">
									<input name="pinned" type="checkbox" checked={action.pinned} />
									Pin near the top
								</label>
								<label>
									Order
									<input name="orderIndex" type="number" value={action.orderIndex} />
								</label>
							</div>
							{@render toolGroupFieldset(action.disabledToolGroups ?? [])}
							<div class="actions">
								<button class="btn primary" type="submit">Save changes</button>
								<button
									class="btn secondary"
									type="button"
									onclick={() => refineTemplate(action)}
									disabled={refiningId !== null}
									title="Starts a chat that refines the saved version of this template. Save changes first to include unsaved edits."
								>
									{refiningId === action.id ? 'Starting...' : 'Refine this prompt'}
								</button>
								<button class="btn danger" type="submit" form="archive-template-{action.id}">
									Remove
								</button>
							</div>
							{#if refineErrorId === action.id}
								<p class="refine-error" role="alert">{refineError}</p>
							{/if}
						</form>
						<form id="archive-template-{action.id}" method="POST" action="?/archivePromptTemplate">
							<input type="hidden" name="id" value={action.id} />
						</form>
					</details>
				{/each}
			</div>
		{/if}

		<details class="add-action">
			<summary>Add a ticket action</summary>
			<form method="POST" action="?/createPromptTemplate" class="settings-form compact">
				<input type="hidden" name="type" value="ticket-action" />
				<label>
					Button label
					<input name="title" maxlength="120" required placeholder="Investigate" />
				</label>
				<label>
					Description
					<input name="description" maxlength="500" placeholder="What this action does" />
				</label>
				<label>
					Prompt body
					<textarea
						name="prompt"
						rows="6"
						maxlength="20000"
						required
						placeholder={`Investigate this ticket: {{ticket.title}}\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}`}
					></textarea>
				</label>
				<p class="muted small">Placeholders: <code>{ticketPlaceholderHint}</code></p>
				{@render systemPromptFields({})}
				{@render launchFields({}, 'send')}
				<div class="inline-fields">
					<label class="checkbox">
						<input name="pinned" type="checkbox" />
						Pin near the top
					</label>
					<label>
						Order
						<input name="orderIndex" type="number" value="0" />
					</label>
				</div>
				{@render toolGroupFieldset([])}
				<button class="btn primary" type="submit">Add action</button>
			</form>
		</details>
	</section>

	{#if archivedTemplates.length > 0}
		<section class="card">
			<details class="archived">
				<summary>Archived templates ({archivedTemplates.length})</summary>
				<ul>
					{#each archivedTemplates as template (template.id)}
						<li>{template.title}</li>
					{/each}
				</ul>
			</details>
		</section>
	{/if}
</div>

{#if reviewingRefine}
	<LaunchReviewDialog
		open
		templateTitle={reviewingRefine.template.title}
		defaults={reviewingRefine.options}
		busy={refiningId !== null}
		error={refineError}
		onLaunch={(options) => void launchRefineSend(options)}
		onCancel={() => {
			reviewingRefine = null;
			refineError = null;
			refiningId = null;
		}}
	/>
{/if}

<style>
	.prompts {
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
	textarea,
	select {
		width: 100%;
	}
	textarea {
		resize: vertical;
	}
	.restore-form {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.default-template-form {
		display: flex;
		align-items: end;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.default-template-form label {
		flex: 1;
		min-width: 240px;
	}
	code {
		font-family: var(--font-mono, monospace);
		font-size: var(--fs-xs);
	}
	.inline-fields,
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
	.checkbox {
		display: inline-flex;
		grid-template-columns: auto 1fr;
		align-items: center;
	}
	.checkbox input {
		width: auto;
	}
	.template-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-2);
	}
	.template-card,
	.custom-template {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		padding: var(--space-3);
	}
	.template-card p {
		margin: var(--space-1) 0 0;
	}
	.custom-list {
		display: grid;
		gap: var(--space-2);
	}
	summary {
		cursor: pointer;
	}
	.custom-template summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.custom-template small {
		display: block;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.empty {
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
	}
	.refine-error {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-sm);
	}
	.archived {
		color: var(--text-muted);
	}
</style>
