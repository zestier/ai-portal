<script lang="ts">
	// Terminal-style output pane. Used both for the live `partialOutput`
	// stream while a tool is running and for the final `terminal` content
	// block returned by tools like bash.
	import { renderTerminal } from '$lib/client/terminal-render';
	import { trimOneTrailingNewline, writeClipboard } from '$lib/client/copy-helper';
	import { onDestroy } from 'svelte';

	let {
		text,
		cwd,
		exitCode,
		command,
		streaming = false
	}: {
		text: string;
		cwd?: string | undefined;
		exitCode?: number | undefined;
		command?: string | undefined;
		streaming?: boolean;
	} = $props();

	const rendered = $derived(renderTerminal(text));
	const hasHeader = $derived(cwd != null || exitCode != null);

	// Copy OUTPUT ONLY: the ANSI-stripped terminal text, excluding the cwd/exit
	// header and the leading `$ command` prompt line.
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyOutput() {
		const ok = await writeClipboard(trimOneTrailingNewline(rendered));
		copyState = ok ? 'copied' : 'failed';
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copyState = 'idle'), 1500);
	}

	onDestroy(() => clearTimeout(copyTimer));
</script>

<div class="terminal-block" class:streaming>
	{#if hasHeader}
		<div class="header">
			{#if cwd}<code class="cwd" title={cwd}>{cwd}</code>{/if}
			{#if exitCode != null}
				<span class="exit-code" data-ok={exitCode === 0}>exit {exitCode}</span>
			{/if}
		</div>
	{/if}
	<div class="body-wrap">
		<pre class="body">{#if command}<span class="prompt">$ </span><span class="command"
					>{command}</span
				>{#if rendered}{'\n'}{/if}{/if}<code>{rendered}</code>{#if streaming}<span
					class="cursor"
					aria-hidden="true">▍</span
				>{/if}</pre>
		{#if copyState === 'failed'}<span class="copy-status">Copy failed</span>{/if}
		<button
			type="button"
			class="copy-btn"
			data-state={copyState}
			aria-label={copyState === 'copied' ? 'Copied' : 'Copy code'}
			onclick={copyOutput}
		>
			{#if copyState === 'copied'}
				<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path
						d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0L2.72 8.03a.75.75 0 0 1 1.06-1.06L7 10.19l5.72-5.97a.75.75 0 0 1 1.06 0z"
					/>
				</svg>
			{:else}
				<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path
						d="M10 1H4a1 1 0 0 0-1 1v8h1.5V2.5h5.5V1zM12 4H7a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zm-.5 9.5h-4v-8h4v8z"
					/>
				</svg>
			{/if}
		</button>
		<span class="copy-live" aria-live="polite"
			>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : ''}</span
		>
	</div>
</div>

<style>
	.terminal-block {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--bg);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.25rem 0.55rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-xs);
		font-family: var(--mono);
		color: var(--text-muted);
	}
	.cwd {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.exit-code {
		padding: 0.05rem 0.4rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 22%, transparent);
		color: var(--danger);
		font-family: var(--mono);
	}
	.exit-code[data-ok='true'] {
		background: color-mix(in srgb, var(--success) 22%, transparent);
		color: var(--success);
	}
	.body {
		font-family: var(--mono);
		font-size: var(--fs-md);
		line-height: 1.45;
		padding: 0.5rem 0.6rem;
		background: var(--bg);
		color: var(--text);
		overflow-x: auto;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 28em;
		margin: 0;
	}
	.body-wrap {
		position: relative;
	}
	.copy-btn {
		position: absolute;
		top: var(--space-2);
		right: var(--space-2);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 0.12s ease,
			color 0.12s ease,
			background 0.12s ease;
		z-index: 2;
	}
	.copy-btn :global(svg) {
		display: block;
	}
	.body-wrap:hover .copy-btn,
	.body-wrap:focus-within .copy-btn,
	.copy-btn:focus-visible {
		opacity: 1;
	}
	.copy-btn:hover {
		color: var(--text);
		background: var(--surface);
	}
	.copy-btn:focus-visible {
		outline: var(--focus-ring);
	}
	.copy-btn[data-state='copied'] {
		color: var(--success);
		opacity: 1;
	}
	.copy-btn[data-state='failed'] {
		color: var(--danger);
		opacity: 1;
	}
	.copy-status {
		position: absolute;
		top: var(--space-2);
		right: calc(var(--space-2) + 30px);
		font-size: var(--fs-xs);
		color: var(--danger);
		background: var(--surface-2);
		border: 1px solid var(--border);
		padding: 2px 6px;
		border-radius: var(--radius-sm);
		pointer-events: none;
		z-index: 2;
	}
	.copy-live {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}
	.cursor {
		display: inline-block;
		color: var(--accent);
		animation: cursor-blink 1s steps(2, start) infinite;
	}
	.prompt {
		color: var(--accent);
		user-select: none;
	}
	.command {
		color: var(--text);
		font-weight: 600;
	}
	@keyframes cursor-blink {
		to {
			visibility: hidden;
		}
	}
</style>
