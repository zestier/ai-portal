<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import {
		createPromptTemplateDraftChat,
		createPromptTemplateLaunchChat
	} from '$lib/client/prompt-template-launch';
	import type { PromptTemplateListItem, TemplateLaunchOptions } from '$lib/prompt-templates';
	import { templateLaunchDefaults, workspaceModeLabel } from '$lib/prompt-templates';
	import { PORTAL_TOOL_GROUPS } from '$lib/tools/groups';
	import Modal from './ui/Modal.svelte';
	import EmptyState from './ui/EmptyState.svelte';
	import LaunchReviewDialog from './LaunchReviewDialog.svelte';

	type Variant = 'home' | 'sidebar' | 'rail';

	let {
		variant = 'sidebar',
		onNavigate,
		onError
	}: {
		variant?: Variant;
		onNavigate?: (() => void) | undefined;
		onError?: ((message: string) => void) | undefined;
	} = $props();

	let busy = $state(false);
	let pickerOpen = $state(false);
	let loadingTemplates = $state(false);
	let launchingTemplateId = $state<string | null>(null);
	let launchController: AbortController | null = null;
	let templates = $state<PromptTemplateListItem[] | null>(null);
	let localError = $state<string | null>(null);
	let launchError = $state<string | null>(null);
	// Template awaiting a `review` launch, with the values seeding the dialog.
	let reviewing = $state<PromptTemplateListItem | null>(null);

	const builtIns = $derived(templates?.filter((template) => template.source === 'builtin') ?? []);
	const customTemplates = $derived(
		templates?.filter((template) => template.source === 'custom') ?? []
	);

	function reportError(message: string) {
		if (onError) onError(message);
		else localError = message;
	}

	// Short "Git, Tickets off" summary for a template's disabled tool groups, or
	// null when the template disables nothing (so we render no clutter).
	function disabledGroupsSummary(template: PromptTemplateListItem): string | null {
		const disabled = template.disabledToolGroups ?? [];
		if (disabled.length === 0) return null;
		const labels = PORTAL_TOOL_GROUPS.filter((g) => disabled.includes(g.id)).map((g) => g.label);
		return `${labels.join(', ')} off`;
	}

	async function newBlankChat(kind: 'shared' | 'worktree' = 'shared') {
		if (busy) return;
		busy = true;
		localError = null;
		try {
			const res = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'New chat',
					...(kind === 'worktree' ? { workspace: { kind: 'worktree' } } : {})
				})
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
				const message = typeof body?.message === 'string' ? body.message.trim() : '';
				reportError(
					message ? `Could not create chat: ${message}` : `Could not create chat (${res.status})`
				);
				return;
			}
			const body = await res.json();
			await invalidateAll();
			onNavigate?.();
			await goto(`/conversations/${body.conversation.id}`);
		} catch {
			reportError('Could not create chat');
		} finally {
			busy = false;
		}
	}

	async function loadTemplates() {
		if (templates || loadingTemplates) return;
		loadingTemplates = true;
		localError = null;
		try {
			const res = await fetch('/api/prompt-templates');
			if (!res.ok) {
				reportError(`Could not load prompt templates (${res.status})`);
				return;
			}
			const body = await res.json();
			templates = body.templates ?? [];
		} catch {
			reportError('Could not load prompt templates');
		} finally {
			loadingTemplates = false;
		}
	}

	async function openPicker() {
		pickerOpen = true;
		launchError = null;
		await loadTemplates();
	}

	function closePicker() {
		if (launchController) {
			launchController.abort();
			launchController = null;
		}
		reviewing = null;
		launchingTemplateId = null;
		launchError = null;
		pickerOpen = false;
	}

	/**
	 * Entry point for the template cards. `review` templates open the review
	 * dialog first; everything else launches straight away with the template's
	 * own settings.
	 */
	function startLaunch(template: PromptTemplateListItem) {
		if (launchingTemplateId) return;
		launchError = null;
		if (template.launchBehavior === 'review') {
			reviewing = template;
			return;
		}
		void launchTemplate(template, templateLaunchDefaults(template, template.prompt));
	}

	async function launchTemplate(template: PromptTemplateListItem, options: TemplateLaunchOptions) {
		if (launchingTemplateId) return;
		launchingTemplateId = template.id;
		launchError = null;
		const controller = new AbortController();
		launchController = controller;
		try {
			// `send` (and a confirmed `review`) posts the prompt as the first turn;
			// `draft` only pre-fills the composer.
			const result =
				template.launchBehavior === 'draft'
					? await createPromptTemplateDraftChat({
							template,
							fetcher: fetch,
							signal: controller.signal,
							options
						})
					: await createPromptTemplateLaunchChat({
							template,
							options,
							fetcher: fetch,
							signal: controller.signal
						});
			if (controller.signal.aborted) return;
			if (!result.ok) {
				launchError =
					'stage' in result && result.stage === 'launch'
						? `Could not launch chat (${result.status ?? 'network'})`
						: `Could not create chat (${result.status ?? 'network'})`;
				return;
			}
			reviewing = null;
			await invalidateAll();
			onNavigate?.();
			pickerOpen = false;
			await goto(result.href);
		} catch (err) {
			if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
				return;
			}
			launchError = 'Could not open prompt template';
		} finally {
			if (launchController === controller) launchController = null;
			if (launchingTemplateId === template.id) launchingTemplateId = null;
		}
	}
</script>

