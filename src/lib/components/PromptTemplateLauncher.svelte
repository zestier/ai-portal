<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import { createPromptTemplateDraftChat } from '$lib/client/prompt-template-launch';
	import type { PromptTemplateListItem } from '$lib/prompt-templates';

	type Variant = 'home' | 'sidebar' | 'rail';

	let {
		variant = 'sidebar',
		onNavigate,
		onError
	}: {
		variant?: Variant;
		onNavigate?: () => void;
		onError?: (message: string) => void;
	} = $props();

	let busy = $state(false);
	let pickerOpen = $state(false);
	let loadingTemplates = $state(false);
	let launchingTemplateId = $state<string | null>(null);
	let templates = $state<PromptTemplateListItem[] | null>(null);
	let localError = $state<string | null>(null);
	let dialogEl: HTMLDivElement | null = $state(null);

	const builtIns = $derived(templates?.filter((template) => template.source === 'builtin') ?? []);
	const customTemplates = $derived(
		templates?.filter((template) => template.source === 'custom') ?? []
	);

	function reportError(message: string) {
		if (onError) onError(message);
		else localError = message;
	}

	async function newBlankChat() {
		if (busy) return;
		busy = true;
		localError = null;
		try {
			const res = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'New chat' })
			});
			if (!res.ok) {
				reportError(`Could not create chat (${res.status})`);
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
		await loadTemplates();
		await tick();
		dialogEl?.focus();
	}

	function closePicker() {
		if (launchingTemplateId) return;
		pickerOpen = false;
	}

	async function launchTemplate(template: PromptTemplateListItem) {
		if (launchingTemplateId) return;
		launchingTemplateId = template.id;
		localError = null;
		try {
			const result = await createPromptTemplateDraftChat({ template, fetcher: fetch });
			if (!result.ok) {
				reportError(`Could not create chat (${result.status ?? 'network'})`);
				return;
			}
			await invalidateAll();
			onNavigate?.();
			await goto(result.href);
		} catch {
			reportError('Could not open prompt template');
		} finally {
			launchingTemplateId = null;
		}
	}

	function onDialogKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			closePicker();
			event.stopPropagation();
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
			onclick={newBlankChat}
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
			onclick={newBlankChat}
			disabled={busy}
		>
			{busy ? 'Creating...' : '+ New chat'}
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
	<div class="template-backdrop" role="presentation" onclick={closePicker}>
		<div
			bind:this={dialogEl}
			class="template-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="template-dialog-title"
			tabindex="-1"
			onclick={(event) => event.stopPropagation()}
			onkeydown={onDialogKeydown}
		>
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
								onclick={() => launchTemplate(template)}
								disabled={launchingTemplateId !== null}
							>
								<strong>{template.title}</strong>
								<span>{template.description}</span>
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
									onclick={() => launchTemplate(template)}
									disabled={launchingTemplateId !== null}
								>
									<strong>{template.title}</strong>
									<span>{template.description || 'Custom prompt template'}</span>
								</button>
							{/each}
						</div>
					{:else}
						<p class="empty muted">
							No custom templates yet. Built-in templates are always available.
						</p>
					{/if}
				</section>
			{/if}
		</div>
	</div>
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
	.template-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: var(--space-4);
		background: rgb(0 0 0 / 0.45);
	}
	.template-dialog {
		width: min(680px, 100%);
		max-height: min(760px, 90vh);
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow-2);
		padding: var(--space-4);
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
	.eyebrow {
		color: var(--text-muted);
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
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
	.empty {
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
	}
</style>