{#if variant === 'rail'}
	<div class="launcher rail-actions">
		<button
			type="button"
			class="rail-btn"
			title="New blank chat"
			aria-label="New blank chat"
			onclick={() => newBlankChat()}
			disabled={busy}
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
				<path d="M3.5 11.5l-1 2 2-1 6.5-6.5a1.06 1.06 0 0 0-1.5-1.5L3 11" />
				<path d="M9 4.5l2 2" />
				<path d="M11 11.5h3" />
				<path d="M12.5 10v3" />
			</svg>
		</button>
		<button
			type="button"
			class="rail-btn"
			title="New chat from template"
			aria-label="New chat from template"
			onclick={openPicker}
			disabled={loadingTemplates}
		>
			<span aria-hidden="true">T</span>
		</button>
	</div>
{:else}
	<div class="launcher" class:home={variant === 'home'}>
		<button
			type="button"
			class="btn primary"
			class:block={variant === 'sidebar'}
			onclick={() => newBlankChat()}
			disabled={busy}
		>
			{busy ? 'Creating...' : 'New shared chat'}
		</button>
		<button
			type="button"
			class="btn secondary"
			class:block={variant === 'sidebar'}
			onclick={() => newBlankChat('worktree')}
			disabled={busy}
			title="Create an isolated Git worktree"
		>
			New worktree chat
		</button>
		<button
			type="button"
			class="btn secondary"
			class:block={variant === 'sidebar'}
			onclick={openPicker}
			disabled={loadingTemplates}
		>
			{loadingTemplates ? 'Loading templates...' : 'Use template'}
		</button>
	</div>
{/if}

{#if localError}
	<p class="launcher-error" role="alert">{localError}</p>
{/if}

{#if pickerOpen}
	<Modal open onClose={closePicker} labelledby="template-dialog-title">
		<header>
			<div>
				<p class="eyebrow">New chat</p>
				<h2 id="template-dialog-title">Start from a prompt template</h2>
			</div>
			<button class="btn icon ghost sm" type="button" aria-label="Close" onclick={closePicker}
				>×</button
			>
		</header>
		<p class="muted small">
			Pick a reusable prompt to prefill the composer. You can edit it before sending.
		</p>

		{#if launchError}
			<p class="launcher-error" role="alert">{launchError}</p>
		{/if}

		{#if loadingTemplates}
			<p class="muted">Loading templates...</p>
		{:else if templates}
			<section aria-labelledby="built-in-template-heading">
				<h3 id="built-in-template-heading">Built-in templates</h3>
				<div class="template-list">
					{#each builtIns as template (template.id)}
						<button
							type="button"
							class="template-card"
							onclick={() => startLaunch(template)}
							disabled={launchingTemplateId !== null}
						>
							<strong>{template.title}</strong>
							<span>{template.description}</span>
							{#if workspaceModeLabel(template)}
								<span class="tool-groups-tag">{workspaceModeLabel(template)}</span>
							{/if}
						</button>
					{/each}
				</div>
			</section>

			<section aria-labelledby="custom-template-heading">
				<div class="section-row">
					<h3 id="custom-template-heading">Your templates</h3>
					<a href="/settings?tab=prompts">Manage</a>
				</div>
				{#if customTemplates.length > 0}
					<div class="template-list">
						{#each customTemplates as template (template.id)}
							<button
								type="button"
								class="template-card"
								onclick={() => startLaunch(template)}
								disabled={launchingTemplateId !== null}
							>
								<strong>{template.title}</strong>
								<span>{template.description || 'Custom prompt template'}</span>
								{#if disabledGroupsSummary(template)}
									<span class="tool-groups-tag">{disabledGroupsSummary(template)}</span>
								{/if}
								{#if workspaceModeLabel(template)}
									<span class="tool-groups-tag">{workspaceModeLabel(template)}</span>
								{/if}
							</button>
						{/each}
					</div>
				{:else}
					<EmptyState
						size="sm"
						description="No custom templates yet. Built-in templates are always available."
					/>
				{/if}
			</section>
		{/if}
	</Modal>
{/if}

{#if reviewing}
	<LaunchReviewDialog
		open
		templateTitle={reviewing.title}
		defaults={templateLaunchDefaults(reviewing, reviewing.prompt)}
		busy={launchingTemplateId !== null}
		error={launchError}
		onLaunch={(options) => {
			const template = reviewing;
			if (template) void launchTemplate(template, options);
		}}
		onCancel={() => {
			reviewing = null;
			launchError = null;
		}}
	/>
{/if}

<style>
	.launcher {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.launcher.home {
		justify-content: center;
		flex-wrap: wrap;
	}
	.launcher:not(.home) {
		flex-direction: column;
	}
	.block {
		display: flex;
		width: 100%;
	}
	.rail-actions {
		gap: var(--space-1);
	}
	.rail-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-md);
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		text-decoration: none;
		transition:
			background 0.12s ease,
			color 0.12s ease;
	}
	.rail-btn:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.rail-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.launcher-error {
		max-width: 18rem;
		margin: var(--space-2) 0 0;
		color: var(--danger);
		font-size: var(--fs-sm);
	}
	header,
	.section-row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		align-items: flex-start;
	}
	h2,
	h3,
	.eyebrow {
		margin: 0;
	}
	h3 {
		margin-top: var(--space-4);
		margin-bottom: var(--space-2);
		font-size: var(--fs-md);
	}
	.template-list {
		display: grid;
		gap: var(--space-2);
	}
	.template-card {
		display: grid;
		gap: 0.25rem;
		width: 100%;
		text-align: left;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		color: var(--text);
		padding: var(--space-3);
		cursor: pointer;
		font: inherit;
	}
	.template-card:hover:not(:disabled) {
		border-color: var(--accent);
		background: var(--surface-hover);
	}
	.template-card span {
		color: var(--text-muted);
		font-size: var(--fs-sm);
	}
	.tool-groups-tag {
		color: var(--text-muted);
		font-size: var(--fs-xs);
		font-variant: all-small-caps;
		letter-spacing: 0.04em;
		opacity: 0.85;
	}
</style>
